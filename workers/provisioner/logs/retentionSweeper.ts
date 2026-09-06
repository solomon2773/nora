// @ts-nocheck
// workers/provisioner/logs/retentionSweeper.ts — Phase 5 of the logging
// control plane: enforces per-workspace retention under a platform ceiling,
// tracks the authoritative installation-wide local-storage capacity gate
// Phase 3's segmentWriter.ts now delegates to, and reconciles storage
// against the `log_segments` index so orphaned objects get reclaimed.
//
// Depends on:
//   - agent-runtime/lib/objectStorage.ts (Phase 0)      — listStorageObjects,
//     deleteStorageObjects
//   - backend-api/db_schema.sql `log_segments` /
//     `log_segment_legacy_copies` / `agent_spans` /
//     `workspace_log_settings`                          (Phase 1)
//   - workers/provisioner/logs/logStorageConfig.ts (Phase 3) —
//     storageConfigForSegment, logStorageConfig
//   - backend-api/platformSettings.ts (this phase)        — getLogRetentionCeilingDays
//   - backend-api/monitoring.ts                           — logEvent
//   - backend-api/middleware/ownership.ts                 — findAccessibleAgentForActor
//
// Read the manifest's "Deletion Model" and "Storage Model" sections, and the
// implementation plan's Phase 5 "Changes required", before changing the
// sweep-order or capacity-transition logic below — several choices here
// (objects-before-rows, content-time expiry, per-backend batching, the
// three-state loud/reversible halt) are load-bearing guarantees other parts
// of the system depend on.

const objectStorage = require("../../../agent-runtime/lib/objectStorage.ts");
const logStorageConfigModule = require("./logStorageConfig.ts");

// ── Tunables ─────────────────────────────────────────────────────────────

const DEFAULT_HOURLY_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
// How often checkCapacityState() itself runs independent of any sweep, so a
// warning/halt/resume transition is caught promptly rather than only once an
// hour. Comfortably faster than the collector's 30s reconcile tick.
const DEFAULT_CAPACITY_CHECK_INTERVAL_MS = 15 * 1000;
// Default warning threshold: 80% of NORA_LOG_LOCAL_MAX_BYTES (Phase 5 item 5).
const DEFAULT_WARNING_RATIO = 0.8;
// In-flight guard for orphan reconciliation (item 8): an object younger than
// one flush interval could be a write still in progress whose index row
// hasn't landed yet — see Phase 3 item 14's "object before index" ordering.
const DEFAULT_FLUSH_INTERVAL_MS = 15 * 60 * 1000;

function lazyDb(deps) {
  return deps.db || require("../../../backend-api/db.ts");
}

function lazyLogEvent(deps) {
  return deps.logEvent || require("../../../backend-api/monitoring.ts").logEvent;
}

function lazyFindAccessibleAgentForActor(deps) {
  return (
    deps.findAccessibleAgentForActor ||
    require("../../../backend-api/middleware/ownership.ts").findAccessibleAgentForActor
  );
}

function lazyPlatformSettings(deps) {
  return deps.platformSettings || require("../../../backend-api/platformSettings.ts");
}

// ── resolveLogRetention (Phase 5 item 2 / function list) ────────────────

/**
 * Resolve the effective retention (in days) for `column` ("runtime_retention_days"
 * or "trace_retention_days") on `workspaceId`, through the fallback chain
 * required by item 2: the workspace's `workspace_log_settings` row when one
 * exists, the platform ceiling otherwise — and in both cases clamped to
 * never exceed the platform ceiling. An agent with no workspace
 * (`workspaceId == null`) has no `workspace_log_settings` row by design (see
 * the manifest), so it always resolves to the platform ceiling directly.
 *
 * @param {string|null} workspaceId
 * @param {string} column - "runtime_retention_days" | "trace_retention_days"
 * @param {Object} [deps]
 * @returns {Promise<number>} Effective retention in days.
 */
