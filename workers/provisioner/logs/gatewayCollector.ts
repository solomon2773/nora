// @ts-nocheck
// workers/provisioner/logs/gatewayCollector.ts — Phase 10 of the logging
// control plane: polls OpenClaw's `logs.tail` gateway RPC per agent and
// writes `gateway`-stream segments (as opposed to Phase 4's `runtime`-stream
// segments, sourced from container stdout/stderr) through the exact same
// segment-writer infrastructure Phase 3/4 already built.
//
// Depends on:
//   - agent-runtime/lib/gatewayRpc.ts (Phase 9)      — createGatewayClient, callLogsTail
//   - agent-runtime/lib/logLine.ts (Phase 2)          — normalizeGatewayLogLine
//   - agent-runtime/lib/agentRuntimeFields.ts          — resolveAgentRuntimeFamily
//   - agent-runtime/lib/runtimeBootstrap.ts            — buildOpenClawConfigMergeCommand
//   - workers/provisioner/logs/segmentWriter.ts (Phase 3) — append
//   - workers/provisioner/logs/retentionSweeper.ts (Phase 5) — resolveLogRetention
//   - workers/provisioner/logs/logCollector.ts (Phase 4) — resolveTenantForAgent (shared)
//   - workers/provisioner/logs/redaction.ts (this phase) — redactLine
//   - backend-api/db_schema.sql `agent_log_cursors` / `workspace_log_settings` (Phase 1)
//
// ── Design note: why a real persisted cursor table, unlike Phase 4 ───────
//
// Phase 4's container collector never explicitly saves a cursor — it derives
// one on every (re)attach from `MAX(ts_to)` over `log_segments`, because a
// container log source is queried `since <timestamp>`. OpenClaw's
// `logs.tail` RPC instead hands back an opaque `cursor` token with each
// response (see gatewayRpc.ts's `callLogsTail`); there is no timestamp to
// derive it from after the fact, so it must be persisted directly —
// `agent_log_cursors` (Phase 1) exists for exactly this. See the module's
// `saveCursor`/`loadCursor` and the "cursor-advances-only-after-flush" note
// on `pollAgentGatewayLogs` below for how this stays crash-safe.
//
// ── Design note: per-source-kind cursors ─────────────────────────────────
//
// `agent_log_cursors` is keyed on `(agent_id, source_kind)`, not just
// `agent_id`, because OpenClaw's log source is not one globally monotonic
// stream: it emits `{"type":"meta"}` JSONL records on source transitions
// (Phase 1's schema constrains `source_kind` to `'file' | 'journal'`), and
// log rotation at `logging.maxFileBytes` is one such transition. A single
// shared cursor value would be meaningless across a transition — resuming
// against the wrong source's token. See `pollAgentGatewayLogs`'s handling of
// meta records for how a transition mid-batch is processed without dropping
// any lines either side of it.
//
// ── Design note: adaptive poll interval ──────────────────────────────────
//
// OpenClaw's own CLI polls `logs.tail` every 1s for one interactive follow
// session. At installation scale (50 agents), naively doing that for every
// agent is 50 round-trips/second, almost all of them empty. Each agent's
// poll loop instead runs its own adaptive interval: `computeNextPollDelayMs`
// walks `POLL_BACKOFF_STEPS_MS` forward by one step per consecutive empty
// poll, and snaps immediately back to the fastest step the instant a poll
// returns anything. This is a pure function specifically so the adaptive
// behavior is unit-testable without any real timer.

const { createGatewayClient, callLogsTail } = require("../../../agent-runtime/lib/gatewayRpc.ts");
const { normalizeGatewayLogLine } = require("../../../agent-runtime/lib/logLine.ts");
const {
  resolveAgentRuntimeFamily,
} = require("../../../agent-runtime/lib/agentRuntimeFields.ts");
const { redactLine } = require("./redaction.ts");

const GATEWAY_STREAM = "gateway";
const DEFAULT_RECONCILE_INTERVAL_MS = 30000; // matches Phase 4's cadence deliberately

