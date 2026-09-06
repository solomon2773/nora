// Phase 4 of the logging control plane: log collector tests.
//
// Follows this package's established convention (segmentWriter.test.js) —
// Node's built-in test runner, fakes/mocks passed in via `deps` rather than
// module-level jest.mock, deterministic (no real timers: reconcileStreams()
// is called directly rather than waiting on the 30s interval).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

// logCollector.ts pulls in agent-runtime/lib/agentRuntimeFields.ts, whose own
// internal requires (`./backendCatalog`, etc.) are extensionless TS files —
// fine under `tsx` (this package's real runtime) but not plain Node's
// resolver. Registering tsx's require hook (already a dependency here, and
// the same fix this package's dockerLogsTail.test.js/k8sLogsTail.test.js use
// for the same reason) makes this require exactly what `tsx worker.ts` does
// in production.
require("tsx/cjs");

const { createLogCollector, resolveTenantForAgent } = require("./logs/logCollector.ts");

// ── Fakes ──────────────────────────────────────────────────────────────

class FakeLogStream extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  destroy() {
    this.destroyed = true;
  }
}

function agentRow(overrides = {}) {
  return {
    id: "agent-1",
    user_id: "user-1",
    container_id: "container-1",
    status: "running",
    backend_type: "docker",
    deploy_target: "docker",
    execution_target_id: "docker",
    runtime_family: "openclaw",
    sandbox_profile: "standard",
    ...overrides,
  };
}

/**
 * A minimal fake db whose `query` dispatches on which SQL shape is asked
 * for, backed by plain JS state a test can mutate directly:
 *   - `agents`: array of agent rows the "list running agents" query returns
 *   - `workspaceMembership`: Map<agentId, workspaceId|undefined>
 *   - `agentOwners`: Map<agentId, userId>
 *   - `segments`: array of `{ agent_id, stream, ts_to }` — backs the
 *     MAX(ts_to) last-flushed-cursor lookup
 */
function fakeDb({ agents = [], workspaceMembership = new Map(), agentOwners = new Map(), segments = [] } = {}) {
  const calls = [];
  const state = { agents, workspaceMembership, agentOwners, segments };
  return {
    calls,
    get agents() {
      return state.agents;
    },
    set agents(value) {
      state.agents = value;
    },
    workspaceMembership: state.workspaceMembership,
    agentOwners: state.agentOwners,
    segments: state.segments,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM agents\s+WHERE status IN/.test(sql)) {
        return {
          rows: state.agents.filter((a) => ["running", "warning"].includes(a.status) && a.container_id),
        };
      }
      if (/FROM workspace_agents WHERE agent_id/.test(sql)) {
        const [agentId] = params;
        const workspaceId = workspaceMembership.get(agentId);
        return { rows: workspaceId ? [{ workspace_id: workspaceId }] : [] };
      }
      if (/SELECT user_id FROM agents WHERE id/.test(sql)) {
        const [agentId] = params;
        const userId = agentOwners.get(agentId);
        return { rows: userId ? [{ user_id: userId }] : [] };
      }
      if (/MAX\(ts_to\)/.test(sql)) {
        const [agentId, stream] = params;
        const matching = segments.filter((s) => s.agent_id === agentId && s.stream === stream);
        if (matching.length === 0) return { rows: [{ cursor: null }] };
        const max = matching.reduce((a, b) => (a.ts_to > b.ts_to ? a : b));
        return { rows: [{ cursor: max.ts_to }] };
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    },
  };
}

function fakeSegmentWriter({ capacityPausedAgents = new Set() } = {}) {
  const appendCalls = [];
  return {
    appendCalls,
    capacityPausedAgents,
    async append(agentCtx, lines) {
      appendCalls.push({ agentCtx, lines });
      return { appended: lines.length, dropped: 0 };
    },
    isCapacityPaused(agentId, stream) {
      return capacityPausedAgents.has(`${agentId}:${stream}`);
    },
  };
}

