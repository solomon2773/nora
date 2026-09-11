// @ts-nocheck
// workers/provisioner/logs/logCollector.ts — Phase 4 of the logging control
// plane: maintains one live follow stream per running agent, feeds it
// through Phase 2's shared line parser into Phase 3's segment writer, and
// survives restarts, reconnects, and workspace reassignment.
//
// Depends on:
//   - agent-runtime/lib/logLine.ts (Phase 2)          — parseContainerLogChunk
//   - workers/provisioner/logs/segmentWriter.ts (Phase 3) — append/isCapacityPaused
//   - backend-api/containerManager.ts's logs()         — backend-agnostic follow stream
//
// Read the implementation plan's Phase 4 "Changes required" and "Rationale &
// tradeoffs" before changing the reconcile/attach/reattach timing below —
// several choices here look arbitrary in isolation but are load-bearing for
// the crash-replay and capacity-halt guarantees this module promises.
//
// ── Design note: level-triggered, not event-driven (item 1) ─────────────
//
// `reconcileStreams()` re-derives the desired stream set from scratch every
// tick by querying `agents` directly, then diffs it against whatever streams
// this process currently holds. It does NOT react to individual "agent
// started"/"agent stopped" events. Agents restart outside Nora's control —
// Docker's `unless-stopped` policy, Kubernetes rescheduling, a plain crash —
// so an event-driven design would need to catch every one of those paths
// correctly to never leak or starve a stream. A reconciler that just diffs
// against reality converges regardless of what it missed.
//
// ── Design note: cursor-advances-only-after-flush (item 2a) ──────────────
//
// `attachAgentStream` reads `since` from `log_segments` — specifically
// `MAX(ts_to)` for `(agent_id, stream)` — never from "the last line this
// collector happened to see." A `log_segments` row only exists after a
// successful flush (Phase 3 item 14: object written, then the index row),
// so this is exactly "the last durably-flushed point," matching Phase 3's
// `6a` design decision. This is what turns an ungraceful worker death into
// bounded replay instead of data loss: on restart, a fresh collector
// resolves the same cursor from Postgres and the source (Docker's
// `json-file` driver, or the kubelet) replays the intervening lines, which
// `buildStorageKey`'s window-derived key upserts idempotently rather than
// duplicating.
//
// One accepted consequence of this design, stated plainly because Phase 4's
// own test list calls it out explicitly: a *live* reconnect (the stream
// merely ends and reattaches, with the in-memory buffer still open and
// un-flushed — not a worker crash) will re-replay whatever lines are still
// sitting in that open buffer, because `since` only ever advances at a
// flush boundary, never per line. This is intentional, not an oversight —
// see Phase 3 item 2a and Phase 4 item 2a: tracking "last line seen"
// in-memory instead would reintroduce exactly the un-flushed-loss failure
// mode this design exists to avoid, in exchange for occasionally duplicating
// a handful of lines across a transient reconnect.

const { createLogChunkStreamParser } = require("../../../agent-runtime/lib/logLine.ts");
const {
  resolveAgentBackendType,
} = require("../../../agent-runtime/lib/agentRuntimeFields.ts");

const RUNTIME_STREAM = "runtime";
const DEFAULT_RECONCILE_INTERVAL_MS = 30000;

/**
 * Resolve the tenant (workspace or owning user) for an agent via a single
 * `workspace_agents` lookup, falling back to `agents.user_id` when the
 * agent belongs to no workspace (`agents.user_id` is always populated —
 * Phase 3's `buildStorageKey` depends on that). Called once per attach —
 * see the module-level note on why this must never run per line.
 *
 * @param {string} agentId
 * @param {{ db: Object }} deps
 * @returns {Promise<{kind: "workspace"|"user", id: string|null,
 *   workspaceId: string|null, ownerUserId: string|null}>}
 */
async function resolveTenantForAgent(agentId, { db } = {}) {
  const membership = await db.query(
    `SELECT workspace_id FROM workspace_agents WHERE agent_id = $1 LIMIT 1`,
    [agentId],
  );
  const workspaceId = membership.rows[0]?.workspace_id || null;
  if (workspaceId) {
    return { kind: "workspace", id: workspaceId, workspaceId, ownerUserId: null };
  }
  const ownerResult = await db.query(`SELECT user_id FROM agents WHERE id = $1`, [agentId]);
  const ownerUserId = ownerResult.rows[0]?.user_id || null;
  return { kind: "user", id: ownerUserId, workspaceId: null, ownerUserId };
}