// Adaptive poll interval (item 4): fast while lines are flowing, backing off
// toward the slow end when idle, snapping straight back to the fast end the
// instant a poll returns anything.
const POLL_BACKOFF_STEPS_MS = [1000, 1500, 2500, 4000, 6000, 8000, 10000];

const DEFAULT_POLL_LIMIT = 500;
const DEFAULT_POLL_MAX_BYTES = 1_000_000;

const KNOWN_SOURCE_KINDS = ["file", "journal"];
const DEFAULT_SOURCE_KIND = "file";

/**
 * Pure adaptive-backoff step function (item 4 / test list: "the poll
 * interval backs off when idle ... and recovers immediately on the next
 * non-empty response").
 *
 * @param {number} stepIndex - current index into POLL_BACKOFF_STEPS_MS.
 * @param {boolean} gotLines - whether the just-completed poll returned any
 *   (pre-filter) records at all.
 * @returns {{ stepIndex: number, delayMs: number }}
 */
function computeNextPollStep(stepIndex, gotLines) {
  if (gotLines) {
    return { stepIndex: 0, delayMs: POLL_BACKOFF_STEPS_MS[0] };
  }
  const nextIndex = Math.min(stepIndex + 1, POLL_BACKOFF_STEPS_MS.length - 1);
  return { stepIndex: nextIndex, delayMs: POLL_BACKOFF_STEPS_MS[nextIndex] };
}

// ── Cursor persistence (function list: loadCursor / saveCursor) ─────────

/**
 * Load the persisted `logs.tail` cursor for `(agentId, sourceKind)`, or
 * `null` when none has ever been saved (a brand-new agent/source-kind pair —
 * the caller omits `cursor` entirely on the first poll, which is the RPC's
 * documented "start from whatever the gateway considers current" default).
 *
 * @param {string} agentId
 * @param {string} sourceKind - "file" | "journal"
 * @param {{ db: Object }} deps
 * @returns {Promise<string|null>}
 */
async function loadCursor(agentId, sourceKind, { db } = {}) {
  const result = await db.query(
    `SELECT cursor FROM agent_log_cursors WHERE agent_id = $1 AND source_kind = $2`,
    [agentId, sourceKind],
  );
  return result.rows[0]?.cursor ?? null;
}

/**
 * Persist the `logs.tail` cursor for `(agentId, sourceKind)`. Upserts on the
 * composite primary key. Called ONLY after the corresponding batch of lines
 * has been durably flushed by the segment writer (item 5b) — never merely
 * after it was received/parsed — so an ungraceful worker death loses
 * nothing durably flushed and, at worst, replays a bounded window on
 * restart rather than silently skipping a gap.
 *
 * @param {string} agentId
 * @param {string} sourceKind
 * @param {string|null} cursor
 * @param {{ db: Object }} deps
 * @returns {Promise<void>}
 */
async function saveCursor(agentId, sourceKind, cursor, { db } = {}) {
  await db.query(
    `INSERT INTO agent_log_cursors (agent_id, source_kind, cursor, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agent_id, source_kind) DO UPDATE SET
       cursor = EXCLUDED.cursor,
       updated_at = EXCLUDED.updated_at`,
    [agentId, sourceKind, cursor],
  );
}

// ── Gateway logs enabled (item 1) ─────────────────────────────────────

/**
 * Resolve whether gateway log collection is enabled for `tenant`, through
 * the same fallback-chain shape Phase 5's `resolveLogRetention` uses: the
 * workspace's `workspace_log_settings` row when one exists, the column's
 * platform default (`true`) otherwise. An agent with no workspace has no
 * `workspace_log_settings` row by design (Phase 1) and always resolves to
 * the default.
 *
 * @param {{ workspaceId: string|null }} tenant
 * @param {{ db: Object }} deps
 * @returns {Promise<boolean>}
 */
async function resolveGatewayLogsEnabled(tenant, { db } = {}) {
  if (!tenant || !tenant.workspaceId) return true;
  const result = await db.query(
    `SELECT gateway_logs_enabled FROM workspace_log_settings WHERE workspace_id = $1`,
    [tenant.workspaceId],
  );
  const row = result.rows[0];
  return row ? Boolean(row.gateway_logs_enabled) : true;
}

