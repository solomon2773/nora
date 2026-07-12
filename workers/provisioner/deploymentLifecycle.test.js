const assert = require("node:assert/strict");
const test = require("node:test");

const {
  acquireDedicatedSessionLock,
  finalizeProvisionedDeployment,
  fingerprintEffectiveProviderState,
  isBuiltInDemoActivation,
  persistProvisionedRuntimeMetadata,
  reconcileProviderStateUntilStable,
  runProvisioningReadinessBarrier,
  runRuntimeReconciliationBoundary,
  shouldReconcileEffectiveProviderState,
} = require("./deploymentLifecycle.ts");

test("dedicated session locks leave a one-connection work pool available", async () => {
  const events = [];
  let mainPoolInUse = false;
  const oneConnectionMainPool = {
    query: async () => {
      assert.equal(mainPoolInUse, false, "the main pool connection was already reserved");
      mainPoolInUse = true;
      events.push("main:query");
      await new Promise((resolve) => setImmediate(resolve));
      mainPoolInUse = false;
      return { rows: [{ ok: true }] };
    },
  };
  const dedicatedClient = {
    connect: async () => events.push("lock:connect"),
    query: async (sql) => {
      events.push(sql.includes("unlock") ? "lock:unlock" : "lock:acquire");
      return { rows: [{ locked: true }] };
    },
    end: async () => events.push("lock:end"),
  };

  const lock = await acquireDedicatedSessionLock({
    createClient: () => dedicatedClient,
    acquire: (client) => client.query("SELECT pg_try_advisory_lock(1) AS locked"),
    release: (client) => client.query("SELECT pg_advisory_unlock(1)"),
    isAcquired: (result) => result.rows[0]?.locked,
  });

  const work = await oneConnectionMainPool.query("SELECT finalization_work");
  assert.deepEqual(work.rows, [{ ok: true }]);
  await lock.release();

  assert.deepEqual(events, [
    "lock:connect",
    "lock:acquire",
    "main:query",
    "lock:unlock",
    "lock:end",
  ]);
});

test("busy dedicated session locks close their connection and preserve the busy error", async () => {
  const events = [];
  const lockError = new Error("agent is busy");
  lockError.code = "PROVISION_LOCK_BUSY";

  await assert.rejects(
    acquireDedicatedSessionLock({
      createClient: () => ({
        connect: async () => events.push("connect"),
        query: async () => ({ rows: [{ locked: false }] }),
        end: async () => events.push("end"),
      }),
      acquire: (client) => client.query("SELECT pg_try_advisory_lock(1) AS locked"),
      release: (client) => client.query("SELECT pg_advisory_unlock(1)"),
      isAcquired: (result) => result.rows[0]?.locked,
      busyError: () => lockError,
    }),
    (error) => error === lockError && error.code === "PROVISION_LOCK_BUSY",
  );

  assert.deepEqual(events, ["connect", "end"]);
});

test("dedicated session locks close exactly once when advisory unlock fails", async () => {
  const events = [];
  const lock = await acquireDedicatedSessionLock({
    createClient: () => ({
      connect: async () => events.push("connect"),
      query: async (sql) => {
        if (sql.includes("unlock")) {
          events.push("unlock");
          throw new Error("connection dropped during unlock");
        }
        events.push("acquire");
        return { rows: [{ locked: true }] };
      },
      end: async () => events.push("end"),
    }),
    acquire: (client) => client.query("SELECT pg_try_advisory_lock(1) AS locked"),
    release: (client) => client.query("SELECT pg_advisory_unlock(1)"),
    isAcquired: (result) => result.rows[0]?.locked,
    onReleaseError: (error) => events.push(`release-error:${error.message}`),
  });

  await lock.release();
  await lock.release();

  assert.deepEqual(events, [
    "connect",
    "acquire",
    "unlock",
    "release-error:connection dropped during unlock",
    "end",
  ]);
});

