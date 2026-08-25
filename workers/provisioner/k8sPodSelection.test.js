const assert = require("node:assert/strict");
const test = require("node:test");

// The backend tree uses extensionless .ts requires, which only resolve under
// tsx — the same loader `npm start` runs the worker with. Registering it here
// keeps this test runnable by the plain `node --test "*.test.js"` harness.
require("tsx/cjs");

const K8sBackend = require("./backends/k8s.ts");

// A deleted pod keeps reporting phase Running until its containers exit, so
// selecting on phase alone can hand back the pod being torn down. Staging
// managed env updates the Deployment and, with strategy Recreate, starts a
// rollout — an exec issued right afterwards used to land in the dying
// container. The tracked-command wrapper died mid-write, leaving no pid state,
// and the surfaced error was "Provisioner command cleanup exited without
// confirmation (exit 70)", which says nothing about a rollout.
function makePod(name, { phase = "Running", ready = true, terminating = false } = {}) {
  return {
    metadata: {
      name,
      ...(terminating ? { deletionTimestamp: "2026-08-25T00:00:00Z" } : {}),
    },
    status: {
      phase,
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
    },
  };
}

function backendWithPods(pods) {
  const backend = Object.create(K8sBackend.prototype);
  backend.namespace = "openclaw-agents";
  backend._namespaceForDeployName = () => "openclaw-agents";
  backend._agentIdFromDeployName = () => "agent-1";
  backend.coreApi = {
    listNamespacedPod: async () => ({ items: pods }),
  };
  return backend;
}

const NO_WAIT = { waitMs: 0, intervalMs: 1 };

test("skips a terminating pod even though it still reports phase Running", async () => {
  const backend = backendWithPods([makePod("dying", { terminating: true })]);
  assert.equal(await backend._findRunningPod("deploy-1", "openclaw-agents", NO_WAIT), null);
});

test("prefers a ready pod over a running-but-unready one", async () => {
  const backend = backendWithPods([
    makePod("not-ready", { ready: false }),
    makePod("ready", { ready: true }),
  ]);
  const pod = await backend._findRunningPod("deploy-1", "openclaw-agents", NO_WAIT);
  assert.equal(pod.metadata.name, "ready");
});

test("picks the live pod when a terminating one is listed alongside it", async () => {
  const backend = backendWithPods([
    makePod("dying", { terminating: true }),
    makePod("live", { ready: true }),
  ]);
  const pod = await backend._findRunningPod("deploy-1", "openclaw-agents", NO_WAIT);
  assert.equal(pod.metadata.name, "live");
});

test("returns a running-but-unready pod immediately rather than waiting", async () => {
  // exec does not require readiness — callers routinely run before the runtime
  // has bound its port — so holding out for Ready would stall normal work. A
  // long wait here is what broke the kubernetes telemetry tests.
  const backend = backendWithPods([makePod("starting", { ready: false })]);
  const started = Date.now();
  const pod = await backend._findRunningPod("deploy-1", "openclaw-agents", {
    waitMs: 30000,
    intervalMs: 1000,
  });
  assert.equal(pod.metadata.name, "starting");
  assert.ok(Date.now() - started < 1000, "should not have waited for readiness");
});

test("ignores pods that are not Running at all", async () => {
  const backend = backendWithPods([makePod("pending", { phase: "Pending" })]);
  assert.equal(await backend._findRunningPod("deploy-1", "openclaw-agents", NO_WAIT), null);
});

test("waits for a rollout to produce a serving pod instead of failing instantly", async () => {
  const backend = Object.create(K8sBackend.prototype);
  backend.namespace = "openclaw-agents";
  backend._namespaceForDeployName = () => "openclaw-agents";
  backend._agentIdFromDeployName = () => "agent-1";
  let call = 0;
  backend.coreApi = {
    listNamespacedPod: async () => {
      call += 1;
      // Recreate has a window with no pod at all; the replacement appears later.
      return { items: call <= 3 ? [] : [makePod("replacement", { ready: true })] };
    },
  };
  const pod = await backend._findRunningPod("deploy-1", "openclaw-agents", {
    waitMs: 5000,
    intervalMs: 1,
  });
  assert.equal(pod.metadata.name, "replacement");
});
