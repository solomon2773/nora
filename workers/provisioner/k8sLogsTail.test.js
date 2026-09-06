// Logging control plane Phase 4 item 2b regression guard: K8sBackend.logs
// must treat an absent `opts.tail` as "all available lines" from the
// kubelet (by omitting `tailLines` from the request entirely), not the old
// `opts.tail || 100` default. Mirrors dockerLogsTail.test.js's approach and
// rationale — see that file's header comment for why `tsx/cjs` is required
// before loading k8s.ts's real code under plain `node --test`.
const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

require("tsx/cjs");

// @kubernetes/client-node's compiled CJS re-exports `Log` via a getter-only
// property (the usual TS `__exportStar` shape), so `moduleObject.Log = Fake`
// silently no-ops rather than throwing — a real `k8s.Log` still gets
// constructed at call time, which then fails against an unconfigured
// KubeConfig instead of exercising our fake. Swap the whole module out via
// `Module._load`, scoped to k8s.ts's own require of it (same technique as
// this package's shutdownCoordinator.test.js uses for worker.ts's
// dependencies), so k8s.ts sees the fake `Log` class from the moment it
// requires the package.
// k8s.ts's `const k8s = require("@kubernetes/client-node")` runs exactly
// once (module caching) the first time k8s.ts itself is required, so the
// object it binds `k8s` to must resolve `Log` dynamically at *access* time
// (a getter), not at require time — a plain one-shot object-spread would
// freeze in whatever `currentFakeLog` was during that single require call,
// which happens before any test has set it.
let currentFakeLog = null;
const originalLoad = Module._load;
const k8sBackendSuffix = "/workers/provisioner/backends/k8s.ts";
Module._load = function loadWithFakeK8sLog(request, parent, isMain) {
  if (request === "@kubernetes/client-node" && parent?.filename?.endsWith(k8sBackendSuffix)) {
    const real = originalLoad.apply(this, arguments);
    const patched = Object.create(real);
    Object.defineProperty(patched, "Log", {
      enumerable: true,
      get() {
        return currentFakeLog || real.Log;
      },
    });
    return patched;
  }
  return originalLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = originalLoad;
});

const K8sBackend = require("./backends/k8s.ts");

function backendWithFakePod() {
  const backend = Object.create(K8sBackend.prototype);
  backend.kc = {}; // opaque — only threaded through to the (faked) k8s.Log ctor
  backend._namespaceForDeployName = () => "ns-1";
  backend._findRunningPod = async () => ({ metadata: { name: "pod-1" } });
  return backend;
}

function withFakeLogClass(captureFn) {
  class FakeLog {
    constructor(kc) {
      this.kc = kc;
    }

    async log(namespace, podName, container, stream, opts) {
      captureFn({ namespace, podName, container, opts });
    }
  }
  currentFakeLog = FakeLog;
  return () => {
    currentFakeLog = null;
  };
}

test("omitting opts.tail omits tailLines entirely (kubelet returns full available log)", async () => {
  let captured;
  const restore = withFakeLogClass((call) => {
    captured = call;
  });
  try {
    const backend = backendWithFakePod();
    await backend.logs("deploy-1", { follow: true });

    assert.equal(
      Object.prototype.hasOwnProperty.call(captured.opts, "tailLines"),
      false,
      "tailLines must be omitted entirely, not defaulted to 100",
    );
    assert.equal(captured.opts.follow, true);
    assert.equal(captured.namespace, "ns-1");
    assert.equal(captured.podName, "pod-1");
  } finally {
    restore();
  }
});

test("an explicit opts.tail maps onto tailLines (the live viewer's tail: 100 case)", async () => {
  let captured;
  const restore = withFakeLogClass((call) => {
    captured = call;
  });
  try {
    const backend = backendWithFakePod();
    await backend.logs("deploy-1", { follow: true, tail: 100 });
    assert.equal(captured.opts.tailLines, 100);
  } finally {
    restore();
  }
});

test("opts.since maps onto sinceTime as RFC3339 for the collector's cursor replay", async () => {
  let captured;
  const restore = withFakeLogClass((call) => {
    captured = call;
  });
  try {
    const backend = backendWithFakePod();
    await backend.logs("deploy-1", { follow: true, since: "2026-01-01T00:00:10.000Z" });
    assert.equal(captured.opts.sinceTime, "2026-01-01T00:00:10.000Z");
    assert.equal(Object.prototype.hasOwnProperty.call(captured.opts, "tailLines"), false);
  } finally {
    restore();
  }
});

test("returns null (not an error) when no pod is Running", async () => {
  const backend = backendWithFakePod();
  backend._findRunningPod = async () => null;
  const result = await backend.logs("deploy-1", { follow: true });
  assert.equal(result, null);
});