// ── consoleLevel:warn config sync (item 7) ────────────────────────────

/**
 * Push `{ logging: { consoleLevel: "warn" } }` into a running OpenClaw
 * agent's `/root/.openclaw/openclaw.json` via `buildOpenClawConfigMergeCommand`
 * (agent-runtime/lib/runtimeBootstrap.ts) — a deep-merge that takes effect
 * without a restart. This is what stops OpenClaw's own INFO+ console output
 * from being collected TWICE: once by Phase 4's container stdout/stderr
 * collector (the `runtime` stream) and once by this phase's `logs.tail` poll
 * (the `gateway` stream). Setting the gateway's own console sink down to
 * `warn` leaves this collector's structured `logs.tail` read as the sole
 * source of INFO-and-below detail.
 *
 * Applied both at provisioning time and, in `reconcileStreams` below, on
 * every 30s reconcile tick for every currently-eligible OpenClaw agent — see
 * that function's own comment for why an unconditional per-tick re-apply
 * (rather than a one-shot, first-seen-only apply) is what actually
 * "reconciles" a pre-existing agent's drifted config, not just a
 * newly-provisioned one.
 *
 * `runRuntimeCommand` is required lazily from `../worker.ts`, not at module
 * load time: `worker.ts` is what `require()`s this module to start the
 * collector, so a top-level require here would be a circular require that
 * resolves to a partially-initialized (i.e. still-empty) worker.ts exports
 * object. Resolving it lazily, inside the function body, means by the time
 * this ever actually runs, worker.ts has finished its own top-level
 * evaluation and `runRuntimeCommand` is a real function on its exports.
 *
 * @param {Object} agent - agent row carrying runtime/gateway host+port+token.
 * @param {Object} [deps]
 * @param {Function} [deps.runRuntimeCommand] - override for tests.
 * @param {Function} [deps.buildOpenClawConfigMergeCommand] - override for tests.
 * @returns {Promise<void>}
 */
async function applyConsoleLevelConfig(agent, deps = {}) {
  const runRuntimeCommand =
    deps.runRuntimeCommand || (() => require("../worker.ts").runRuntimeCommand)();
  const buildOpenClawConfigMergeCommand =
    deps.buildOpenClawConfigMergeCommand ||
    require("../../../agent-runtime/lib/runtimeBootstrap.ts").buildOpenClawConfigMergeCommand;

  const command = buildOpenClawConfigMergeCommand({ logging: { consoleLevel: "warn" } });
  await runRuntimeCommand(agent, command);
}

// ── Meta-record / source-transition splitting ────────────────────────

/**
 * Split one `logs.tail` response's raw records into contiguous runs by
 * `{"type":"meta"}` transition markers, so a source-kind transition (a meta
 * record, or the rotation it signals) occurring MID-BATCH doesn't drop
 * whatever lines arrived on either side of it (item 3 / test list: "log
 * rotation occurring mid-poll does not drop any lines").
 *
 * A meta record itself carries no message content and is never written as a
 * log line — it is consumed here purely as a boundary marker. A meta record
 * MAY carry its own `sourceKind` field (naming the kind the FOLLOWING run
 * belongs to); when it doesn't, the following run (and the final run, when
 * no meta record follows it) is attributed to `responseSourceKind` — the
 * `sourceKind` the RPC response reported for this poll as a whole.
 *
 * ASSUMPTION flagged for human review: the exact `{"type":"meta"}` record
 * shape (whether it always carries `sourceKind`, or any other field) is not
 * pinned down by a verified `logs.tail` contract — see gatewayRpc.ts's own
 * flagged assumption on same-millisecond line ordering, which this
 * inherits. This function degrades gracefully either way: even a meta
 * record with no `sourceKind` field still correctly delimits runs, it just
 * leaves attribution of the run after it to `responseSourceKind`.
 *
 * @param {Array<object>} records - raw JSONL records from one `logs.tail` response.
 * @param {string} currentSourceKind - the source kind in effect BEFORE this batch.
 * @param {string} responseSourceKind - the `sourceKind` the response reported.
 * @returns {Array<{ sourceKind: string, records: Array<object> }>}
 */
