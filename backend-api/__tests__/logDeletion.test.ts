// @ts-nocheck
/**
 * __tests__/logDeletion.test.ts — Phase 5c of the logging control plane.
 *
 * This is a Jest-style, dependency-injected unit test of
 * workers/provisioner/logs/logDeletion.ts's exported functions themselves
 * (no HTTP layer, no module mocking) — complementary to:
 *   - workers/provisioner/logDeletion.test.js, the primary `node --test`
 *     suite for this same module (this package's established convention
 *     for workers/provisioner code), which also covers the retention-sweeper
 *     integration and a full encrypt/decrypt round trip for the recovery
 *     read path.
 *   - the "Phase 5c: deleteLogs contract" describe blocks added to
 *     agents.test.ts and workspaces.test.ts, which cover the HTTP-level
 *     delete-route contract (400 rejection, snapshot-before-delete
 *     ordering, async-cleanup wiring) with logDeletion.ts mocked out.
 *
 * Requiring the real (non-mocked) module here and passing fakes via `deps`
 * verifies the actual purge/snapshot logic backend-api's routes depend on.
 */
const {
  deleteAgentLogs,
  deleteWorkspaceLogs,
  snapshotDeletedLogOwner,
  purgeDeletedLogOwner,
} = require("../../workers/provisioner/logs/logDeletion.ts");