function fakeContainerManager(logsImpl) {
  const calls = [];
  return {
    calls,
    async logs(agent, opts) {
      calls.push({ agent, opts });
      return logsImpl(agent, opts);
    },
  };
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function baseDeps(overrides = {}) {
  return {
    db: fakeDb(),
    containerManager: fakeContainerManager(async () => new FakeLogStream()),
    segmentWriter: fakeSegmentWriter(),
    logStorageConfig: async () => ({ storageBackend: "local" }),
    logger: silentLogger(),
    ...overrides,
  };
}

// ── reconcileStreams: start / stop ───────────────────────────────────────

test("reconcile starts a stream for a newly-running agent and stops one for a now-stopped agent", async () => {
  const streamA = new FakeLogStream();
  const db = fakeDb({ agents: [agentRow({ id: "agent-a" })] });
  const containerManager = fakeContainerManager(async () => streamA);
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await collector.reconcileStreams();
  assert.equal(collector.heldStreamCount(), 1);
  assert.equal(streamA.destroyed, false);

  // Agent stops: no longer in the running/warning set.
  db.agents = [];
  await collector.reconcileStreams();

  assert.equal(collector.heldStreamCount(), 0);
  assert.equal(streamA.destroyed, true, "the stream must be disconnected once the agent is no longer desired");
});

// ── reattach on dead stream ───────────────────────────────────────────────

test("a dead stream (after end/error) is reattached on the next reconcile tick", async () => {
  const firstStream = new FakeLogStream();
  const secondStream = new FakeLogStream();
  let attachCount = 0;
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => {
    attachCount += 1;
    return attachCount === 1 ? firstStream : secondStream;
  });
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await collector.reconcileStreams();
  assert.equal(attachCount, 1);

  firstStream.emit("end");
  await collector.reconcileStreams();

  assert.equal(attachCount, 2, "a dead stream must trigger a fresh attach on the next tick");
  assert.equal(collector.heldStreamCount(), 1);
});

test("a stream that errors is also reattached on the next tick", async () => {
  const firstStream = new FakeLogStream();
  const secondStream = new FakeLogStream();
  let attachCount = 0;
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => {
    attachCount += 1;
    return attachCount === 1 ? firstStream : secondStream;
  });
  const collector = createLogCollector(baseDeps({ db, containerManager, logger: silentLogger() }));

  await collector.reconcileStreams();
  firstStream.emit("error", new Error("boom"));
  await collector.reconcileStreams();

  assert.equal(attachCount, 2);
});

// ── since / cursor semantics ──────────────────────────────────────────────

test("reattach passes since derived from the last FLUSHED cursor, not merely the last line seen", async () => {
  const db = fakeDb({
    agents: [agentRow()],
    segments: [{ agent_id: "agent-1", stream: "runtime", ts_to: "2026-01-01T00:15:00.000Z" }],
  });
  const containerManager = fakeContainerManager(async () => new FakeLogStream());
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await collector.reconcileStreams();

  assert.equal(containerManager.calls.length, 1);
  assert.equal(containerManager.calls[0].opts.since, "2026-01-01T00:15:00.000Z");
  // No `tail` — omitting it is what makes the adapters return the full
  // available log on reconnect (Phase 4 item 2b), rather than the last 100
  // lines.
  assert.equal(Object.prototype.hasOwnProperty.call(containerManager.calls[0].opts, "tail"), false);
});

test("first-ever attach (no prior flush) omits since entirely", async () => {
  const db = fakeDb({ agents: [agentRow()] }); // no segments
  const containerManager = fakeContainerManager(async () => new FakeLogStream());
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await collector.reconcileStreams();

  assert.equal(Object.prototype.hasOwnProperty.call(containerManager.calls[0].opts, "since"), false);
});

// ── killing the worker mid-window loses no lines (crash-replay) ──────────

