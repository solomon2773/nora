// DockerBackend._findComposeNetwork tests (#452).
//
// Follows this package's established convention (logCollector.test.js /
// gatewayCollector.test.js) — Node's built-in test runner, fakes passed in by
// replacing the instance's dockerode client, deterministic.
const assert = require("node:assert/strict");
const test = require("node:test");

// docker.ts pulls in agent-runtime/lib/*.ts files whose own internal requires
// are extensionless TS files — fine under `tsx` (this package's real runtime)
// but not plain Node's resolver (same fix the other suites here use).
require("tsx/cjs");

const DockerBackend = require("./backends/docker.ts");

function backendWithFakeDocker({ selfNetworks = null, labelContainers = [], networks = [] } = {}) {
  const backend = new DockerBackend();
  backend.docker = {
    getContainer: () => ({
      inspect: async () => {
        if (!selfNetworks) {
          throw new Error("no such container");
        }
        return { NetworkSettings: { Networks: selfNetworks } };
      },
    }),
    listContainers: async () => labelContainers,
    listNetworks: async () => networks,
  };
  return backend;
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("exactly one *_default candidate is selected (self-inspect)", async () => {
  await withEnv({ HOSTNAME: "worker-123", NORA_COMPOSE_NETWORK: undefined }, async () => {
    const backend = backendWithFakeDocker({
      selfNetworks: {
        nora_default: { IPAddress: "172.18.0.4" },
        bridge: { IPAddress: "172.17.0.2" },
      },
    });
    assert.equal(await backend._findComposeNetwork(), "nora_default");
  });
});

test("several *_default candidates fail closed instead of picking the first", async () => {
  await withEnv({ HOSTNAME: "worker-123", NORA_COMPOSE_NETWORK: undefined }, async () => {
    const backend = backendWithFakeDocker({
      selfNetworks: {
        nora_default: { IPAddress: "172.18.0.4" },
        otherproject_default: { IPAddress: "172.19.0.4" },
      },
    });
    assert.equal(await backend._findComposeNetwork(), null);
  });
});

test("the result does not depend on enumeration order", async () => {
  await withEnv({ HOSTNAME: "worker-123", NORA_COMPOSE_NETWORK: undefined }, async () => {
    // The same two candidates in both orders: both permutations must agree —
    // this is the assertion that actually pins determinism (#452). A .find()
    // first-match would return a different network per permutation.
    const permutations = [
      { nora_default: { IPAddress: "a" }, otherproject_default: { IPAddress: "b" } },
      { otherproject_default: { IPAddress: "b" }, nora_default: { IPAddress: "a" } },
    ];
    for (const selfNetworks of permutations) {
      const backend = backendWithFakeDocker({ selfNetworks });
      assert.equal(await backend._findComposeNetwork(), null);
    }
  });
});

test("label-scan strategy is also unique-or-null", async () => {
  await withEnv({ HOSTNAME: "", NORA_COMPOSE_NETWORK: undefined }, async () => {
    const twoLabelled = backendWithFakeDocker({
      networks: [
        { Name: "nora_default", Labels: { "com.docker.compose.network": "default" } },
        { Name: "legacy_default", Labels: { "com.docker.compose.network": "default" } },
      ],
    });
    assert.equal(await twoLabelled._findComposeNetwork(), null);

    const oneLabelled = backendWithFakeDocker({
      networks: [
        { Name: "nora_default", Labels: { "com.docker.compose.network": "default" } },
        // An unrelated project's leftover network without the Compose label
        // must not count as a candidate at all.
        { Name: "unlabelled_default", Labels: {} },
      ],
    });
    assert.equal(await oneLabelled._findComposeNetwork(), "nora_default");
  });
});

test("NORA_COMPOSE_NETWORK overrides every heuristic", async () => {
  await withEnv({ HOSTNAME: "worker-123", NORA_COMPOSE_NETWORK: "ops_platform_net" }, async () => {
    const backend = backendWithFakeDocker({
      selfNetworks: {
        nora_default: { IPAddress: "172.18.0.4" },
        otherproject_default: { IPAddress: "172.19.0.4" },
      },
    });
    assert.equal(await backend._findComposeNetwork(), "ops_platform_net");
  });
});

test("the resolved network is cached on the instance", async () => {
  await withEnv({ HOSTNAME: "worker-123", NORA_COMPOSE_NETWORK: undefined }, async () => {
    const backend = backendWithFakeDocker({
      selfNetworks: { nora_default: { IPAddress: "172.18.0.4" } },
    });
    assert.equal(await backend._findComposeNetwork(), "nora_default");
    // Replace the client with one that would throw — the cache must answer.
    backend.docker = {};
    assert.equal(await backend._findComposeNetwork(), "nora_default");
  });
});
