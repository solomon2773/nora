// Phase 3 item 6: the graceful-shutdown coordinator added to worker.ts.
// Follows this repo's established pattern (see backendSelection.test.js,
// provisionerExecTermination.test.js) for loading worker.ts under Node's
// built-in test runner: stub every heavy/real dependency via a
// `Module._load` interception keyed on worker.ts's own filename, then pull
// just the functions under test off its exports.
const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function loadWorkerForShutdownTests() {
  const originalLoad = Module._load;
  const originalLog = console.log;
  const workerSuffix = "/workers/provisioner/worker.ts";
  const noop = () => undefined;
  const genericModule = new Proxy({}, { get: () => noop });

  class StubWorker {
    on() {}

    isRunning() {
      return true;
    }
  }

  class StubPool {
    async query() {
      return { rows: [] };
    }
  }

  Module._load = function loadWorkerDependency(request, parent) {
    if (parent?.filename?.endsWith(workerSuffix)) {
      if (request === "bullmq") {
        return { Worker: StubWorker, UnrecoverableError: class UnrecoverableError extends Error {} };
      }
      if (request === "crypto") return originalLoad.apply(this, arguments);
      if (request === "ioredis") return function StubRedis() {};
      if (request === "pg") return { Pool: StubPool, Client: class StubClient {} };
      if (request === "http") return { createServer: () => ({ listen() {} }) };
      if (request === "../../backend-api/lib/connectionConfig") {
        return { buildPostgresConfig: () => ({}), createRedisClient: () => ({}) };
      }
      if (request === "../../agent-runtime/lib/backendCatalog") {
        return {
          getDefaultBackend: () => "docker",
          getEnabledBackends: () => ["docker"],
          isKnownBackend: () => true,
          normalizeBackendName: (value) => value,
          normalizeExecutionTargetId: (value) => value,
          runtimeSelectionIssue: () => null,
        };
      }
      if (request.startsWith(".")) return genericModule;
    }
    return originalLoad.apply(this, arguments);
  };

  console.log = noop;
  try {
    return require("./worker.ts");
  } finally {
    console.log = originalLog;
    Module._load = originalLoad;
  }
}

const { registerShutdownCoordinator } = loadWorkerForShutdownTests();

function fakeProcess() {
  const handlers = {};
  return {
    exitCalls: [],
    on(event, handler) {
      handlers[event] = handler;
    },
    emit(event) {
      handlers[event]();
    },
    exit(code) {
      this.exitCalls.push(code);
    },
  };
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

test("SIGTERM flushes all open buffers before exit, via the shutdown coordinator", async () => {
  const proc = fakeProcess();
  const flushAllCalls = [];
  const writer = {
    flushAll: async () => {
      flushAllCalls.push(1);
      return [{ key: "agent-1:runtime", lines: 3 }];
    },
  };
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: writer,
    deadlineMs: 1000,
    logger: silentLogger(),
    onShutdownComplete: (info) => {
      completed(info);
    },
  });

  proc.emit("SIGTERM");
  const info = await done;
  assert.equal(flushAllCalls.length, 1);
  assert.equal(info.deadlineHit, false);
  assert.deepEqual(proc.exitCalls, [0]);
});

test("SIGINT also triggers the same shutdown path", async () => {
  const proc = fakeProcess();
  const writer = { flushAll: async () => [] };
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: writer,
    deadlineMs: 1000,
    logger: silentLogger(),
    onShutdownComplete: (info) => completed(info),
  });

  proc.emit("SIGINT");
  await done;
  assert.deepEqual(proc.exitCalls, [0]);
});

test("shutdown proceeds and exits even when a flush exceeds the bounded deadline, logging a warning", async () => {
  const proc = fakeProcess();
  const warnings = [];
  const logger = { log: () => {}, warn: (msg) => warnings.push(msg), error: () => {} };
  // A flush that never resolves within the test's lifetime.
  const writer = { flushAll: () => new Promise(() => {}) };
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: writer,
    deadlineMs: 20,
    logger,
    onShutdownComplete: (info) => completed(info),
  });

  proc.emit("SIGTERM");
  const info = await done;
  assert.equal(info.deadlineHit, true);
  assert.ok(warnings.some((w) => w.includes("did not complete within")));
  assert.deepEqual(proc.exitCalls, [0], "process exits regardless of the unresolved flush");
});

test("stop-hooks for the collector/reconciler are called when present, and skipped when absent", async () => {
  const proc = fakeProcess();
  const calls = [];
  const writer = { flushAll: async () => [] };
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: writer,
    getLogPipelineHooks: () => ({
      stopCollector: async () => calls.push("collector"),
      stopReconciler: async () => calls.push("reconciler"),
    }),
    deadlineMs: 1000,
    logger: silentLogger(),
    onShutdownComplete: (info) => completed(info),
  });

  proc.emit("SIGTERM");
  await done;
  assert.deepEqual(calls, ["reconciler", "collector"]);
});

test("a missing segment writer or missing hooks do not crash shutdown", async () => {
  const proc = fakeProcess();
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: null,
    getLogPipelineHooks: () => ({}),
    deadlineMs: 1000,
    logger: silentLogger(),
    onShutdownComplete: (info) => completed(info),
  });

  proc.emit("SIGTERM");
  const info = await done;
  assert.equal(info.deadlineHit, false);
  assert.deepEqual(proc.exitCalls, [0]);
});

test("a second signal while already shutting down is a no-op (doesn't double-exit)", async () => {
  const proc = fakeProcess();
  let resolveFlush;
  const writer = {
    flushAll: () =>
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
  };
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: writer,
    deadlineMs: 1000,
    logger: silentLogger(),
    onShutdownComplete: (info) => completed(info),
  });

  proc.emit("SIGTERM");
  proc.emit("SIGINT"); // should be ignored — shutdown already in progress
  resolveFlush([]);
  await done;
  assert.deepEqual(proc.exitCalls, [0]);
});

test("the coordinator prefers the writer's shutdown() over a bare flushAll()", async () => {
  const proc = fakeProcess();
  const calls = [];
  const writer = {
    shutdown: async () => {
      calls.push("shutdown");
      return [];
    },
    flushAll: async () => {
      calls.push("flushAll");
      return [];
    },
  };
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });

  registerShutdownCoordinator({
    process: proc,
    segmentWriter: writer,
    deadlineMs: 1000,
    logger: silentLogger(),
    onShutdownComplete: (info) => completed(info),
  });

  proc.emit("SIGTERM");
  const info = await done;
  assert.deepEqual(calls, ["shutdown"]);
  assert.equal(info.deadlineHit, false);
  assert.deepEqual(proc.exitCalls, [0]);
});
