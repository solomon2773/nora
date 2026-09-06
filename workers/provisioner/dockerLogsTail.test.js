// Logging control plane Phase 4 item 2b regression guard: DockerBackend.logs
// must treat an absent `opts.tail` as "all available lines" (dockerode/the
// Docker Engine API interpret an omitted `tail` field that way), not the old
// `opts.tail || 100` default that silently capped every caller at the last
// 100 lines. This is what makes the log collector's reconnect path (Phase 4
// item 2/2a) not re-ingest ~100 duplicate lines on every reattach.
//
// DockerBackend's constructor wires up a real dockerode client and a lot of
// other provisioning machinery this test has no need for, so the instance is
// built directly off the prototype (`Object.create`) with only the `docker`
// handle `logs()` actually touches — the same "construct the minimal shape a
// method needs" approach as the rest of this package's adapter-focused
// tests.
const assert = require("node:assert/strict");
const test = require("node:test");

// docker.ts's own internal requires (`./interface`, `./telemetry`, sibling
// agent-runtime/lib modules, etc.) are extensionless TS files, and at least
// one transitive dependency (agent-runtime/lib/integrationTools.ts) mixes a
// stray top-level `export` with `require()`/`module.exports` — which is only
// coherent under `tsx`'s loader (this package's real runtime, via `npm
// start`/`tsx worker.ts`), not plain Node's native TS-stripping, which
// misdetects such a file as ESM and then fails on the `require()` calls.
// Registering tsx's own require hook (already a dependency here) makes
// `require("./backends/docker.ts")` behave exactly as it does in production,
// so this test exercises docker.ts's *real* code rather than a stub.
require("tsx/cjs");

const DockerBackend = require("./backends/docker.ts");

function backendWithFakeContainer(fakeLogs) {
  const backend = Object.create(DockerBackend.prototype);
  backend.docker = {
    getContainer(containerId) {
      return {
        logs: (opts) => fakeLogs(containerId, opts),
      };
    },
  };
  return backend;
}

test("omitting opts.tail requests the full available log (no `tail` key at all)", async () => {
  let capturedOpts;
  const backend = backendWithFakeContainer((containerId, opts) => {
    capturedOpts = opts;
    return Promise.resolve({ containerId, opts });
  });

  await backend.logs("container-1", { follow: true });

  assert.equal(
    Object.prototype.hasOwnProperty.call(capturedOpts, "tail"),
    false,
    "tail must be omitted entirely, not defaulted to 100 or set to undefined",
  );
  assert.equal(capturedOpts.follow, true);
  assert.equal(capturedOpts.stdout, true);
  assert.equal(capturedOpts.stderr, true);
});

test("an explicit opts.tail is forwarded as-is (the live viewer's tail: 100 case)", async () => {
  let capturedOpts;
  const backend = backendWithFakeContainer((containerId, opts) => {
    capturedOpts = opts;
    return Promise.resolve({});
  });

  await backend.logs("container-1", { follow: true, tail: 100 });

  assert.equal(capturedOpts.tail, 100);
});

test("opts.since is forwarded as a UNIX-seconds timestamp for the collector's cursor replay", async () => {
  let capturedOpts;
  const backend = backendWithFakeContainer((containerId, opts) => {
    capturedOpts = opts;
    return Promise.resolve({});
  });

  await backend.logs("container-1", { follow: true, since: "2026-01-01T00:00:10.000Z" });

  assert.equal(capturedOpts.since, 1767225610);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedOpts, "tail"), false);
});

test("no opts.since means no `since` key at all", async () => {
  let capturedOpts;
  const backend = backendWithFakeContainer((containerId, opts) => {
    capturedOpts = opts;
    return Promise.resolve({});
  });

  await backend.logs("container-1", { follow: true });

  assert.equal(Object.prototype.hasOwnProperty.call(capturedOpts, "since"), false);
});