function splitRunsOnMetaRecords(records, currentSourceKind, responseSourceKind) {
  const runs = [];
  let currentRun = { sourceKind: currentSourceKind, records: [] };

  for (const record of records) {
    if (record && typeof record === "object" && record.type === "meta") {
      if (currentRun.records.length > 0) runs.push(currentRun);
      const nextKind =
        (typeof record.sourceKind === "string" && record.sourceKind) ||
        (typeof record.source_kind === "string" && record.source_kind) ||
        responseSourceKind ||
        currentRun.sourceKind;
      currentRun = { sourceKind: nextKind, records: [] };
      continue;
    }
    currentRun.records.push(record);
  }

  if (currentRun.records.length > 0 || runs.length === 0) {
    // The trailing (or, if no meta record ever appeared, the only) run is
    // attributed to whatever the response as a whole reported, when that
    // differs from whatever a meta record already set it to.
    currentRun.sourceKind = currentRun.sourceKind || responseSourceKind;
    runs.push(currentRun);
  }

  return runs;
}

// ── pollAgentGatewayLogs (function list) ──────────────────────────────

/**
 * Poll `logs.tail` once for `agent` and drain the result into the segment
 * writer under the `gateway` stream, advancing (and persisting) the
 * per-source-kind cursor only once the corresponding write has been durably
 * flushed.
 *
 * `cursorState` is a small piece of held, per-agent, in-process state (see
 * `createGatewayCollector`'s `agents` map) — NOT the source of truth for the
 * cursor (that's always `agent_log_cursors`, re-read via `loadCursor` for
 * any source kind this function hasn't already cached this process
 * lifetime). It exists so a long-idle agent doesn't re-query Postgres for
 * its cursor on every single poll when nothing has changed.
 *
 * ── cursor-advances-only-after-flush (item 5b) ────────────────────────
 *
 * Mirrors Phase 4 item 2a's rationale exactly, adapted to a persisted
 * (rather than derived) cursor: `segmentWriter.append()` only buffers lines
 * in memory — Phase 3's writer flushes on its own 15-minute timer or size
 * threshold, not synchronously on every append. If this function saved the
 * RPC's new cursor right after `append()` returned, a worker crash before
 * the NEXT scheduled flush would durably record "already consumed up to
 * cursor X" for lines that were never actually written anywhere — permanent,
 * silent data loss with no path to recover it (unlike Phase 4, where the
 * cursor is re-derived from `log_segments` on restart and therefore can
 * never get ahead of what was actually flushed).
 *
 * Since `logs.tail`'s cursor is an opaque token with no timestamp to
 * re-derive it from after the fact, this function instead calls
 * `segmentWriter.flush()` directly for the `(agentId, "gateway")` buffer
 * immediately after a non-empty append, and only calls `saveCursor()` once
 * that flush has resolved. This is a deliberate, documented divergence from
 * Phase 3's normal "batch for up to 15 minutes" cadence: the gateway stream
 * flushes roughly once per non-empty poll (which, thanks to the adaptive
 * interval, is itself throttled under sustained idle), trading some of
 * Phase 3's segment-size batching efficiency for a durable, gap-free cursor
 * without needing to read back already-written segment content to recover
 * it. See the module header for the full rationale.
 *
 * ── retention-cutoff filtering (item 5a) ──────────────────────────────
 *
 * Lines whose resolved timestamp (`ts` when parsed, `observed_ts` as
 * `normalizeGatewayLogLine`'s own fallback otherwise) is already older than
 * the workspace's resolved retention cutoff are dropped before ever being
 * handed to the segment writer — see `resolveLogRetention` (Phase 5). This
 * only matters after a long outage leaves a stale cursor; ordinary polling
 * never encounters lines this old. Dropped lines still count toward
 * advancing the cursor (they were successfully "handled", just intentionally
 * not written) so a stale backlog doesn't get reprocessed forever.
 *
 * @param {Object} agent - agent row (must resolve to OpenClaw; callers
 *   filter Hermes agents out before calling this).
 * @param {Object} cursorState - held per-agent state (see field docs above).
 * @param {Object} deps - `{ db, client, segmentWriter, tenant, now,
 *   pollLimit, pollMaxBytes, redactLine, normalizeGatewayLogLine,
 *   resolveLogRetention, logger }`.
 * @returns {Promise<{ gotRecords: boolean, appended: number, dropped: number }>}
 */