async function resolveRetentionDaysForColumn(workspaceId, column, deps = {}) {
  if (column !== "runtime_retention_days" && column !== "trace_retention_days") {
    throw new Error(`Unknown workspace_log_settings retention column: ${column}`);
  }
  const db = lazyDb(deps);
  const platformSettings = lazyPlatformSettings(deps);
  const getLogRetentionCeilingDays =
    deps.getLogRetentionCeilingDays || platformSettings.getLogRetentionCeilingDays;

  // Resolve the plan for the ceiling. Self-hosted mode ignores the plan
  // entirely (see getLogRetentionCeilingDays's own selfhosted short-circuit);
  // PaaS mode looks up the workspace owner's billing plan, best-effort — a
  // failure here (e.g. billing.ts unavailable) falls back to the "free" tier
  // ceiling rather than granting an unbounded one.
  let plan = "free";
  if ((process.env.PLATFORM_MODE || "selfhosted").toLowerCase() === "paas" && workspaceId) {
    try {
      const ownerResult = await db.query(`SELECT user_id FROM workspaces WHERE id = $1`, [
        workspaceId,
      ]);
      const ownerId = ownerResult.rows[0]?.user_id;
      if (ownerId) {
        const billing = deps.billing || require("../../../backend-api/billing.ts");
        const subscription = await billing.getSubscription(ownerId);
        plan = subscription?.plan || "free";
      }
    } catch {
      // Best-effort — fall back to the free-tier ceiling below.
      plan = "free";
    }
  }

  const ceilingDays = await getLogRetentionCeilingDays(plan);

  let workspaceValue = null;
  if (workspaceId) {
    const result = await db.query(
      `SELECT ${column} AS value FROM workspace_log_settings WHERE workspace_id = $1`,
      [workspaceId],
    );
    workspaceValue = result.rows[0]?.value ?? null;
  }

  // Fallback chain (item 2): workspace row when it exists, platform ceiling
  // otherwise. Either way, never exceed the ceiling.
  const effective = workspaceValue != null ? Number(workspaceValue) : ceilingDays;
  return Math.min(effective, ceilingDays);
}

/**
 * Per-workspace runtime/gateway log retention, clamped to the platform
 * ceiling (Phase 5 item 2 / Functions list). Workspaces with no
 * `workspace_log_settings` row — including the null-workspace case for
 * agents that belong to no workspace — fall back to the platform ceiling
 * rather than retaining forever.
 *
 * @param {string|null} workspaceId
 * @param {Object} [deps]
 * @returns {Promise<number>} Effective retention in days.
 */
async function resolveLogRetention(workspaceId, deps = {}) {
  return resolveRetentionDaysForColumn(workspaceId, "runtime_retention_days", deps);
}

/**
 * Per-workspace trace/span retention, clamped to the same platform ceiling.
 * Not in the plan's named Functions list, but required to implement item 4's
 * "delete expired agent_spans" step against the correct per-workspace
 * cutoff rather than an arbitrary constant.
 */
async function resolveTraceRetention(workspaceId, deps = {}) {
  return resolveRetentionDaysForColumn(workspaceId, "trace_retention_days", deps);
}

function daysAgoIso(days, now = Date.now()) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

// ── sweepExpiredSegments (Phase 5 item 4/4a) ─────────────────────────────

/**
 * Group storage keys by their resolved (rehydrated) config, so a batch
 * delete never mixes credentials across a destination change (item 4a).
 * Two rows land in the same group only when their rehydrated config is
 * deep-equal (JSON-stringified for comparison, which is stable here since
 * `storageConfigForSegment` always returns a plain, non-nested object).
 */
async function groupKeysByConfig(rows, resolveConfig) {
  const groups = new Map();
  for (const row of rows) {
    const config = await resolveConfig(row);
    const configKey = JSON.stringify(config);
    if (!groups.has(configKey)) groups.set(configKey, { config, keys: [] });
    groups.get(configKey).keys.push(row.storage_key);
  }
  return groups;
}

/**
 * Delete every legacy copy (Phase 1's `log_segment_legacy_copies`, populated
 * once Phase 5b ships) for the given `log_segments` ids, deleting each
 * copy's OLD-destination object first (item 4's "objects before rows"
 * invariant extends to legacy copies too) and then the tracking row.
 *
 * A legacy copy has no `storage_key` of its own — a migration writes the
 * copy under the SAME key as the (now repointed) `log_segments` row, just
 * under the old destination's driver/credentials — so this must be called
 * BEFORE the caller deletes those `log_segments` rows, while `storage_key`
 * is still resolvable via the join below.
 */