/**
 * The last durably-flushed cursor for `(agentId, stream)` — `MAX(ts_to)`
 * over `log_segments`, since a row only exists there after Phase 3's writer
 * successfully flushed (item 2a's contract). Returns `null` when no segment
 * has ever been flushed for this agent/stream, in which case the caller
 * omits `since` entirely (source-default behavior, i.e. whatever the
 * backend returns for a brand-new attach).
 */
async function lastFlushedCursor(agentId, stream, { db } = {}) {
  const result = await db.query(
    `SELECT MAX(ts_to) AS cursor FROM log_segments WHERE agent_id = $1 AND stream = $2`,
    [agentId, stream],
  );
  const cursor = result.rows[0]?.cursor;
  return cursor ? new Date(cursor).toISOString() : null;
}

/**
 * @param {Object} [deps]
 * @param {Object} [deps.db] - pg-like `{ query(sql, params) }`.
 * @param {Object} [deps.containerManager] - exposes `logs(agent, opts)`.
 * @param {Object} [deps.segmentWriter] - Phase 3's writer: `append`,
 *   `isCapacityPaused`.
 * @param {Function} [deps.logStorageConfig] - resolves `{ storageBackend }`;
 *   defaults to logStorageConfig.ts's `logStorageConfig()`.
 * @param {Function} [deps.resolveAgentBackendType] - defaults to the shared
 *   agent-runtime helper; overridable for tests.
 * @param {Function} [deps.createLogChunkStreamParser] - defaults to Phase 2's
 *   shared stateful stream parser; overridable for tests.
 * @param {number} [deps.reconcileIntervalMs]
 * @param {Function} [deps.setIntervalFn] / {Function} [deps.clearIntervalFn]
 *   - injectable timer functions for deterministic tests.
 * @param {Console} [deps.logger]
 * @returns {{ start: Function, stop: Function, stopReconciler: Function,
 *   stopCollector: Function, reconcileStreams: Function,
 *   attachAgentStream: Function, resolveTenantForAgent: Function,
 *   heldStreamCount: Function }}
 */