async function pollAgentGatewayLogs(agent, cursorState, deps = {}) {
  const db = deps.db;
  const client = deps.client || cursorState.client;
  const segmentWriter = deps.segmentWriter;
  const tenant = deps.tenant || cursorState.tenant;
  const now = deps.now || (() => new Date().toISOString());
  const pollLimit = deps.pollLimit ?? DEFAULT_POLL_LIMIT;
  const pollMaxBytes = deps.pollMaxBytes ?? DEFAULT_POLL_MAX_BYTES;
  const normalize = deps.normalizeGatewayLogLine || normalizeGatewayLogLine;
  const redact = deps.redactLine || redactLine;
  const resolveRetention =
    deps.resolveLogRetention || require("./retentionSweeper.ts").resolveLogRetention;
  const logger = deps.logger || console;
  const callTail = deps.callLogsTail || callLogsTail;

  const currentSourceKind = cursorState.currentSourceKind || DEFAULT_SOURCE_KIND;
  let cursor = cursorState.sourceCursors.get(currentSourceKind);
  if (cursor === undefined) {
    cursor = await loadCursor(agent.id, currentSourceKind, { db });
    cursorState.sourceCursors.set(currentSourceKind, cursor);
  }

  const response = await callTail(client, { cursor, limit: pollLimit, maxBytes: pollMaxBytes });
  const records = Array.isArray(response.lines) ? response.lines : [];
  const responseSourceKind =
    response.sourceKind && KNOWN_SOURCE_KINDS.includes(response.sourceKind)
      ? response.sourceKind
      : currentSourceKind;

  if (records.length === 0) {
    // Nothing to write, but the RPC may still have handed back a moved
    // cursor (a keep-alive / heartbeat semantic some polled RPCs use) — save
    // it if so, since there is nothing un-flushed at risk here.
    if (response.cursor != null && response.cursor !== cursor) {
      cursorState.sourceCursors.set(currentSourceKind, response.cursor);
      await saveCursor(agent.id, currentSourceKind, response.cursor, { db });
    }
    return { gotRecords: false, appended: 0, dropped: 0 };
  }

  const runs = splitRunsOnMetaRecords(records, currentSourceKind, responseSourceKind);

  const retentionDays = await resolveRetention(tenant.workspaceId, { db });
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let appended = 0;
  let dropped = 0;
  const allLines = [];
  for (const run of runs) {
    for (const record of run.records) {
      const normalized = normalize(record, { stream: GATEWAY_STREAM, now });
      if (!normalized) continue; // silent-level record — suppressed, not a real event
      const effectiveTsMs = Date.parse(normalized.ts || normalized.observed_ts);
      if (Number.isFinite(effectiveTsMs) && effectiveTsMs < cutoffMs) {
        dropped += 1;
        continue;
      }
      allLines.push(redact(normalized));
    }
  }

  if (allLines.length > 0) {
    await segmentWriter.append(
      {
        agentId: agent.id,
        stream: GATEWAY_STREAM,
        workspaceId: tenant.workspaceId,
        ownerUserId: tenant.ownerUserId,
      },
      allLines,
    );
    appended = allLines.length;
    // Item 5b: force the flush now and gate the cursor save on it landing —
    // see this function's module-level comment for why the gateway stream
    // cannot wait for Phase 3's normal 15-minute/size-threshold flush the
    // way Phase 4's derived-from-log_segments cursor can.
    await segmentWriter.flush(`${agent.id}:${GATEWAY_STREAM}`);
  }

  // Persist the cursor for every source kind this batch touched. Only the
  // FINAL run's source kind is the one `cursorState.currentSourceKind`
  // advances to for the next poll; any earlier, now-superseded run's source
  // kind is left exactly where its own last successful poll left it (item
  // 3 / test list: "a source-kind transition resets/updates the cursor for
  // that specific kind only, not the other kind") — its own future poll (if
  // that source ever becomes current again) resumes from there via its own
  // `loadCursor` lookup, not from anything cached here.
  const finalRun = runs[runs.length - 1];
  const finalSourceKind = finalRun.sourceKind || responseSourceKind;
  cursorState.currentSourceKind = finalSourceKind;
  cursorState.sourceCursors.set(finalSourceKind, response.cursor ?? null);
  await saveCursor(agent.id, finalSourceKind, response.cursor ?? null, { db });

  if (dropped > 0) {
    logger.warn(
      `[gatewayCollector] agent ${agent.id}: dropped ${dropped} gateway log line(s) already ` +
        `older than the resolved ${retentionDays}-day retention cutoff (stale cursor after an outage)`,
    );
  }

  return { gotRecords: true, appended, dropped };
}

