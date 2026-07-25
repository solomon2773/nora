const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function normalizeBackendName(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return "docker";
  if (normalized.startsWith("k8s:")) return "k8s";
  if (normalized.startsWith("remote:")) return "remote-docker";
  if (["docker", "k8s", "remote-docker", "proxmox", "external"].includes(normalized)) {
    return normalized;
  }
  throw new Error(`Unknown deploy target: ${normalized}`);
}

function isKnownBackend(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized.startsWith("k8s:") ||
    normalized.startsWith("remote:") ||
    ["docker", "k8s", "remote-docker", "proxmox", "external"].includes(normalized)
  );
}

function normalizeExecutionTargetId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("k8s:")) return normalized;
  if (normalized.startsWith("remote:")) return normalized;
  return ["docker", "k8s", "remote-docker", "proxmox", "external"].includes(normalized)
    ? normalized
    : null;
}

function runtimeSelectionIssue(selection) {
  if (selection.runtimeFamily === "hermes" && selection.sandboxProfile === "nemoclaw") {
    return "Hermes does not support the NemoClaw sandbox profile.";
  }
  return null;
}

function loadWorkerForBackendSelectionTests() {
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

  class StubUnrecoverableError extends Error {
    constructor(message) {
      super(message);
      this.name = "UnrecoverableError";
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
        return { Worker: StubWorker, UnrecoverableError: StubUnrecoverableError };
      }
      if (request === "crypto") return originalLoad.apply(this, arguments);
      if (request === "ioredis") return function StubRedis() {};
      if (request === "pg") return { Pool: StubPool, Client: class StubClient {} };
      if (request === "http") return { createServer: () => ({ listen() {} }) };
      if (request === "../../backend-api/lib/connectionConfig") {
        return {
          buildPostgresConfig: () => ({}),
          createRedisClient: () => ({}),
        };
      }
      if (request === "../../agent-runtime/lib/backendCatalog") {
        return {
          getDefaultBackend: () => "docker",
          getEnabledBackends: () => ["docker"],
          isKnownBackend,
          normalizeBackendName,
          normalizeExecutionTargetId,
          runtimeSelectionIssue,
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

const {
  assertProvisionerRuntimeSelection,
  loadBackend,
  normalizeProvisionerDeployTarget,
  normalizeProvisionerExecutionTargetId,
  toUnrecoverableRuntimeSelectionError,
} = loadWorkerForBackendSelectionTests();

test("provisioner deploy-target parsing defaults only absent input to Docker", () => {
  for (const absent of [undefined, null, "", "   "]) {
    assert.equal(normalizeProvisionerDeployTarget(absent), null);
  }
  assert.equal(normalizeProvisionerDeployTarget("docker"), "docker");
  assert.equal(normalizeProvisionerDeployTarget("remote:build-host"), "remote-docker");
});

test("provisioner deploy-target parsing rejects nonempty unknown values", () => {
  assert.throws(
    () => normalizeProvisionerDeployTarget("moon", { field: "deployment job deploy target" }),
    (error) =>
      error.name === "UnrecoverableError" &&
      error.code === "UNKNOWN_DEPLOY_TARGET" &&
      error.message === "Unknown deployment job deploy target: moon",
  );
});

test("legacy backend-type aliases are allowed only through the explicit compatibility path", () => {
  assert.throws(
    () => normalizeProvisionerDeployTarget("hermes", { field: "deploy target" }),
    (error) => error.code === "UNKNOWN_DEPLOY_TARGET",
  );
  assert.equal(
    normalizeProvisionerDeployTarget("hermes", {
      field: "persisted backend type",
      allowLegacyBackendAlias: true,
    }),
    null,
  );
});

test("provisioner execution-target parsing rejects nonempty unknown values unrecoverably", () => {
  for (const absent of [undefined, null, "", "   "]) {
    assert.equal(normalizeProvisionerExecutionTargetId(absent), null);
  }
  assert.equal(normalizeProvisionerExecutionTargetId("remote:build-host"), "remote:build-host");
  assert.throws(
    () =>
      normalizeProvisionerExecutionTargetId("moon", {
        field: "deployment job execution target",
      }),
    (error) =>
      error.name === "UnrecoverableError" &&
      error.code === "UNKNOWN_DEPLOY_TARGET" &&
      error.message === "Unknown deployment job execution target: moon",
  );
});

test("all stable runtime-selection errors become unrecoverable worker failures", () => {
  for (const code of [
    "UNKNOWN_DEPLOY_TARGET",
    "UNKNOWN_RUNTIME_FAMILY",
    "UNKNOWN_SANDBOX_PROFILE",
    "RUNTIME_SELECTION_TARGET_MISMATCH",
  ]) {
    const source = Object.assign(new Error(`invalid ${code}`), { code, statusCode: 400 });
    const error = toUnrecoverableRuntimeSelectionError(source);
    assert.equal(error.name, "UnrecoverableError");
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 400);
    assert.equal(error.cause, source);
  }

  const retryable = Object.assign(new Error("temporary network failure"), {
    code: "ECONNRESET",
  });
  assert.equal(toUnrecoverableRuntimeSelectionError(retryable), retryable);
});

test("known but unsupported runtime tuples fail before adapter selection", () => {
  assert.throws(
    () =>
      assertProvisionerRuntimeSelection({
        runtime_family: "hermes",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "nemoclaw",
      }),
    (error) =>
      error.name === "UnrecoverableError" &&
      error.code === "INVALID_RUNTIME_SELECTION" &&
      error.statusCode === 400 &&
      /Hermes does not support the NemoClaw sandbox profile/.test(error.message),
  );
});

test("known but non-provisionable targets do not fall back to local Docker", async () => {
  await assert.rejects(
    loadBackend({
      runtime_family: "openclaw",
      deploy_target: "external",
      execution_target_id: "external",
      sandbox_profile: "standard",
      backend_type: "external",
    }),
    (error) =>
      error.name === "UnrecoverableError" &&
      error.code === "UNSUPPORTED_DEPLOY_TARGET" &&
      error.message === "Unsupported provisioner deploy target: external",
  );
});
