// @ts-nocheck
// workers/provisioner/logs/logDeletion.ts — Phase 5c of the logging control
// plane: what happens to an agent's or workspace's logs at deletion time,
// and the admin-only path back to logs an operator chose to keep.
//
// Depends on:
//   - agent-runtime/lib/objectStorage.ts (Phase 0)      — getStorageObject,
//     deleteStorageObjects
//   - backend-api/db_schema.sql `log_segments` / `agent_spans` /
//     `log_segment_legacy_copies` / `deleted_log_owners`  (Phase 1)
//   - workers/provisioner/logs/logStorageConfig.ts (Phase 3) —
//     storageConfigForSegment
//   - workers/provisioner/logs/segmentWriter.ts (Phase 3)  — decryptSegment,
//     loadLogEncryptionKeys (the exact primitives a live segment read
//     already uses — reused here unchanged, not reimplemented)
//   - workers/provisioner/logs/retentionSweeper.ts (Phase 5) —
//     deleteLegacyCopiesForSegments, groupKeysByConfig, resolveLogRetention
//   - backend-api/monitoring.ts                            — logEvent
//
// ── Why this file exists (Phase 5c objective) ───────────────────────────
//
// `backend-api/routes/agents.ts`'s and `routes/workspaces.ts`'s delete
// handlers now require an explicit `deleteLogs` boolean. `true` calls
// `deleteAgentLogs`/`deleteWorkspaceLogs` below, asynchronously, AFTER the
// agent/workspace row is already gone (the row deletion itself is
// unchanged — synchronous, as before). `false` calls
// `snapshotDeletedLogOwner` BEFORE the row is deleted (order matters: the
// workspace's `workspace_log_settings` row may not survive the delete), then
// leaves `log_segments`/`agent_spans` completely untouched.
//
// ── GET /admin/log-recovery/:id/logs and export — forward-reference note ──
//
// Per the Phase 5c task brief, this is a REAL, WORKING, MINIMAL
// implementation, not a stub: `listRecoveredLogLines` decrypts and
// decompresses actual segments via Phase 3's `decryptSegment` primitive and
// returns real log lines. It reads every candidate segment in `ts_from`
// order and walks forward with a simple `"<segmentIndex>:<lineOffset>"`
// cursor — there is no SQL-side pruning beyond the owning agent/workspace,
// no k-way merge across streams, no early-termination heuristics, and no
// prefiltering before parse. Phase 6's `searchLogs`/`selectCandidateSegments`
// (once built) is a strict superset of what an operator needs here and
// should replace this — scoped by `deleted_log_owners.source_id` exactly as
// this module already scopes it, never by `findAccessibleAgentForActor`
// (there is no agent/workspace row left to check access against). Export
// (`collectAllRecoveredLogLines`) is the same simplification applied to the
// whole range at once, capped at `MAX_EXPORT_LINES` rather than streamed —
// Phase 7's `streamLogExport` should replace it the same way.
//
// This mirrors Phase 3's placeholder `checkLocalCapacity` disk-scan, which
// Phase 5 later replaced outright once the real mechanism existed — a
// working placeholder now beats blocking this phase on unbuilt future work.

const zlib = require("zlib");

const objectStorage = require("../../../agent-runtime/lib/objectStorage.ts");
const logStorageConfigModule = require("./logStorageConfig.ts");
const segmentWriterModule = require("./segmentWriter.ts");
const retentionSweeperModule = require("./retentionSweeper.ts");

const DEFAULT_RECOVERY_PAGE_LIMIT = 200;
// Export is a bounded, in-memory "gather everything" implementation (see
// module header) — this is the safety valve until Phase 7's streamed export
// replaces it.
const MAX_EXPORT_LINES = 200000;

function lazyDb(deps) {
  return deps.db || require("../../../backend-api/db.ts");
}

function lazyLogEvent(deps) {
  return deps.logEventFn || require("../../../backend-api/monitoring.ts").logEvent;
}

// ── Shared purge core (used by deleteAgentLogs/deleteWorkspaceLogs AND the
//    admin manual-purge path) ─────────────────────────────────────────────