// ── createGatewayCollector / startGatewayCollector ────────────────────

/**
 * @param {Object} [deps]
 * @param {Object} [deps.db] - pg-like `{ query(sql, params) }`.
 * @param {Object} [deps.segmentWriter] - Phase 3's writer: `append`, `flush`.
 * @param {Function} [deps.createGatewayClient] - defaults to Phase 9's client factory.
 * @param {Function} [deps.callLogsTail] - defaults to Phase 9's typed wrapper.
 * @param {Function} [deps.resolveAgentRuntimeFamily] - defaults to the shared helper.
 * @param {Function} [deps.resolveTenantForAgent] - defaults to Phase 4's
 *   `logCollector.ts` export (shared tenant-resolution logic — never
 *   reimplemented here).
 * @param {Function} [deps.resolveLogRetention] - defaults to Phase 5's resolver.
 * @param {Function} [deps.applyConsoleLevelConfig] - defaults to this module's own.
 * @param {Function} [deps.decryptGatewayToken] - decrypts `agent.gateway_token`
 *   before handing it to `createGatewayClient`; defaults to backend-api's `crypto.ts`.
 * @param {number} [deps.reconcileIntervalMs]
 * @param {Function} [deps.setIntervalFn] / {Function} [deps.clearIntervalFn]
 * @param {Function} [deps.setTimeoutFn] / {Function} [deps.clearTimeoutFn]
 *   - injectable per-agent poll scheduling, for deterministic tests.
 * @param {Console} [deps.logger]
 * @returns {{ start: Function, stop: Function, stopReconciler: Function,
 *   stopCollector: Function, reconcileStreams: Function,
 *   heldAgentCount: Function, pollOnce: Function }}
 */