test("killing the worker mid-window loses no lines: restart replays from the last flushed cursor into the same storage_key", async () => {
  const {
    createSegmentWriter,
    buildStorageKey,
  } = require("./logs/segmentWriter.ts");

  // Shared fake Postgres + fake object store standing in for "the durable
  // state that survives a worker restart" — segmentWriter and logCollector
  // each get their OWN in-memory instance below (simulating two independent
  // process lifetimes), but both read/write this same durable backing.
  const durableSegments = []; // simulates the log_segments table
  const objectStore = new Map(); // simulates the storage backend
  function durableDb() {
    return {
      async query(sql, params) {
        if (/INSERT INTO log_segments/.test(sql)) {
          const [, , stream, tsFrom, tsTo, storageKey] = params;
          const existingIndex = durableSegments.findIndex((s) => s.storage_key === storageKey);
          const row = { stream, ts_from: tsFrom, ts_to: tsTo, storage_key: storageKey };
          if (existingIndex >= 0) durableSegments[existingIndex] = row;
          else durableSegments.push(row);
          return { rows: [{ id: "row-1" }] };
        }
        if (/MAX\(ts_to\)/.test(sql)) {
          const [agentId, stream] = params;
          const matching = durableSegments.filter((s) => s.stream === stream);
          if (matching.length === 0) return { rows: [{ cursor: null }] };
          const max = matching.reduce((a, b) => (a.ts_to > b.ts_to ? a : b));
          return { rows: [{ cursor: max.ts_to }] };
        }
        if (/FROM workspace_agents/.test(sql)) return { rows: [] };
        if (/SELECT user_id FROM agents/.test(sql)) return { rows: [{ user_id: "user-1" }] };
        throw new Error(`durableDb: unhandled query: ${sql}`);
      },
    };
  }
  const keyRing = { keys: new Map([["k1", Buffer.alloc(32, 1)]]), currentKeyId: "k1" };
  async function putStorageObject(key, buffer) {
    objectStore.set(key, buffer);
  }

  function bootProcess() {
    const writer = createSegmentWriter({
      db: durableDb(),
      putStorageObject,
      logStorageConfig: async () => ({ storageBackend: "local" }),
      keyRing,
      checkLocalCapacity: () => ({ usedBytes: 0, limitBytes: Infinity, atCapacity: false }),
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
    const agents = [agentRow()];
    const collector = createLogCollector({
      db: {
        query: async (sql, params) => {
          if (/FROM agents\s+WHERE status IN/.test(sql)) return { rows: agents };
          return durableDb().query(sql, params);
        },
      },
      containerManager: fakeContainerManager(async () => new FakeLogStream()),
      segmentWriter: writer,
      logStorageConfig: async () => ({ storageBackend: "local" }),
      logger: silentLogger(),
    });
    return { writer, collector };
  }

  // "Process 1": attaches, ingests lines, then dies WITHOUT flushing.
  const proc1 = bootProcess();
  await proc1.collector.reconcileStreams();
  // Feed lines directly through the writer the way the collector would.
  await proc1.writer.append(
    { agentId: "agent-1", stream: "runtime", workspaceId: null, ownerUserId: "user-1" },
    [
      { ts: "2026-01-01T00:00:00.000Z", observed_ts: "2026-01-01T00:00:00.000Z", ts_source: "source", level: "INFO", message: "line-1" },
      { ts: "2026-01-01T00:00:01.000Z", observed_ts: "2026-01-01T00:00:01.000Z", ts_source: "source", level: "INFO", message: "line-2" },
    ],
  );
  // Process dies here — no flush call, no SIGTERM. durableSegments stays empty.
  assert.equal(durableSegments.length, 0);

  // "Process 2": fresh writer, fresh collector, same durable backing. The
  // source (Docker json-file / kubelet) is simulated by replaying the SAME
  // lines again on reattach, since a real source would still hold them.
  const proc2 = bootProcess();
  await proc2.collector.reconcileStreams();
  await proc2.writer.append(
    { agentId: "agent-1", stream: "runtime", workspaceId: null, ownerUserId: "user-1" },
    [
      { ts: "2026-01-01T00:00:00.000Z", observed_ts: "2026-01-01T00:00:00.000Z", ts_source: "source", level: "INFO", message: "line-1" },
      { ts: "2026-01-01T00:00:01.000Z", observed_ts: "2026-01-01T00:00:01.000Z", ts_source: "source", level: "INFO", message: "line-2" },
    ],
  );
  const flushResult = await proc2.writer.flush("agent-1:runtime");

  assert.equal(flushResult.skipped, false);
  assert.equal(durableSegments.length, 1, "the recovered flush must upsert the SAME storage_key, not create a second segment");
  assert.equal(
    durableSegments[0].storage_key,
    buildStorageKey({ ownerUserId: "user-1" }, "agent-1", "runtime", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"),
  );
});

// ── null return handling (item 3) ────────────────────────────────────────

test("a null return from containerManager.logs() is handled without throwing or retry-storming", async () => {
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => null);
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await assert.doesNotReject(collector.reconcileStreams());
  assert.equal(collector.heldStreamCount(), 0);

  // Next tick tries again (not suppressed) — this is a normal, expected
  // per-tick outcome, not a terminal failure to remember.
  await assert.doesNotReject(collector.reconcileStreams());
  assert.equal(containerManager.calls.length, 2);
});

test("an attach that throws is swallowed, not a retry-storm crash", async () => {
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => {
    throw new Error("attach unavailable");
  });
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await assert.doesNotReject(collector.reconcileStreams());
  assert.equal(collector.heldStreamCount(), 0);
});

// ── tenant resolution (item 5 / 8 / 9) ────────────────────────────────────

test("the tenant is resolved exactly once per stream attach, not once per line", async () => {
  const db = fakeDb({
    agents: [agentRow()],
    workspaceMembership: new Map([["agent-1", "ws-1"]]),
  });
  const stream = new FakeLogStream();
  const containerManager = fakeContainerManager(async () => stream);
  const segmentWriter = fakeSegmentWriter();
  const collector = createLogCollector(baseDeps({ db, containerManager, segmentWriter }));

  await collector.reconcileStreams();
  const workspaceLookupsBefore = db.calls.filter((c) => /FROM workspace_agents/.test(c.sql)).length;
  assert.equal(workspaceLookupsBefore, 1);

  // Emit several lines — resolveTenantForAgent must not be re-queried per line.
  stream.emit("data", Buffer.from("2026-01-01T00:00:00.000Z line one\n"));
  stream.emit("data", Buffer.from("2026-01-01T00:00:01.000Z line two\n"));
  stream.emit("data", Buffer.from("2026-01-01T00:00:02.000Z line three\n"));
  await new Promise((resolve) => setImmediate(resolve));

  const workspaceLookupsAfter = db.calls.filter((c) => /FROM workspace_agents/.test(c.sql)).length;
  assert.equal(workspaceLookupsAfter, 1, "resolveTenantForAgent must not run per line");
  assert.equal(segmentWriter.appendCalls.length, 3);
  for (const call of segmentWriter.appendCalls) {
    assert.equal(call.agentCtx.workspaceId, "ws-1");
  }
});

test("an agent with no workspace membership writes under user_<userId>/", async () => {
  const db = fakeDb({
    agents: [agentRow({ id: "agent-solo", user_id: "user-solo" })],
    agentOwners: new Map([["agent-solo", "user-solo"]]),
  });
  const tenant = await resolveTenantForAgent("agent-solo", { db });
  assert.equal(tenant.kind, "user");
  assert.equal(tenant.ownerUserId, "user-solo");
  assert.equal(tenant.workspaceId, null);

  const { buildStorageKey } = require("./logs/segmentWriter.ts");
  const key = buildStorageKey(
    { ownerUserId: tenant.ownerUserId },
    "agent-solo",
    "runtime",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:15:00.000Z",
  );
  assert.match(key, /^user_user-solo\//);
});

test("re-resolves the tenant on every reconnect, picking up a mid-life workspace reassignment", async () => {
  const db = fakeDb({
    agents: [agentRow()],
    workspaceMembership: new Map(), // starts with no workspace
  });
  const firstStream = new FakeLogStream();
  const secondStream = new FakeLogStream();
  let attachCount = 0;
  const containerManager = fakeContainerManager(async () => {
    attachCount += 1;
    return attachCount === 1 ? firstStream : secondStream;
  });
  const segmentWriter = fakeSegmentWriter();
  const collector = createLogCollector(baseDeps({ db, containerManager, segmentWriter }));

  await collector.reconcileStreams();
  firstStream.emit("data", Buffer.from("2026-01-01T00:00:00.000Z before reassignment\n"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(segmentWriter.appendCalls[0].agentCtx.workspaceId, null);

  // Mid-life reassignment, then the stream dies and reattaches.
  db.workspaceMembership.set("agent-1", "ws-new");
  firstStream.emit("end");
  await collector.reconcileStreams();
  secondStream.emit("data", Buffer.from("2026-01-01T00:00:01.000Z after reassignment\n"));
  await new Promise((resolve) => setImmediate(resolve));

  const afterCall = segmentWriter.appendCalls.find((c) => c.lines[0].message === "after reassignment");
  assert.equal(afterCall.agentCtx.workspaceId, "ws-new");
});

// ── storage_unsupported_for_target (item 3a) ──────────────────────────────

test("skips a k8s agent when the storage driver is local, silently after the first tick", async () => {
  const db = fakeDb({ agents: [agentRow({ id: "agent-k8s", backend_type: "k8s", deploy_target: "k8s" })] });
  const containerManager = fakeContainerManager(async () => new FakeLogStream());
  const warnings = [];
  const logger = { log: () => {}, warn: (msg) => warnings.push(msg), error: () => {} };
  const collector = createLogCollector(
    baseDeps({ db, containerManager, logger, logStorageConfig: async () => ({ storageBackend: "local" }) }),
  );

  await collector.reconcileStreams();
  await collector.reconcileStreams();
  await collector.reconcileStreams();

  assert.equal(collector.heldStreamCount(), 0);
  assert.equal(containerManager.calls.length, 0, "a k8s agent must never be attached while storage is local");
  const skipWarnings = warnings.filter((w) => w.includes("storage_unsupported_for_target"));
  assert.equal(skipWarnings.length, 1, "the skip must be logged once, not once per tick");
});

test("does not skip a k8s agent once the storage driver is not local", async () => {
  const db = fakeDb({ agents: [agentRow({ id: "agent-k8s", backend_type: "k8s", deploy_target: "k8s" })] });
  const containerManager = fakeContainerManager(async () => new FakeLogStream());
  const collector = createLogCollector(
    baseDeps({ db, containerManager, logStorageConfig: async () => ({ storageBackend: "s3" }) }),
  );

  await collector.reconcileStreams();

  assert.equal(collector.heldStreamCount(), 1);
});

// ── capacity-paused disconnect / resume (item 7) ─────────────────────────

test("a capacity-paused stream is disconnected cleanly, not held open buffering", async () => {
  const stream = new FakeLogStream();
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => stream);
  const segmentWriter = fakeSegmentWriter();
  const collector = createLogCollector(baseDeps({ db, containerManager, segmentWriter }));

  await collector.reconcileStreams();
  assert.equal(collector.heldStreamCount(), 1);
  assert.equal(stream.destroyed, false);

  segmentWriter.capacityPausedAgents.add("agent-1:runtime");
  await collector.reconcileStreams();

  assert.equal(collector.heldStreamCount(), 0);
  assert.equal(stream.destroyed, true, "capacity-paused must disconnect the stream, not merely stop reading it");
});

test("capacity clearing lets the reconciler re-attach the stream on the next tick, with no manual intervention", async () => {
  const streamA = new FakeLogStream();
  const streamB = new FakeLogStream();
  let attachCount = 0;
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => {
    attachCount += 1;
    return attachCount === 1 ? streamA : streamB;
  });
  const segmentWriter = fakeSegmentWriter({ capacityPausedAgents: new Set(["agent-1:runtime"]) });
  const collector = createLogCollector(baseDeps({ db, containerManager, segmentWriter }));

  await collector.reconcileStreams();
  assert.equal(collector.heldStreamCount(), 0, "starts paused — never attaches while capacity is exceeded");

  segmentWriter.capacityPausedAgents.delete("agent-1:runtime");
  await collector.reconcileStreams();

  assert.equal(collector.heldStreamCount(), 1);
  assert.equal(attachCount, 1, "the FIRST attach happens only once capacity clears");
});

// ── shutdown wiring (item 6 / 10) ─────────────────────────────────────────

test("stopReconciler stops new attaches; stopCollector disconnects everything currently held", async () => {
  const stream = new FakeLogStream();
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => stream);
  const collector = createLogCollector(baseDeps({ db, containerManager }));

  await collector.reconcileStreams();
  assert.equal(collector.heldStreamCount(), 1);

  collector.stopReconciler();
  await collector.reconcileStreams(); // must be a no-op now
  assert.equal(collector.heldStreamCount(), 1, "stopReconciler alone must not tear down an already-held stream");
  assert.equal(stream.destroyed, false);

  collector.stopCollector();
  assert.equal(collector.heldStreamCount(), 0);
  assert.equal(stream.destroyed, true);
});

test("collector shutdown does not interfere with the segment writer's flushAll()", async () => {
  const flushAllCalls = [];
  const writer = {
    isCapacityPaused: () => false,
    append: async () => ({ appended: 0, dropped: 0 }),
    flushAll: async () => {
      flushAllCalls.push(1);
      return [];
    },
  };
  const db = fakeDb({ agents: [agentRow()] });
  const containerManager = fakeContainerManager(async () => new FakeLogStream());
  const collector = createLogCollector(baseDeps({ db, containerManager, segmentWriter: writer }));

  await collector.reconcileStreams();
  collector.stop();
  await writer.flushAll();

  assert.equal(flushAllCalls.length, 1);
  assert.equal(collector.heldStreamCount(), 0);
});