async function deleteLegacyCopiesForSegments(segmentIds, deps = {}) {
  if (!segmentIds || segmentIds.length === 0) return { deletedCopies: 0, deletedObjects: 0 };
  const db = lazyDb(deps);
  const deleteObjs = deps.deleteStorageObjects || objectStorage.deleteStorageObjects;
  const resolveConfig = deps.storageConfigForSegment || logStorageConfigModule.storageConfigForSegment;

  const result = await db.query(
    `SELECT lc.id AS legacy_id, lc.storage_backend, lc.storage_config, ls.storage_key
       FROM log_segment_legacy_copies lc
       JOIN log_segments ls ON ls.id = lc.log_segment_id
      WHERE lc.log_segment_id = ANY($1::uuid[])`,
    [segmentIds],
  );
  const rows = result.rows || [];
  if (rows.length === 0) return { deletedCopies: 0, deletedObjects: 0 };

  const groups = await groupKeysByConfig(
    rows.map((r) => ({ storage_key: r.storage_key, storage_backend: r.storage_backend, storage_config: r.storage_config })),
    resolveConfig,
  );
  let deletedObjects = 0;
  for (const { config, keys } of groups.values()) {
    const outcome = await deleteObjs(keys, config);
    deletedObjects += outcome?.deleted?.length ?? keys.length;
  }

  const legacyIds = rows.map((r) => r.legacy_id);
  await db.query(`DELETE FROM log_segment_legacy_copies WHERE id = ANY($1::uuid[])`, [legacyIds]);

  return { deletedCopies: legacyIds.length, deletedObjects };
}

/**
 * Sweep every `log_segments` row for `workspaceId` (or, when `workspaceId`
 * is `null`, every row belonging to no workspace) whose content-time
 * (`ts_to`) is older than `cutoff` (Phase 5 item 4a: expiry is on content
 * time, not write time, matching the search path). Sweep order (item 4):
 * any legacy copy's object first, then this segment's own object, batched
 * per rehydrated config (item 4a), THEN the `log_segments` row — an index
 * row must never outlive its object.
 *
 * @param {string|null} workspaceId
 * @param {string} cutoff - ISO timestamp; rows with ts_to < cutoff expire.
 * @param {Object} [deps]
 * @returns {Promise<{deletedSegments: number, deletedObjects: number, deletedLegacyCopies: number}>}
 */
async function sweepExpiredSegments(workspaceId, cutoff, deps = {}) {
  const db = lazyDb(deps);
  const deleteObjs = deps.deleteStorageObjects || objectStorage.deleteStorageObjects;
  const resolveConfig = deps.storageConfigForSegment || logStorageConfigModule.storageConfigForSegment;

  const whereWorkspace = workspaceId == null ? `workspace_id IS NULL` : `workspace_id = $2`;
  const params = workspaceId == null ? [cutoff] : [cutoff, workspaceId];
  const result = await db.query(
    `SELECT id, storage_key, storage_backend, storage_config
       FROM log_segments
      WHERE ts_to < $1 AND ${whereWorkspace}`,
    params,
  );
  const rows = result.rows || [];
  if (rows.length === 0) return { deletedSegments: 0, deletedObjects: 0, deletedLegacyCopies: 0 };

  const segmentIds = rows.map((r) => r.id);

  // Legacy copies first — their objects live on the OLD destination and
  // need `log_segments.storage_key`, which is still resolvable now but
  // wouldn't be after the DELETE below.
  const legacyOutcome = await deleteLegacyCopiesForSegments(segmentIds, {
    ...deps,
    db,
    deleteStorageObjects: deleteObjs,
  });

  // This segment's own (current) object, batched per rehydrated config —
  // item 4a: a segment written before a destination change lives elsewhere
  // and needs its own config, not the current destination's.
  const groups = await groupKeysByConfig(rows, resolveConfig);
  let deletedObjects = legacyOutcome.deletedObjects;
  for (const { config, keys } of groups.values()) {
    const outcome = await deleteObjs(keys, config);
    deletedObjects += outcome?.deleted?.length ?? keys.length;
  }

  // Item 14 (Phase 3) extended to deletion: objects are gone before the
  // index row is removed.
  await db.query(`DELETE FROM log_segments WHERE id = ANY($1::uuid[])`, [segmentIds]);

  return {
    deletedSegments: segmentIds.length,
    deletedObjects,
    deletedLegacyCopies: legacyOutcome.deletedCopies,
  };
}