function createGatewayCollector(deps = {}) {
  const db = deps.db || require("../../../backend-api/db.ts");
  const segmentWriter = deps.segmentWriter;
  const makeClient = deps.createGatewayClient || createGatewayClient;
  const callTail = deps.callLogsTail || callLogsTail;
  const resolveRuntimeFamily = deps.resolveAgentRuntimeFamily || resolveAgentRuntimeFamily;
  const resolveTenant =
    deps.resolveTenantForAgent || require("./logCollector.ts").resolveTenantForAgent;
  const resolveRetention = deps.resolveLogRetention || require("./retentionSweeper.ts").resolveLogRetention;
  const applyConsoleLevel = deps.applyConsoleLevelConfig || applyConsoleLevelConfig;
  const decryptGatewayToken =
    deps.decryptGatewayToken || ((token) => require("../../../backend-api/crypto.ts").decrypt(token));
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const logger = deps.logger || console;

  if (!segmentWriter) {
    throw new Error("createGatewayCollector requires deps.segmentWriter");
  }

  /** @type {Map<string, Object>} */
  const agents = new Map();
  let stopped = false;
  let reconcileTimer = null;

  function detach(agentId) {
    const held = agents.get(agentId);
    if (!held) return;
    held.stopped = true;
    if (held.pollTimer) clearTimeoutFn(held.pollTimer);
    try {
      held.client?.close?.();
    } catch (error) {
      logger.warn(`[gatewayCollector] error closing gateway client for agent ${agentId}: ${error.message}`);
    }
    agents.delete(agentId);
  }

  function scheduleNextPoll(held) {
    if (held.stopped || stopped) return;
    held.pollTimer = setTimeoutFn(() => {
      runPoll(held).catch((error) => {
        logger.error(`[gatewayCollector] poll failed for agent ${held.agent.id}: ${error.message}`);
      });
    }, held.delayMs);
    if (typeof held.pollTimer.unref === "function") held.pollTimer.unref();
  }

  async function runPoll(held) {
    if (held.stopped || stopped) return;
    let result;
    try {
      result = await pollAgentGatewayLogs(held.agent, held.cursorState, {
        db,
        client: held.client,
        segmentWriter,
        tenant: held.tenant,
        resolveLogRetention: resolveRetention,
        logger,
        callLogsTail: callTail,
      });
    } catch (error) {
      logger.warn(
        `[gatewayCollector] logs.tail poll failed for agent ${held.agent.id}: ${error.message}`,
      );
      result = { gotRecords: false };
    }
    const step = computeNextPollStep(held.stepIndex, Boolean(result.gotRecords));
    held.stepIndex = step.stepIndex;
    held.delayMs = step.delayMs;
    scheduleNextPoll(held);
  }

  /**
   * Attach a poll loop for `agent`. Opens a gateway client, resolves the
   * tenant once (cached on `held.tenant` for the life of this attach, like
   * Phase 4's `attachAgentStream`), and starts the adaptive-interval poll
   * loop immediately.
   */
  function attachAgent(agent, tenant) {
    const held = {
      agent,
      tenant,
      client: makeClient(agent, { token: decryptGatewayToken(agent.gateway_token) }),
      cursorState: { currentSourceKind: DEFAULT_SOURCE_KIND, sourceCursors: new Map() },
      stepIndex: 0,
      delayMs: POLL_BACKOFF_STEPS_MS[0],
      pollTimer: null,
      stopped: false,
    };
    agents.set(agent.id, held);
    scheduleNextPoll(held);
    return held;
  }

  /**
   * The 30s level-triggered reconcile (matching Phase 4's cadence, see
   * module header). Re-derives the desired agent set from `agents` on every
   * call: running/warning OpenClaw agents whose workspace has
   * `gateway_logs_enabled`. Hermes agents (or any non-OpenClaw runtime
   * family) are silently excluded — never attached, never logged as an
   * error (item 1 / test list: "a Hermes agent is skipped entirely, without
   * throwing or logging an error").
   *
   * ── Item 7's second half: consoleLevel:warn reconciliation ────────────
   *
   * For every eligible OpenClaw agent found this tick — whether newly
   * attached this tick or already held from a previous one —
   * `applyConsoleLevelConfig` is invoked unconditionally, best-effort
   * (failures are logged and do not block collection). This is what
   * "reconciles" a pre-existing agent's config, not just a freshly
   * provisioned one: an agent provisioned before this feature shipped, or
   * whose config was reset by some other process, has no other mechanism
   * that would ever apply `consoleLevel: warn` to it — provisioning-time
   * application (wired at the deploy path, outside this module) only ever
   * runs once, at deploy time, for agents created after this feature
   * shipped. Re-applying an idempotent config merge every 30s is
   * deliberately simple over adding a "have I already confirmed this"
   * cache that would need its own invalidation story (e.g. an operator
   * hand-editing the container's `openclaw.json` back to `info` would slip
   * through a stickier cache silently); the merge itself is a cheap
   * single-file read-modify-write, not a restart, so the steady-state cost
   * is one exec call per OpenClaw agent per reconcile tick. This is called
   * out explicitly as a place to revisit if per-tick exec volume becomes a
   * concern at large agent counts.
   */
  async function reconcileStreams() {
    if (stopped) return;

    const result = await db.query(
      `SELECT id, user_id, container_id, status, backend_type, deploy_target,
              execution_target_id, runtime_family, sandbox_profile,
              host, runtime_host, runtime_port, gateway_host, gateway_port, gateway_token
         FROM agents
        WHERE status IN ('running', 'warning')`,
    );
    const rows = result.rows || [];

    const desired = new Map();
    for (const agent of rows) {
      // Item 1: a Hermes (or any non-OpenClaw) agent is skipped entirely,
      // silently — no warning, no error. This is the normal, expected case
      // for every Hermes-family agent in an installation, not an anomaly.
      if (resolveRuntimeFamily(agent) !== "openclaw") continue;

      let tenant;
      try {
        tenant = await resolveTenant(agent.id, { db });
      } catch (error) {
        logger.warn(
          `[gatewayCollector] could not resolve tenant for agent ${agent.id}, skipping this tick: ${error.message}`,
        );
        continue;
      }

      let gatewayLogsEnabled;
      try {
        gatewayLogsEnabled = await resolveGatewayLogsEnabled(tenant, { db });
      } catch (error) {
        logger.warn(
          `[gatewayCollector] could not resolve gateway_logs_enabled for agent ${agent.id}, ` +
            `assuming disabled this tick: ${error.message}`,
        );
        gatewayLogsEnabled = false;
      }

      // Item 7: reconcile consoleLevel for every eligible OpenClaw agent,
      // independent of gateway_logs_enabled — the config sync is what
      // prevents duplicate collection SHOULD gateway collection be (or
      // later become) active for this agent, so it is applied regardless of
      // today's workspace setting rather than only once collection is on.
      try {
        await applyConsoleLevel(agent, { db });
      } catch (error) {
        logger.warn(
          `[gatewayCollector] consoleLevel:warn config sync failed for agent ${agent.id}: ${error.message}`,
        );
      }

      if (!gatewayLogsEnabled) continue;
      desired.set(agent.id, { agent, tenant });
    }

    for (const agentId of Array.from(agents.keys())) {
      if (!desired.has(agentId)) detach(agentId);
    }

    for (const [agentId, { agent, tenant }] of desired) {
      if (agents.has(agentId)) continue; // already polling, nothing to do
      try {
        attachAgent(agent, tenant);
      } catch (error) {
        logger.warn(`[gatewayCollector] failed to attach gateway poll for agent ${agentId}: ${error.message}`);
      }
    }
  }

  function start() {
    if (reconcileTimer) return;
    stopped = false;
    reconcileTimer = setIntervalFn(() => {
      reconcileStreams().catch((error) => {
        logger.error(`[gatewayCollector] reconcile tick failed: ${error.message}`);
      });
    }, reconcileIntervalMs);
    if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();
  }

  function stopReconciler() {
    stopped = true;
    if (reconcileTimer) {
      clearIntervalFn(reconcileTimer);
      reconcileTimer = null;
    }
  }

  function stopCollector() {
    for (const agentId of Array.from(agents.keys())) detach(agentId);
  }

  function stop() {
    stopReconciler();
    stopCollector();
  }

  function heldAgentCount() {
    return agents.size;
  }

  return {
    start,
    stop,
    stopReconciler,
    stopCollector,
    reconcileStreams,
    heldAgentCount,
    attachAgent,
    detach,
  };
}

function startGatewayCollector(deps = {}) {
  const collector = createGatewayCollector(deps);
  collector.start();
  return collector;
}

module.exports = {
  createGatewayCollector,
  startGatewayCollector,
  pollAgentGatewayLogs,
  loadCursor,
  saveCursor,
  applyConsoleLevelConfig,
  resolveGatewayLogsEnabled,
  splitRunsOnMetaRecords,
  computeNextPollStep,
  GATEWAY_STREAM,
  DEFAULT_RECONCILE_INTERVAL_MS,
  POLL_BACKOFF_STEPS_MS,
  DEFAULT_SOURCE_KIND,
};