function fakeDb(overrides = {}) {
  const state = {
    segments: overrides.segments || [],
    spans: overrides.spans || [],
    legacyCopies: overrides.legacyCopies || [],
    deletedLogOwners: overrides.deletedLogOwners || [],
    workspaceLogSettings: overrides.workspaceLogSettings || new Map(),
  };
  const deletedSegmentIds = [];
  const deletedSpanIds = [];

  return {
    state,
    deletedSegmentIds,
    deletedSpanIds,
    query: jest.fn(async (sql, params = []) => {
      if (sql.includes("FROM workspace_log_settings")) {
        const settings = state.workspaceLogSettings.get(params[0]);
        if (!settings) return { rows: [] };
        const value = sql.includes("runtime_retention_days")
          ? settings.runtime_retention_days
          : settings.trace_retention_days;
        return { rows: value == null ? [] : [{ value }] };
      }
      if (sql.includes("FROM log_segment_legacy_copies lc") && sql.includes("ANY")) {
        const ids = params[0] || [];
        return {
          rows: state.legacyCopies
            .filter((lc) => ids.includes(lc.log_segment_id))
            .map((lc) => ({ ...lc, storage_key: `key-${lc.log_segment_id}` })),
        };
      }
      if (sql.includes("DELETE FROM log_segment_legacy_copies")) return { rows: [] };
      if (
        sql.includes("SELECT id, storage_key, storage_backend, storage_config FROM log_segments WHERE")
      ) {
        const column = sql.includes("workspace_id =") ? "workspace_id" : "agent_id";
        return {
          rows: state.segments.filter((s) => s[column] === params[0]),
        };
      }
      if (sql.includes("DELETE FROM log_segments WHERE id = ANY")) {
        deletedSegmentIds.push(...(params[0] || []));
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM agent_spans WHERE")) {
        const column = sql.includes("workspace_id =") ? "workspace_id" : "agent_id";
        const matched = state.spans.filter((s) => s[column] === params[0]);
        deletedSpanIds.push(...matched.map((s) => s.id));
        return { rows: matched, rowCount: matched.length };
      }
      if (sql.includes("INSERT INTO deleted_log_owners")) {
        const [kind, sourceId, displayName, ownerUserId, retentionDays, deletedByUserId] = params;
        const row = {
          id: `owner-${state.deletedLogOwners.length + 1}`,
          kind,
          source_id: sourceId,
          display_name: displayName,
          owner_user_id: ownerUserId,
          retention_days: retentionDays,
          deleted_by_user_id: deletedByUserId,
        };
        state.deletedLogOwners.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SELECT * FROM deleted_log_owners WHERE id = $1")) {
        const row = state.deletedLogOwners.find((o) => o.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("DELETE FROM deleted_log_owners WHERE id = $1")) {
        state.deletedLogOwners = state.deletedLogOwners.filter((o) => o.id !== params[0]);
        return { rows: [] };
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    }),
  };
}

function fakeDeleteStorageObjects() {
  return jest.fn(async (keys) => ({ deleted: [...keys], errors: [] }));
}

function fakeStorageConfigForSegment() {
  return jest.fn(async (row) => ({ storageBackend: row.storage_backend || "local" }));
}

async function fakeGetLogRetentionCeilingDays() {
  return 30;
}

describe("logDeletion.ts (Phase 5c)", () => {
  it("deleteAgentLogs removes only the target agent's segments and spans", async () => {
    const db = fakeDb({
      segments: [
        { id: "seg-a", agent_id: "agent-a", storage_key: "k-a", storage_backend: "local", storage_config: {} },
        { id: "seg-b", agent_id: "agent-b", storage_key: "k-b", storage_backend: "local", storage_config: {} },
      ],
      spans: [
        { id: "span-a", agent_id: "agent-a" },
        { id: "span-b", agent_id: "agent-b" },
      ],
    });

    const result = await deleteAgentLogs("agent-a", {
      db,
      deleteStorageObjects: fakeDeleteStorageObjects(),
      storageConfigForSegment: fakeStorageConfigForSegment(),
    });

    expect(result.deletedSegments).toBe(1);
    expect(result.deletedSpans).toBe(1);
    expect(db.deletedSegmentIds).toEqual(["seg-a"]);
    expect(db.deletedSpanIds).toEqual(["span-a"]);
  });

  it("deleteWorkspaceLogs scopes by workspace_id", async () => {
    const db = fakeDb({
      segments: [
        { id: "seg-ws", workspace_id: "ws-1", storage_key: "k-ws", storage_backend: "local", storage_config: {} },
      ],
    });

    const result = await deleteWorkspaceLogs("ws-1", {
      db,
      deleteStorageObjects: fakeDeleteStorageObjects(),
      storageConfigForSegment: fakeStorageConfigForSegment(),
    });

    expect(result.deletedSegments).toBe(1);
    expect(db.deletedSegmentIds).toEqual(["seg-ws"]);
  });

  it("snapshotDeletedLogOwner creates a deleted_log_owners row with the resolved retention snapshot, and leaves segments untouched", async () => {
    const db = fakeDb({
      segments: [
        { id: "seg-kept", agent_id: "agent-kept", storage_key: "k-kept", storage_backend: "local", storage_config: {} },
      ],
      workspaceLogSettings: new Map([["ws-1", { runtime_retention_days: 10, trace_retention_days: 10 }]]),
    });

    const row = await snapshotDeletedLogOwner(
      "agent",
      "agent-kept",
      { id: "user-1" },
      { displayName: "Kept Agent", ownerUserId: "user-1", workspaceId: "ws-1" },
      { db, getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays },
    );

    expect(row).toMatchObject({
      kind: "agent",
      source_id: "agent-kept",
      display_name: "Kept Agent",
      retention_days: 10,
      deleted_by_user_id: "user-1",
    });
    // Nothing about log_segments/agent_spans was touched.
    expect(db.deletedSegmentIds).toHaveLength(0);
  });

  it("purgeDeletedLogOwner removes segments/spans and the deleted_log_owners row itself", async () => {
    const db = fakeDb({
      segments: [
        { id: "seg-p", agent_id: "agent-p", storage_key: "k-p", storage_backend: "local", storage_config: {} },
      ],
      spans: [{ id: "span-p", agent_id: "agent-p" }],
      deletedLogOwners: [{ id: "owner-p", kind: "agent", source_id: "agent-p", retention_days: 30 }],
    });

    const result = await purgeDeletedLogOwner(
      "owner-p",
      { id: "admin-1" },
      {
        db,
        deleteStorageObjects: fakeDeleteStorageObjects(),
        storageConfigForSegment: fakeStorageConfigForSegment(),
        logEventFn: jest.fn(),
      },
    );

    expect(result.purged).toBe(true);
    expect(result.deletedSegments).toBe(1);
    expect(result.deletedSpans).toBe(1);
    expect(db.state.deletedLogOwners).toHaveLength(0);
  });

  it("purgeDeletedLogOwner rejects an unknown id with a 404-shaped error", async () => {
    const db = fakeDb();
    await expect(
      purgeDeletedLogOwner("missing", { id: "admin-1" }, { db, logEventFn: jest.fn() }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