function createLogCollector(deps = {}) {
  const db = deps.db || require("../../../backend-api/db.ts");
  const containerManager = deps.containerManager || require("../../../backend-api/containerManager.ts");
  const segmentWriter = deps.segmentWriter;
  const resolveStorageConfig =
    deps.logStorageConfig || require("./logStorageConfig.ts").logStorageConfig;
  const resolveBackendType = deps.resolveAgentBackendType || resolveAgentBackendType;
  const makeChunkParser = deps.createLogChunkStreamParser || createLogChunkStreamParser;
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const logger = deps.logger || console;

  if (!segmentWriter) {
    throw new Error("createLogCollector requires deps.segmentWriter");
  }

  /** @type {Map<string, {stream: Object, dead: boolean, tenant: Object}>} */
  const streams = new Map();
  // Item 3a: track which agents have already been warned about, so the
  // storage_unsupported_for_target skip is silent after the first tick per
  // agent rather than logging every 30s forever. This is a deliberate,
  // documented deviation from a persisted capability-reason column: no
  // existing "capability reason" pattern was found elsewhere in this
  // codebase to follow (grepped for capability_reason/capabilityReason —
  // no hits), and the plan explicitly allows an in-memory/log-only marker
  // as a minimal acceptable substitute pending a real UI-facing surface.
  const skippedForStorageTarget = new Set();
  let stopped = false;
  let timer = null;

  function detach(agentId) {
    const held = streams.get(agentId);
    if (!held) return;
    try {
      if (held.stream && typeof held.stream.destroy === "function") {
        held.stream.destroy();
      }
    } catch (error) {
      logger.warn(
        `[logCollector] error destroying log stream for agent ${agentId}: ${error.message}`,
      );
    }
    streams.delete(agentId);
  }

  /**
   * Attach a live follow stream for `agent`. Resolves the tenant and the
   * last-flushed cursor once, then pipes parsed chunks into the segment
   * writer for the life of this attach. Returns the held-stream record, or
   * `null` when there is nothing to hold this tick (item 3: `null` from
   * `containerManager.logs()` — no Running pod, no container — is a normal,
   * expected outcome here, not an error to throw or retry-storm on).
   */
  async function attachAgentStream(agent) {
    if (stopped) return null;
    const agentId = agent.id;

    // Item 5: resolved once per attach, cached on `held.tenant` for the
    // life of this attach, and re-resolved on every subsequent reconnect —
    // never per line.
    const tenant = await resolveTenantForAgent(agentId, { db });
    const since = await lastFlushedCursor(agentId, RUNTIME_STREAM, { db });

    const logOpts = { follow: true };
    if (since) logOpts.since = since;
    // Deliberately no `tail` key here — see docker.ts/k8s.ts's Phase 4 item
    // 2b fix: an absent `tail` now means "all available lines" from both
    // adapters, which is what makes a reattach replay the source's full
    // retained backlog from `since` forward instead of re-ingesting only
    // the last 100 lines on every reconnect.

    let rawStream;
    try {
      rawStream = await containerManager.logs(agent, logOpts);
    } catch (error) {
      logger.warn(`[logCollector] attach failed for agent ${agentId}: ${error.message}`);
      return null;
    }
    if (!rawStream) {
      // Item 3: normal for the base adapter and for Kubernetes when no pod
      // is currently Running. No stream held this tick; the next reconcile
      // tick tries again.
      return null;
    }

    const held = { stream: rawStream, dead: false, tenant };

    // One stateful parser per attach — never per chunk. A `data` chunk from
    // a live follow stream lands at an arbitrary byte offset, so parsing
    // each chunk independently (the stateless `parseContainerLogChunk`) can
    // split a multi-byte character or a Docker frame header across two
    // chunks and corrupt whichever byte(s) straddled the split (surfacing
    // as a stray `�` in a persisted line). The stateful parser carries that
    // partial state across chunks instead.
    const chunkParser = makeChunkParser({ stream: RUNTIME_STREAM });

    function appendLines(lines) {
      if (!lines || lines.length === 0) return;
      Promise.resolve(
        segmentWriter.append(
          {
            agentId,
            stream: RUNTIME_STREAM,
            workspaceId: held.tenant.workspaceId,
            ownerUserId: held.tenant.ownerUserId,
          },
          lines,
        ),
      ).catch((error) => {
        logger.error(`[logCollector] segmentWriter.append failed for agent ${agentId}: ${error.message}`);
      });
    }

    rawStream.on("data", (chunk) => {
      if (held.dead) return;
      let lines;
      try {
        lines = chunkParser.push(chunk);
      } catch (error) {
        logger.warn(
          `[logCollector] failed to parse a log chunk for agent ${agentId}: ${error.message}`,
        );
        return;
      }
      appendLines(lines);
    });

    // Item 4: end/error mark the stream dead so the NEXT reconcile tick
    // reattaches it — this is what turns a one-shot stream lifecycle into
    // real reconnect behavior. Deliberately does NOT flush Phase 3's
    // segment buffer here: it stays open across a stream end, and a
    // subsequent reattach resumes appending to the same buffer (bufferKey
    // is (agentId, stream), independent of any particular attach). This IS
    // where the chunk parser's own `flush()` belongs, though — unrelated to
    // the segment buffer — since a final line with no trailing newline
    // would otherwise sit forever in this attach's now-discarded parser
    // instance instead of ever reaching the segment buffer.
    rawStream.on("end", () => {
      held.dead = true;
      try {
        appendLines(chunkParser.flush());
      } catch (error) {
        logger.warn(
          `[logCollector] failed to flush trailing log data for agent ${agentId}: ${error.message}`,
        );
      }
    });
    rawStream.on("error", (error) => {
      held.dead = true;
      logger.warn(`[logCollector] log stream error for agent ${agentId}: ${error.message}`);
    });

    streams.set(agentId, held);
    return held;
  }

  /**
   * The 30s level-triggered diff (item 1). Re-derives the desired stream
   * set from `agents` on every call, excludes agents this installation
   * cannot or should not collect from right now (item 3a's storage/target
   * mismatch, item 7's capacity-paused streams), then attaches whatever is
   * desired-but-not-held (including anything marked `dead` by a prior
   * end/error) and detaches whatever is held-but-no-longer-desired.
   */
  async function reconcileStreams() {
    if (stopped) return;

    const result = await db.query(
      `SELECT id, user_id, container_id, status, backend_type, deploy_target,
              execution_target_id, runtime_family, sandbox_profile
         FROM agents
        WHERE status IN ('running', 'warning') AND container_id IS NOT NULL`,
    );
    const rows = result.rows || [];

    let storageBackend = "local";
    try {
      const config = await resolveStorageConfig();
      storageBackend = config?.storageBackend || "local";
    } catch (error) {
      // Best-effort: if the destination can't be resolved this tick, assume
      // `local` (the conservative choice — it's the one combination that
      // requires excluding k8s agents) rather than let a transient config
      // error crash the reconciler.
      logger.warn(
        `[logCollector] could not resolve log storage config, assuming "local" this tick: ${error.message}`,
      );
    }
    const isLocalDriver = storageBackend === "local";

    const desired = new Map();
    for (const agent of rows) {
      const backendType = resolveBackendType(agent);

      // Item 3a: local storage + Kubernetes agents is an unsupported
      // combination (Design Decision 2d). Exclude from the desired set
      // rather than attach-then-fail-every-write; warn once per agent, not
      // once per tick.
      if (isLocalDriver && backendType === "k8s") {
        if (!skippedForStorageTarget.has(agent.id)) {
          skippedForStorageTarget.add(agent.id);
          logger.warn(
            `[logCollector] agent ${agent.id} skipped: storage_unsupported_for_target ` +
              `(Kubernetes agents are not log-collected while the local log storage driver is active)`,
          );
        }
        continue;
      }
      skippedForStorageTarget.delete(agent.id);

      // Item 7: a capacity-paused stream is excluded from the desired set,
      // so the diff below detaches it if currently held rather than
      // continuing to buffer against a source the writer has stopped
      // accepting flushes for. When capacity clears, this same check
      // naturally re-admits the agent on a later tick — no separate
      // "resume" path needed.
      if (
        typeof segmentWriter.isCapacityPaused === "function" &&
        segmentWriter.isCapacityPaused(agent.id, RUNTIME_STREAM)
      ) {
        continue;
      }

      desired.set(agent.id, agent);
    }

    for (const agentId of Array.from(streams.keys())) {
      if (!desired.has(agentId)) detach(agentId);
    }

    for (const [agentId, agent] of desired) {
      const held = streams.get(agentId);
      if (held && !held.dead) continue; // already live, nothing to do
      if (held && held.dead) detach(agentId); // clear the dead entry first
      await attachAgentStream(agent);
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setIntervalFn(() => {
      reconcileStreams().catch((error) => {
        logger.error(`[logCollector] reconcile tick failed: ${error.message}`);
      });
    }, reconcileIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * Shutdown-coordinator hook (item 6): stop the reconcile timer and stop
   * accepting new attaches. Does NOT touch already-held streams — that is
   * `stopCollector`'s job — matching the shutdown coordinator's two-phase
   * call order (`stopReconciler()` then `stopCollector()`; see worker.ts's
   * `registerShutdownCoordinator`).
   */
  function stopReconciler() {
    stopped = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  /**
   * Shutdown-coordinator hook (item 6): disconnect every currently-held
   * follow stream. Deliberately does not touch the segment writer's
   * buffers or call `flush`/`flushAll` — that remains the shutdown
   * coordinator's own direct responsibility against the writer instance,
   * per Phase 3 item 6's `flushAll()` step. This only stops pulling new
   * bytes from sources so `flushAll()` can run against a stable buffer set.
   */
  function stopCollector() {
    for (const agentId of Array.from(streams.keys())) detach(agentId);
  }

  function stop() {
    stopReconciler();
    stopCollector();
  }

  function heldStreamCount() {
    return streams.size;
  }

  return {
    start,
    stop,
    stopReconciler,
    stopCollector,
    reconcileStreams,
    attachAgentStream,
    resolveTenantForAgent: (agentId) => resolveTenantForAgent(agentId, { db }),
    heldStreamCount,
  };
}

/**
 * Convenience entry point: build a collector and start its 30s reconcile
 * timer immediately. Returns the same handle `createLogCollector` does
 * (which is a superset of the `{ stop() }` the shutdown coordinator needs —
 * see worker.ts's `registerLogPipelineHooks({ stopCollector, stopReconciler })`).
 */
function startLogCollector(deps = {}) {
  const collector = createLogCollector(deps);
  collector.start();
  return collector;
}

module.exports = {
  createLogCollector,
  startLogCollector,
  resolveTenantForAgent,
  lastFlushedCursor,
  RUNTIME_STREAM,
  DEFAULT_RECONCILE_INTERVAL_MS,
};