async function sweepExpiredSpans(workspaceId, cutoff, deps = {}) {
  const db = lazyDb(deps);
  const whereWorkspace = workspaceId == null ? `workspace_id IS NULL` : `workspace_id = $2`;
  const params = workspaceId == null ? [cutoff] : [cutoff, workspaceId];
  const result = await db.query(
    `DELETE FROM agent_spans WHERE started_at < $1 AND ${whereWorkspace} RETURNING id`,
    params,
  );
  return { deletedSpans: result.rowCount || (result.rows || []).length || 0 };
}

// ── localStorageUsage / checkCapacityState (Phase 5 items 5-7) ──────────

/**
 * Sum of `bytes` over every live `log_segments` row currently resident on
 * the `local` driver, installation-wide (Phase 5 item 5 / function list).
 * This is the authoritative replacement for Phase 3's `checkLocalCapacity`
 * disk-scan placeholder: an O(1) indexed SUM rather than an O(files) walk,
 * and it reflects what's actually accounted for in the index rather than
 * whatever happens to be sitting in `NORA_LOG_DIR` (which could include
 * bytes from segments that already failed to index, or exclude bytes from a
 * disk the process doesn't have full visibility into).
 *
 * Filtered to `storage_backend = 'local'` rather than every driver, because
 * this specifically answers "how much of the local disk budget is used" —
 * segments already migrated to s3/r2 (Phase 5b) must not count against it.
 *
 * @param {Object} [deps]
 * @returns {Promise<number>} Total bytes.
 */
async function localStorageUsage(deps = {}) {
  const db = lazyDb(deps);
  const result = await db.query(
    `SELECT COALESCE(SUM(bytes), 0)::bigint AS total FROM log_segments WHERE storage_backend = 'local'`,
  );
  return Number(result.rows[0]?.total || 0);
}

// Module-level singleton: one worker process is one installation, and the
// capacity halt is explicitly installation-wide (item 5), not per-workspace,
// so a single shared state is the correct model — not a simplification.
// Tests inject their own state container via deps.stateStore for isolation.
let _capacityState = "ok";
const defaultStateStore = {
  get: () => _capacityState,
  set: (value) => {
    _capacityState = value;
  },
};

/**
 * Compare current local usage against `NORA_LOG_LOCAL_MAX_BYTES` and the
 * warning threshold, returning `"ok" | "warning" | "halted"` (Phase 5 item
 * 5-6 / function list). Writes a distinct `events` row via
 * `monitoring.logEvent` on each of the three meaningful transitions (item
 * 6): crossing into warning, crossing into halted, and dropping back out of
 * halted (the "resumed" event) — a warning-to-ok transition is intentionally
 * silent since it isn't one of the three states operators need to
 * distinguish.
 *
 * @param {Object} [deps]
 * @returns {Promise<"ok"|"warning"|"halted">}
 */
async function checkCapacityState(deps = {}) {
  const limitBytes =
    deps.limitBytes ?? (Number(process.env.NORA_LOG_LOCAL_MAX_BYTES) || Infinity);
  const warningRatio = deps.warningRatio ?? DEFAULT_WARNING_RATIO;
  const usedBytes =
    deps.usedBytes !== undefined ? deps.usedBytes : await localStorageUsage(deps);
  const logEvent = deps.logEventFn || lazyLogEvent(deps);
  const stateStore = deps.stateStore || defaultStateStore;

  const halted = Number.isFinite(limitBytes) && usedBytes >= limitBytes;
  const warning = !halted && Number.isFinite(limitBytes) && usedBytes >= limitBytes * warningRatio;
  const nextState = halted ? "halted" : warning ? "warning" : "ok";
  const previousState = stateStore.get();

  if (nextState !== previousState) {
    if (nextState === "halted") {
      await logEvent(
        "log_storage_capacity_halted",
        `Local log storage reached its cap (${usedBytes}/${limitBytes} bytes) — log collection is ` +
          `paused installation-wide until the operator raises the cap or deletes logs`,
        { usedBytes, limitBytes },
      );
    } else if (nextState === "warning" && previousState === "ok") {
      await logEvent(
        "log_storage_capacity_warning",
        `Local log storage usage crossed the warning threshold (${usedBytes}/${limitBytes} bytes, ` +
          `${Math.round(warningRatio * 100)}% of cap)`,
        { usedBytes, limitBytes, warningRatio },
      );
    } else if (previousState === "halted" && nextState !== "halted") {
      await logEvent(
        "log_storage_capacity_resumed",
        `Local log storage usage dropped back under the cap (${usedBytes}/${limitBytes} bytes) — ` +
          `log collection resumes automatically`,
        { usedBytes, limitBytes },
      );
    }
    stateStore.set(nextState);
  }

  return nextState;
}

