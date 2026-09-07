// Phase 6 item 7 (logging control plane): the internal
// GET /internal/log-buffer endpoint added to worker.ts's existing
// health-check HTTP server, which backend-api's searchLogs() calls to close
// the recency gap. Follows this repo's established pattern (see
// shutdownCoordinator.test.js) for loading worker.ts under Node's built-in
// test runner: stub every heavy/real dependency via a `Module._load`
// interception keyed on worker.ts's own filename, then pull just the
// functions under test off its exports.
const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function loadWorkerForInternalEndpointTests() {
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
    const rest = Array.prototype.slice.call(arguments, 1);
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
      // Unlike shutdownCoordinator.test.js (which never touches
      // segmentWriter's real implementation), these tests exercise the
      // REAL createSegmentWriter()/peekBuffer() logic, so the log-pipeline
      // modules must NOT be stubbed to the generic no-op proxy — only the
      // heavier, irrelevant-here provisioning modules are. Falls through to
      // the generic extensionless-`.ts` fixup below instead of being
      // resolved here directly.
      if (request !== "./logs/segmentWriter" && request !== "./logs/logCollector" && request.startsWith(".")) {
        return genericModule;
      }
    }
    // Generic fixup: this repo's convention is extensionless relative
    // requires resolved by tsx/ts-node/ts-jest at runtime, none of which
    // this bare `node --test` harness has. Requiring the REAL
    // segmentWriter.ts pulls in a transitive chain (logStorageConfig.ts →
    // backend-api/db.ts → lib/connectionConfig, etc.) that plain Node
    // cannot resolve without the sibling `.ts` extension — so retry with it
    // appended on a MODULE_NOT_FOUND, mirroring what those loaders do.
    if (request.startsWith(".") && !/\.(ts|js|json|node)$/.test(request)) {
      try {
        return originalLoad.apply(this, [request, ...rest]);
      } catch (error) {
        if (error && error.code === "MODULE_NOT_FOUND") {
          return originalLoad.apply(this, [`${request}.ts`, ...rest]);
        }
        throw error;
      }
    }
    return originalLoad.apply(this, [request, ...rest]);
  };

  console.log = noop;
  try {
    return require("./worker.ts");
  } finally {
    console.log = originalLog;
    Module._load = originalLoad;
  }
}

const { isAuthorizedInternalRequest, handleInternalLogBufferRequest, segmentWriter } =
  loadWorkerForInternalEndpointTests();

function fakeRes() {
  const chunks = [];
  let statusCode = null;
  let headers = null;
  return {
    writeHead(code, h) {
      statusCode = code;
      headers = h;
    },
    end(body) {
      chunks.push(body);
    },
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

test("isAuthorizedInternalRequest rejects a missing or wrong shared secret", () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "correct-secret-value";
  try {
    assert.equal(isAuthorizedInternalRequest({ headers: {} }), false);
    assert.equal(
      isAuthorizedInternalRequest({ headers: { "x-nora-internal-key": "wrong" } }),
      false,
    );
    assert.equal(
      isAuthorizedInternalRequest({ headers: { "x-nora-internal-key": "correct-secret-value" } }),
      true,
    );
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test("isAuthorizedInternalRequest rejects everything when JWT_SECRET is unset", () => {
  const originalSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.equal(isAuthorizedInternalRequest({ headers: { "x-nora-internal-key": "" } }), false);
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test("handleInternalLogBufferRequest returns 401 without the shared secret", () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "s3cret";
  try {
    const res = fakeRes();
    handleInternalLogBufferRequest(
      { headers: {}, url: "/internal/log-buffer?agentId=a&stream=runtime" },
      res,
    );
    assert.equal(res.statusCode, 401);
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test("handleInternalLogBufferRequest returns 400 when agentId/stream are missing", () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "s3cret";
  try {
    const res = fakeRes();
    handleInternalLogBufferRequest(
      { headers: { "x-nora-internal-key": "s3cret" }, url: "/internal/log-buffer" },
      res,
    );
    assert.equal(res.statusCode, 400);
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test("handleInternalLogBufferRequest returns found: false for an empty buffer", () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "s3cret";
  try {
    const res = fakeRes();
    handleInternalLogBufferRequest(
      {
        headers: { "x-nora-internal-key": "s3cret" },
        url: "/internal/log-buffer?agentId=nonexistent-agent&stream=runtime",
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { found: false });
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test("handleInternalLogBufferRequest returns the buffered lines when present, without flushing", async () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "s3cret";
  try {
    await segmentWriter.append(
      { agentId: "agent-internal-test", stream: "runtime", ownerUserId: "user-1" },
      [
        {
          ts: "2026-01-01T00:00:00.000Z",
          observed_ts: "2026-01-01T00:00:00.010Z",
          ts_source: "source",
          stream: "runtime",
          level: "INFO",
          message: "buffered line",
        },
      ],
    );

    const res = fakeRes();
    handleInternalLogBufferRequest(
      {
        headers: { "x-nora-internal-key": "s3cret" },
        url: "/internal/log-buffer?agentId=agent-internal-test&stream=runtime",
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.found, true);
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].message, "buffered line");
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});