/**
 * Unconditionally remove every `log_segments` (and its object), any
 * `log_segment_legacy_copies`, and every `agent_spans` row matching
 * `<column> = <value>` — no `ts_to`/`cutoff` filter, unlike the retention
 * sweeper's expiry sweeps, since this is a full purge, not an expiry pass.
 * Deletes objects before index rows, in the exact order Phase 5's
 * retention sweeper already established (never a second, divergent
 * ordering).
 *
 * @param {"agent_id"|"workspace_id"} column
 * @param {string} value
 * @param {Object} [deps]
 * @returns {Promise<{deletedSegments: number, deletedObjects: number, deletedLegacyCopies: number, deletedSpans: number}>}
 */
async function purgeAllLogsByColumn(column, value, deps = {}) {
  const db = lazyDb(deps);
  const deleteObjs = deps.deleteStorageObjects || objectStorage.deleteStorageObjects;
  const resolveConfig = deps.storageConfigForSegment || logStorageConfigModule.storageConfigForSegment;
  const deleteLegacyCopiesForSegments =
    deps.deleteLegacyCopiesForSegments || retentionSweeperModule.deleteLegacyCopiesForSegments;
  const groupKeysByConfig = deps.groupKeysByConfig || retentionSweeperModule.groupKeysByConfig;

  const segResult = await db.query(
    `SELECT id, storage_key, storage_backend, storage_config FROM log_segments WHERE ${column} = $1`,
    [value],
  );
  const rows = segResult.rows || [];
  const segmentIds = rows.map((r) => r.id);

  // Legacy copies first — needs log_segments.storage_key, still resolvable
  // now but not after the DELETE below (same ordering rationale as
  // retentionSweeper.ts's sweepExpiredSegmentsByScope).
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

  const spanResult = await db.query(`DELETE FROM agent_spans WHERE ${column} = $1 RETURNING id`, [value]);
  const deletedSpans = spanResult.rowCount ?? (spanResult.rows || []).length ?? 0;

  return {
    deletedSegments: segmentIds.length,
    deletedObjects,
    deletedLegacyCopies: legacyOutcome.deletedCopies,
    deletedSpans,
  };
}

// ── deleteAgentLogs / deleteWorkspaceLogs (item 2 / Functions list) ──────

/**
 * `deleteLogs: true` async cleanup for a deleted agent. Called by
 * `routes/agents.ts` AFTER the agent row is already gone (fire-and-forget —
 * see module header). Scoped by `agent_id`, never `workspace_id`, so a
 * sibling agent in the same workspace is untouched.
 */
async function deleteAgentLogs(agentId, deps = {}) {
  return purgeAllLogsByColumn("agent_id", agentId, deps);
}

/**
 * `deleteLogs: true` async cleanup for a deleted workspace. `log_segments`/
 * `agent_spans` carry their own `workspace_id` snapshot from write time
 * (Phase 3) — member agents are NOT deleted by a workspace delete (they
 * stay with their owner; see db_schema.sql's `workspace_agents` comment),
 * so scoping by `workspace_id` directly is correct and does not require
 * enumerating member agents.
 */
async function deleteWorkspaceLogs(workspaceId, deps = {}) {
  return purgeAllLogsByColumn("workspace_id", workspaceId, deps);
}

// ── snapshotDeletedLogOwner (item 3 / Functions list) ────────────────────

/**
 * Build and insert the `deleted_log_owners` row BEFORE the source
 * agent/workspace row is actually deleted — order matters because the
 * `workspace_log_settings` lookup this resolves `retention_days` through may
 * not survive a workspace delete (its FK cascades).
 *
 * @param {"agent"|"workspace"} kind
 * @param {string} sourceId - the about-to-be-deleted agent/workspace id.
 * @param {{id: string}} actor - the authenticated user performing the delete.
 * @param {{displayName?: string, ownerUserId?: string, workspaceId?: string|null}} [meta]
 *   - `workspaceId` is the agent's current workspace (for kind "agent"
 *     only) — used to resolve `retention_days` through the SAME
 *     `workspace_log_settings` fallback chain the live sweeper uses. Omit
 *     (or pass null) for an agent with no workspace, which falls back to
 *     the platform ceiling exactly like the live path.
 * @param {Object} [deps]
 * @returns {Promise<Object>} the inserted `deleted_log_owners` row.
 */