test("effective provider fingerprints are canonical and detect runtime-relevant drift", () => {
  const first = fingerprintEffectiveProviderState({
    envVars: {
      NORA_DEMO_LLM_TOKEN: "demo-token",
      NORA_DEMO_LLM_BASE_URL: "http://backend-api:4000/demo-llm/v1",
    },
    defaultProvider: {
      id: "provider-1",
      provider: "demo",
      model: "nora-demo-1",
      config: '{"baseUrl":"http://backend-api:4000/demo-llm/v1","nested":{"b":2,"a":1}}',
    },
  });
  const reordered = fingerprintEffectiveProviderState({
    envVars: {
      NORA_DEMO_LLM_BASE_URL: "http://backend-api:4000/demo-llm/v1",
      NORA_DEMO_LLM_TOKEN: "demo-token",
    },
    defaultProvider: {
      id: "replacement-row-with-same-effective-state",
      provider: "demo",
      model: "nora-demo-1",
      config: {
        nested: { a: 1, b: 2 },
        baseUrl: "http://backend-api:4000/demo-llm/v1",
      },
    },
  });
  const changed = fingerprintEffectiveProviderState({
    envVars: {
      NORA_DEMO_LLM_TOKEN: "rotated-token",
      NORA_DEMO_LLM_BASE_URL: "http://backend-api:4000/demo-llm/v1",
    },
    defaultProvider: {
      provider: "demo",
      model: "nora-demo-1",
      config: { baseUrl: "http://backend-api:4000/demo-llm/v1" },
    },
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.equal(
    shouldReconcileEffectiveProviderState(first, {
      envVars: {
        NORA_DEMO_LLM_BASE_URL: "http://backend-api:4000/demo-llm/v1",
        NORA_DEMO_LLM_TOKEN: "demo-token",
      },
      defaultProvider: {
        provider: "demo",
        model: "nora-demo-1",
        config: {
          nested: { b: 2, a: 1 },
          baseUrl: "http://backend-api:4000/demo-llm/v1",
        },
      },
    }),
    false,
  );
  assert.equal(
    shouldReconcileEffectiveProviderState(first, {
      envVars: {
        NORA_DEMO_LLM_TOKEN: "rotated-token",
        NORA_DEMO_LLM_BASE_URL: "http://backend-api:4000/demo-llm/v1",
      },
      defaultProvider: {
        provider: "demo",
        model: "nora-demo-1",
        config: { baseUrl: "http://backend-api:4000/demo-llm/v1" },
      },
    }),
    true,
  );
});

test("strict demo readiness applies only to the explicitly pinned zero-key activation", () => {
  assert.equal(
    isBuiltInDemoActivation({
      jobId: "demo-activation-agent-1",
      agentId: "agent-1",
      llmProviderId: "provider-demo",
      defaultProvider: { provider: "demo" },
    }),
    true,
  );
  assert.equal(
    isBuiltInDemoActivation({
      jobId: "demo-activation-agent-1",
      agentId: "agent-1",
      llmProviderId: null,
      defaultProvider: { provider: "demo" },
    }),
    false,
  );
  assert.equal(
    isBuiltInDemoActivation({
      jobId: "demo-activation-agent-1",
      agentId: "agent-1",
      llmProviderId: "provider-openai",
      defaultProvider: { provider: "openai" },
    }),
    false,
  );
});

test("an ordinary redeploy using the demo provider is not first activation", () => {
  assert.equal(
    isBuiltInDemoActivation({
      jobId: "redeploy-agent-1",
      agentId: "agent-1",
      llmProviderId: "provider-demo",
      defaultProvider: { provider: "demo" },
    }),
    false,
  );
});

test("runtime metadata persistence keeps the deployment behind the deploying barrier", async () => {
  let sql = "";
  const queryable = {
    query: async (statement) => {
      sql = statement;
      return { rows: [{ id: "agent-1", container_id: "runtime-1" }] };
    },
  };

  const result = await persistProvisionedRuntimeMetadata(queryable, {
    agentId: "agent-1",
    containerId: "runtime-1",
    backendType: "docker",
    runtimeFamily: "openclaw",
    deployTarget: "docker",
    executionTargetId: "docker",
    sandboxProfile: "standard",
    sandboxType: "standard",
  });

  assert.deepEqual(result, { persisted: true, containerId: "runtime-1" });
  assert.match(sql, /AND status = 'deploying'/);
  assert.match(sql, /container_id IS NULL OR container_id = \$2/);
  assert.doesNotMatch(sql, /SET status = 'running'/);
});

test("readiness finalization waits for auth reconciliation to settle", async () => {
  const order = [];
  let releaseReconciliation;
  const reconciliationGate = new Promise((resolve) => {
    releaseReconciliation = resolve;
  });

  const pending = runProvisioningReadinessBarrier({
    checkReadiness: async () => {
      order.push("readiness");
      return { ok: true };
    },
    reconcileAuth: async () => {
      order.push("reconcile:start");
      await reconciliationGate;
      order.push("reconcile:end");
      return { status: "synced" };
    },
    finalize: async () => {
      order.push("finalize");
      return { finalized: true };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["readiness", "reconcile:start"]);

  releaseReconciliation();
  const result = await pending;

  assert.equal(result.status, "running");
  assert.deepEqual(order, ["readiness", "reconcile:start", "reconcile:end", "finalize"]);
});

test("failed initial readiness never reconciles or publishes running", async () => {
  let reconciled = false;
  let finalized = false;
  let warned = false;

  const result = await runProvisioningReadinessBarrier({
    checkReadiness: async () => ({ ok: false, gateway: { error: "connection refused" } }),
    onReadinessWarning: async () => {
      warned = true;
    },
    reconcileAuth: async () => {
      reconciled = true;
      return { status: "synced" };
    },
    finalize: async () => {
      finalized = true;
      return { finalized: true };
    },
  });

  assert.equal(result.status, "warning");
  assert.equal(warned, true);
  assert.equal(reconciled, false);
  assert.equal(finalized, false);
});

test("demo readiness failure fails closed without warning, reconciliation, or finalization", async () => {
  let warned = false;
  let reconciled = false;
  let finalized = false;

  await assert.rejects(
    runProvisioningReadinessBarrier({
      checkReadiness: async () => ({ ok: false, gateway: { error: "connection refused" } }),
      failClosedOnReadinessFailure: true,
      onReadinessWarning: async () => {
        warned = true;
      },
      reconcileAuth: async () => {
        reconciled = true;
        return { status: "synced" };
      },
      finalize: async () => {
        finalized = true;
        return { finalized: true };
      },
    }),
    (error) => {
      assert.equal(error.code, "INITIAL_RUNTIME_READINESS_FAILED");
      assert.match(error.message, /connection refused/);
      return true;
    },
  );

  assert.equal(warned, false);
  assert.equal(reconciled, false);
  assert.equal(finalized, false);
});

test("auth reconciliation failure never publishes running", async () => {
  let finalized = false;

  await assert.rejects(
    runProvisioningReadinessBarrier({
      checkReadiness: async () => ({ ok: true }),
      reconcileAuth: async () => {
        throw new Error("gateway did not recover after auth restart");
      },
      finalize: async () => {
        finalized = true;
        return { finalized: true };
      },
    }),
    /gateway did not recover/,
  );

  assert.equal(finalized, false);
});

test("provider finalization retries drift and commits only while mutation state is stable", async () => {
  const order = [];
  const fingerprints = ["provider-v2", "provider-v2"];
  let reconcilePass = 0;

  const result = await reconcileProviderStateUntilStable({
    bootstrappedFingerprint: "provider-v1",
    reconcile: async (previousFingerprint) => {
      order.push(`reconcile:${previousFingerprint}`);
      reconcilePass += 1;
      return {
        status: "synced",
        providerFingerprint: reconcilePass === 1 ? "provider-v1" : "provider-v2",
      };
    },
    readFingerprint: async () => {
      const fingerprint = fingerprints.shift();
      order.push(`verify:${fingerprint}`);
      return fingerprint;
    },
    withMutationLock: async (operation) => {
      order.push("lock");
      try {
        return await operation();
      } finally {
        order.push("unlock");
      }
    },
    finalize: async () => {
      order.push("finalize");
      return { finalized: true };
    },
  });

  assert.equal(result.passes, 2);
  assert.equal(result.finalization.finalized, true);
  assert.deepEqual(order, [
    "reconcile:provider-v1",
    "lock",
    "verify:provider-v2",
    "unlock",
    "reconcile:provider-v1",
    "lock",
    "verify:provider-v2",
    "finalize",
    "unlock",
  ]);
});

test("provider finalization fails closed when mutations never settle", async () => {
  let version = 1;
  let finalized = false;

  await assert.rejects(
    reconcileProviderStateUntilStable({
      bootstrappedFingerprint: "provider-v0",
      reconcile: async () => ({
        status: "synced",
        providerFingerprint: `provider-v${version++}`,
      }),
      readFingerprint: async () => `provider-v${version++}`,
      withMutationLock: async (operation) => operation(),
      finalize: async () => {
        finalized = true;
        return { finalized: true };
      },
      maxPasses: 2,
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_STATE_UNSTABLE");
      return true;
    },
  );

  assert.equal(finalized, false);
});

test("runtime reconciliation applies every mutation before one restart and checks readiness last", async () => {
  const order = [];

  const readiness = await runRuntimeReconciliationBoundary({
    mutations: [
      async () => order.push("auth"),
      async () => order.push("custom-provider"),
      async () => order.push("default-model"),
    ],
    restart: async () => order.push("restart"),
    checkReadiness: async () => {
      order.push("readiness");
      return { ok: true };
    },
  });

  assert.deepEqual(order, ["auth", "custom-provider", "default-model", "restart", "readiness"]);
  assert.deepEqual(readiness, { ok: true });
});

test("guarded finalization atomically completes only the matching deploying runtime", async () => {
  const calls = [];
  const responses = [
    { rows: [] },
    { rows: [{ id: "agent-1" }] },
    { rows: [{ agent_id: "agent-1" }] },
    { rows: [] },
    { rows: [] },
  ];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return responses.shift();
    },
    release: () => calls.push({ sql: "RELEASE" }),
  };

  const result = await finalizeProvisionedDeployment(
    { connect: async () => client },
    {
      agentId: "agent-1",
      containerId: "runtime-1",
      name: "Demo Agent",
      backend: "docker",
      host: "172.18.0.27",
    },
  );

  assert.deepEqual(result, { finalized: true });
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /status = 'deploying'/);
  assert.match(calls[1].sql, /container_id = \$2/);
  assert.match(calls[2].sql, /SET status = 'completed'/);
  assert.match(calls[3].sql, /INSERT INTO events/);
  assert.equal(calls[4].sql, "COMMIT");
  assert.equal(calls[5].sql, "RELEASE");
});

test("deleted or replaced runtimes cannot be finalized", async () => {
  const calls = [];
  const responses = [{ rows: [] }, { rows: [] }, { rows: [] }];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return responses.shift();
    },
    release: () => calls.push({ sql: "RELEASE" }),
  };

  const result = await finalizeProvisionedDeployment(
    { connect: async () => client },
    {
      agentId: "agent-1",
      containerId: "stale-runtime",
      name: "Demo Agent",
      backend: "docker",
    },
  );

  assert.deepEqual(result, {
    finalized: false,
    reason: "agent-missing-or-runtime-replaced",
  });
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls[2].sql, "ROLLBACK");
  assert.equal(calls[3].sql, "RELEASE");
  assert.equal(
    calls.some(({ sql }) => /UPDATE deployments/.test(sql)),
    false,
  );
  assert.equal(
    calls.some(({ sql }) => /INSERT INTO events/.test(sql)),
    false,
  );
});