/**
 * Current local usage against the cap, and the current halt/warning state
 * (Phase 5 item 7a-i) — the data function an admin settings UI and the
 * Runtime lens can call. Retention itself is unaffected by capacity; this
 * only reports whether collection is currently gapped.
 *
 * @param {Object} [deps]
 * @returns {Promise<{usedBytes: number, limitBytes: number, state: string}>}
 */
async function getCapacityStatus(deps = {}) {
  const limitBytes =
    deps.limitBytes ?? (Number(process.env.NORA_LOG_LOCAL_MAX_BYTES) || Infinity);
  const usedBytes = await localStorageUsage(deps);
  const stateStore = deps.stateStore || defaultStateStore;
  return { usedBytes, limitBytes, state: stateStore.get() };
}

// ── deleteLogsByAgentAndRange (Phase 5 item 7b) ──────────────────────────

/**
 * Manually delete `log_segments` (and their objects, plus any
 * `log_segment_legacy_copies`) for `agentId` in `[from, to]`, scoped by the
 * actor's workspace role (editor-or-above — the only way an operator
 * reclaims local disk space short of raising the cap, by design; there is
 * no automatic eviction).
 *
 * @param {string} agentId
 * @param {string|Date} from
 * @param {string|Date} to
 * @param {{id: string, role?: string}} actor - the authenticated user.
 * @param {Object} [deps]
 * @returns {Promise<{deletedSegments: number, deletedObjects: number, deletedLegacyCopies: number}>}
 */
async function deleteLogsByAgentAndRange(agentId, from, to, actor, deps = {}) {
  if (!agentId || !from || !to || !actor || !actor.id) {
    const error = new Error("agentId, from, to, and actor are required");
    error.statusCode = 400;
    throw error;
  }

  const findAccessibleAgentForActor = lazyFindAccessibleAgentForActor(deps);
  const agent = await findAccessibleAgentForActor(agentId, actor, "editor");
  if (!agent) {
    const error = new Error("Agent not found, or you do not have editor access to it");
    error.statusCode = 404;
    throw error;
  }

  const db = lazyDb(deps);
  const deleteObjs = deps.deleteStorageObjects || objectStorage.deleteStorageObjects;
  const resolveConfig = deps.storageConfigForSegment || logStorageConfigModule.storageConfigForSegment;
  const logEvent = deps.logEventFn || lazyLogEvent(deps);

  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  if (Number.isNaN(Date.parse(fromIso)) || Number.isNaN(Date.parse(toIso))) {
    const error = new Error("from and to must be valid timestamps");
    error.statusCode = 400;
    throw error;
  }

  const segmentsResult = await db.query(
    `SELECT id, storage_key, storage_backend, storage_config
       FROM log_segments
      WHERE agent_id = $1 AND ts_from >= $2 AND ts_to <= $3`,
    [agentId, fromIso, toIso],
  );
  const rows = segmentsResult.rows || [];
  const segmentIds = rows.map((r) => r.id);

  // Legacy copies first (need log_segments.storage_key, which is still
  // resolvable before the DELETE below) — same ordering rationale as
  // sweepExpiredSegments.
  const legacyOutcome = await deleteLegacyCopiesForSegments(segmentIds, {
    ...deps,
    db,
    deleteStorageObjects: deleteObjs,
  });

  let deletedObjects = legacyOutcome.deletedObjects;
  if (rows.length > 0) {
    const groups = await groupKeysByConfig(rows, resolveConfig);
    for (const { config, keys } of groups.values()) {
      const outcome = await deleteObjs(keys, config);
      deletedObjects += outcome?.deleted?.length ?? keys.length;
    }
    await db.query(`DELETE FROM log_segments WHERE id = ANY($1::uuid[])`, [segmentIds]);
  }

  await logEvent(
    "log_manual_deletion",
    `${actor.id} manually deleted logs for agent ${agentId} between ${fromIso} and ${toIso}`,
    {
      agentId,
      from: fromIso,
      to: toIso,
      actorId: actor.id,
      deletedSegments: segmentIds.length,
      deletedObjects,
      deletedLegacyCopies: legacyOutcome.deletedCopies,
    },
  );

  return {
    deletedSegments: segmentIds.length,
    deletedObjects,
    deletedLegacyCopies: legacyOutcome.deletedCopies,
  };
}