async function snapshotDeletedLogOwner(kind, sourceId, actor, meta = {}, deps = {}) {
  if (kind !== "agent" && kind !== "workspace") {
    throw new Error(`Unknown deleted_log_owners kind: ${kind}`);
  }
  const db = lazyDb(deps);
  const resolveLogRetention = deps.resolveLogRetention || retentionSweeperModule.resolveLogRetention;

  // For "workspace", the workspace's OWN id is what workspace_log_settings
  // is keyed by. For "agent", it's whichever workspace (if any) the agent
  // currently belongs to — the caller resolves this since it already has
  // the agent row in hand.
  const retentionWorkspaceId = kind === "workspace" ? sourceId : (meta.workspaceId ?? null);
  const retentionDays = await resolveLogRetention(retentionWorkspaceId, deps);

  const result = await db.query(
    `INSERT INTO deleted_log_owners
       (kind, source_id, display_name, owner_user_id, retention_days, deleted_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [kind, sourceId, meta.displayName || null, meta.ownerUserId || null, retentionDays, actor?.id || null],
  );
  return result.rows[0];
}

// ── Admin recovery: purge (item 7 / Functions list) ──────────────────────

/**
 * `DELETE /admin/log-recovery/:id` — the operator's only way to reclaim
 * space held by a kept-logs entry: removes every segment/span/legacy copy
 * reachable under it, THEN the `deleted_log_owners` row itself (in that
 * order — the row is the last thing to go, so a failure partway through
 * leaves the entry visible and retryable rather than orphaning data with no
 * recovery-view pointer left to it).
 *
 * @param {string} deletedLogOwnerId
 * @param {{id: string}} actor
 * @param {Object} [deps]
 */
async function purgeDeletedLogOwner(deletedLogOwnerId, actor, deps = {}) {
  const db = lazyDb(deps);
  const logEvent = deps.logEventFn || lazyLogEvent(deps);

  const ownerResult = await db.query(`SELECT * FROM deleted_log_owners WHERE id = $1`, [
    deletedLogOwnerId,
  ]);
  const owner = ownerResult.rows[0];
  if (!owner) {
    const error = new Error("Recovery entry not found");
    error.statusCode = 404;
    throw error;
  }

  const column = owner.kind === "workspace" ? "workspace_id" : "agent_id";
  const outcome = await purgeAllLogsByColumn(column, owner.source_id, deps);
  await db.query(`DELETE FROM deleted_log_owners WHERE id = $1`, [deletedLogOwnerId]);

  await logEvent(
    "log_recovery_purged",
    `Admin ${actor?.id || "(unknown)"} purged kept logs for deleted ${owner.kind} ${owner.source_id}`,
    { deletedLogOwnerId, kind: owner.kind, sourceId: owner.source_id, actorId: actor?.id, ...outcome },
  );

  return { purged: true, ...outcome };
}

// ── Admin recovery: read path (item 5 / Functions list) ──────────────────
//
// See the module header's forward-reference note: real, minimal, and
// explicitly documented as an interim implementation Phase 6 should replace.

async function loadDeletedLogOwnerOrThrow(deletedLogOwnerId, deps) {
  const db = lazyDb(deps);
  const result = await db.query(`SELECT * FROM deleted_log_owners WHERE id = $1`, [
    deletedLogOwnerId,
  ]);
  const owner = result.rows[0];
  if (!owner) {
    const error = new Error("Recovery entry not found");
    error.statusCode = 404;
    throw error;
  }
  return owner;
}

async function loadOrderedSegmentsForOwner(owner, deps) {
  const db = lazyDb(deps);
  const column = owner.kind === "workspace" ? "workspace_id" : "agent_id";
  const result = await db.query(
    `SELECT id, storage_key, storage_backend, storage_config, ts_from, ts_to, stream
       FROM log_segments
      WHERE ${column} = $1
      ORDER BY ts_from ASC, id ASC`,
    [owner.source_id],
  );
  return result.rows || [];
}

async function readSegmentLines(segment, deps) {
  const getObj = deps.getStorageObject || objectStorage.getStorageObject;
  const resolveConfig = deps.storageConfigForSegment || logStorageConfigModule.storageConfigForSegment;
  const decryptSegment = deps.decryptSegment || segmentWriterModule.decryptSegment;
  const loadKeys = deps.loadLogEncryptionKeys || segmentWriterModule.loadLogEncryptionKeys;
  const zstdDecompressSync = deps.zstdDecompressSync || zlib.zstdDecompressSync;

  const config = await resolveConfig(segment);
  const raw = await getObj(segment.storage_key, config);
  const decrypted = decryptSegment(raw, deps.keyRing || loadKeys());
  const decompressed = zstdDecompressSync(decrypted);
  const text = decompressed.toString("utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Paginated log-line listing for `GET /admin/log-recovery/:id/logs`, scoped
 * by the `deleted_log_owners` row's `source_id` — never by a live-agent
 * access check, since there is no agent/workspace row left for one to
 * resolve against.
 *
 * Cursor shape: `"<segmentIndex>:<lineOffset>"` into the ts_from-ordered
 * segment list — an internal implementation detail of this minimal reader,
 * not a stable public contract (Phase 6's `encodeCursor`/`decodeCursor`
 * should replace it).
 *
 * @param {string} deletedLogOwnerId
 * @param {{limit?: number, cursor?: string|null}} [options]
 * @param {Object} [deps]
 * @returns {Promise<{owner: Object, lines: Array, nextCursor: string|null, totalSegments: number}>}
 */
async function listRecoveredLogLines(deletedLogOwnerId, options = {}, deps = {}) {
  const limit = options.limit ?? DEFAULT_RECOVERY_PAGE_LIMIT;
  const owner = await loadDeletedLogOwnerOrThrow(deletedLogOwnerId, deps);
  const segments = await loadOrderedSegmentsForOwner(owner, deps);

  let [segIndex, lineOffset] = options.cursor
    ? options.cursor.split(":").map((part) => Number(part) || 0)
    : [0, 0];

  const outLines = [];
  while (segIndex < segments.length && outLines.length < limit) {
    const lines = await readSegmentLines(segments[segIndex], deps);
    while (lineOffset < lines.length && outLines.length < limit) {
      outLines.push(lines[lineOffset]);
      lineOffset += 1;
    }
    if (lineOffset >= lines.length) {
      segIndex += 1;
      lineOffset = 0;
    }
  }

  const nextCursor = segIndex < segments.length ? `${segIndex}:${lineOffset}` : null;
  return { owner, lines: outLines, nextCursor, totalSegments: segments.length };
}

/**
 * Gather every recovered log line for export (CSV/NDJSON), bounded by
 * `MAX_EXPORT_LINES` (see module header — Phase 7's streamed export should
 * replace this bound entirely rather than raising it).
 *
 * @param {string} deletedLogOwnerId
 * @param {Object} [deps]
 * @returns {Promise<{owner: Object, lines: Array, truncated: boolean}>}
 */
async function collectAllRecoveredLogLines(deletedLogOwnerId, deps = {}) {
  let cursor = null;
  let owner = null;
  const lines = [];
  let truncated = false;
  for (;;) {
    const page = await listRecoveredLogLines(
      deletedLogOwnerId,
      { limit: DEFAULT_RECOVERY_PAGE_LIMIT, cursor },
      deps,
    );
    owner = page.owner;
    for (const line of page.lines) {
      if (lines.length >= MAX_EXPORT_LINES) {
        truncated = true;
        break;
      }
      lines.push(line);
    }
    if (truncated || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { owner, lines, truncated };
}

module.exports = {
  deleteAgentLogs,
  deleteWorkspaceLogs,
  snapshotDeletedLogOwner,
  purgeDeletedLogOwner,
  purgeAllLogsByColumn,
  listRecoveredLogLines,
  collectAllRecoveredLogLines,
  DEFAULT_RECOVERY_PAGE_LIMIT,
  MAX_EXPORT_LINES,
};