// ── reconcileStorage (Phase 5 item 8/8a) ─────────────────────────────────

/**
 * Daily LIST-vs-index diff (item 8): an object with no matching
 * `log_segments` row, older than one flush interval (so an in-flight write
 * isn't mistaken for an orphan — Phase 3 item 14's "object before index"
 * ordering means a very recent orphan-looking object may just be mid-flush),
 * gets deleted; a `log_segments` row with no matching object is logged and
 * removed.
 *
 * Item 8a: before treating an unmatched object as an orphan, check whether
 * it's a KEPT legacy copy (Phase 5b's `log_segment_legacy_copies`, tracked
 * by `log_segments.storage_key` since a legacy copy shares its parent
 * segment's key). A kept copy deliberately has no `log_segments` row
 * recording its OLD backend — the row was repointed to the new destination —
 * so without this check, reconciliation would delete every kept copy on its
 * very first run.
 *
 * @param {string} [prefix] - Storage key prefix to scope both the LIST call
 *   and the index comparison to (e.g. a single workspace's `ws_<id>/`).
 *   Omit to reconcile the whole installation.
 * @param {Object} [deps]
 * @returns {Promise<{deletedOrphans: number, removedDanglingRows: number}>}
 */
async function reconcileStorage(prefix = "", deps = {}) {
  const db = lazyDb(deps);
  const list = deps.listStorageObjects || objectStorage.listStorageObjects;
  const deleteObjs = deps.deleteStorageObjects || objectStorage.deleteStorageObjects;
  const resolveConfig = deps.logStorageConfig || logStorageConfigModule.logStorageConfig;
  const logger = deps.logger || console;
  const now = deps.now ? deps.now() : Date.now();
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  const config = deps.storageConfig || (await resolveConfig());
  const objects = (await list(prefix, config)) || [];

  const likePattern = prefix ? `${prefix}%` : "%";
  const segmentRows = (
    await db.query(`SELECT id, storage_key FROM log_segments WHERE storage_key LIKE $1`, [
      likePattern,
    ])
  ).rows;
  const indexedKeys = new Set(segmentRows.map((r) => r.storage_key));

  // Item 8a: legacy copies share their parent segment's storage_key, so a
  // key present here is a deliberately-kept old-destination copy, not an
  // orphan — even though, by construction, it has no log_segments row of
  // its own recording the OLD backend.
  const legacyRows = (
    await db.query(
      `SELECT ls.storage_key AS storage_key
         FROM log_segment_legacy_copies lc
         JOIN log_segments ls ON ls.id = lc.log_segment_id
        WHERE ls.storage_key LIKE $1`,
      [likePattern],
    )
  ).rows;
  const legacyKeys = new Set(legacyRows.map((r) => r.storage_key));

  const orphanKeys = [];
  for (const obj of objects) {
    if (indexedKeys.has(obj.key) || legacyKeys.has(obj.key)) continue;
    const lastModifiedMs = obj.lastModified ? new Date(obj.lastModified).getTime() : now;
    const ageMs = now - lastModifiedMs;
    if (ageMs < flushIntervalMs) continue; // in-flight guard
    orphanKeys.push(obj.key);
  }

  let deletedOrphans = 0;
  if (orphanKeys.length > 0) {
    const outcome = await deleteObjs(orphanKeys, config);
    deletedOrphans = outcome?.deleted?.length ?? orphanKeys.length;
  }

  const objectKeySet = new Set(objects.map((o) => o.key));
  const danglingRows = segmentRows.filter((r) => !objectKeySet.has(r.storage_key));
  let removedDanglingRows = 0;
  if (danglingRows.length > 0) {
    logger.warn(
      `[retentionSweeper] ${danglingRows.length} log_segments row(s) reference objects missing ` +
        `from storage under prefix "${prefix}" — removing (a Postgres restore taken before the ` +
        `bucket's current state is the expected cause)`,
    );
    await db.query(
      `DELETE FROM log_segments WHERE id = ANY($1::uuid[])`,
      [danglingRows.map((r) => r.id)],
    );
    removedDanglingRows = danglingRows.length;
  }

  return { deletedOrphans, removedDanglingRows };
}

// ── startRetentionSweeper (Phase 5 item 3 / function list) ───────────────

/**
 * Start the hourly retention sweep, the daily storage reconciliation, and
 * the frequent capacity-state check — all `.unref()`'d so none keep the
 * process alive. Explicitly NOT the `container_stats` every-5-seconds
 * pattern (`backgroundTasks.ts:53`) — that cadence is wrong for this
 * workload (item 3).
 *
 * @param {Object} [deps]
 * @returns {{ stop: Function, runHourlySweepNow: Function,
 *   runDailyReconcileNow: Function }}
 */
function startRetentionSweeper(deps = {}) {
  const db = lazyDb(deps);
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const logger = deps.logger || console;
  const hourlyIntervalMs = deps.hourlyIntervalMs ?? DEFAULT_HOURLY_INTERVAL_MS;
  const dailyIntervalMs = deps.dailyIntervalMs ?? DEFAULT_DAILY_INTERVAL_MS;
  const capacityIntervalMs = deps.capacityIntervalMs ?? DEFAULT_CAPACITY_CHECK_INTERVAL_MS;

  async function runHourlySweepOnce() {
    const now = deps.now ? deps.now() : Date.now();
    const workspaceRows = (await db.query(`SELECT id FROM workspaces`)).rows || [];
    const targets = [...workspaceRows.map((r) => r.id), null]; // null: agents with no workspace
    for (const workspaceId of targets) {
      try {
        const runtimeRetentionDays = await resolveLogRetention(workspaceId, deps);
        await sweepExpiredSegments(workspaceId, daysAgoIso(runtimeRetentionDays, now), deps);

        const traceRetentionDays = await resolveTraceRetention(workspaceId, deps);
        await sweepExpiredSpans(workspaceId, daysAgoIso(traceRetentionDays, now), deps);
      } catch (error) {
        logger.error(
          `[retentionSweeper] sweep failed for workspace ${workspaceId ?? "(none)"}: ${error.message}`,
        );
      }
    }
  }

  async function runDailyReconcileOnce() {
    try {
      await reconcileStorage(deps.reconcilePrefix ?? "", deps);
    } catch (error) {
      logger.error(`[retentionSweeper] daily reconciliation failed: ${error.message}`);
    }
  }

  async function runCapacityCheckOnce() {
    try {
      await checkCapacityState(deps);
    } catch (error) {
      logger.error(`[retentionSweeper] capacity state check failed: ${error.message}`);
    }
  }

  const hourlyTimer = setIntervalFn(() => {
    runHourlySweepOnce().catch(() => {});
  }, hourlyIntervalMs);
  if (typeof hourlyTimer.unref === "function") hourlyTimer.unref();

  const dailyTimer = setIntervalFn(() => {
    runDailyReconcileOnce().catch(() => {});
  }, dailyIntervalMs);
  if (typeof dailyTimer.unref === "function") dailyTimer.unref();

  const capacityTimer = setIntervalFn(() => {
    runCapacityCheckOnce().catch(() => {});
  }, capacityIntervalMs);
  if (typeof capacityTimer.unref === "function") capacityTimer.unref();

  return {
    stop() {
      clearIntervalFn(hourlyTimer);
      clearIntervalFn(dailyTimer);
      clearIntervalFn(capacityTimer);
    },
    runHourlySweepNow: runHourlySweepOnce,
    runDailyReconcileNow: runDailyReconcileOnce,
    runCapacityCheckNow: runCapacityCheckOnce,
  };
}

module.exports = {
  startRetentionSweeper,
  sweepExpiredSegments,
  sweepExpiredSpans,
  localStorageUsage,
  checkCapacityState,
  getCapacityStatus,
  deleteLogsByAgentAndRange,
  reconcileStorage,
  resolveLogRetention,
  resolveTraceRetention,
  deleteLegacyCopiesForSegments,
  DEFAULT_HOURLY_INTERVAL_MS,
  DEFAULT_DAILY_INTERVAL_MS,
  DEFAULT_CAPACITY_CHECK_INTERVAL_MS,
  DEFAULT_WARNING_RATIO,
  DEFAULT_FLUSH_INTERVAL_MS,
};
