// @ts-nocheck
// Coverage for the scheduled-run executor: action dispatch (prompt/lifecycle),
// failure -> markRun + throw (so BullMQ retries), and missing-agent handling.

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const mockMarkRun = jest.fn().mockResolvedValue(undefined);
jest.mock("../agentSchedules", () => ({ markRun: mockMarkRun }));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("../monitoring", () => ({ logEvent: mockLogEvent }));

const mockRecordTokenUsage = jest.fn().mockResolvedValue(undefined);
jest.mock("../metrics", () => ({ recordTokenUsage: mockRecordTokenUsage }));

const mockContainer = {
  restart: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  start: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  canDestroy: jest.fn((agent) => Boolean(agent?.container_id || agent?.container_name)),
  persistLifecycleRuntimeAddress: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../containerManager", () => mockContainer);

const mockAddDeploymentJob = jest.fn().mockResolvedValue(undefined);
const mockCancelDeploymentJobsForAgent = jest.fn().mockResolvedValue({ removed: 0, active: 0 });
const mockAgentProvisionLockRelease = jest.fn().mockResolvedValue(undefined);
const mockAcquireAgentProvisionLock = jest.fn().mockResolvedValue({
  release: mockAgentProvisionLockRelease,
});
jest.mock("../redisQueue", () => ({
  addDeploymentJob: mockAddDeploymentJob,
  cancelDeploymentJobsForAgent: mockCancelDeploymentJobsForAgent,
}));
jest.mock("../agentProvisionLock", () => ({
  ...jest.requireActual("../agentProvisionLock"),
  acquireAgentProvisionLock: mockAcquireAgentProvisionLock,
}));

const mockRpcCall = jest.fn().mockResolvedValue({ result: { message: { usage: {} } } });
const mockResolveHost = jest.fn().mockResolvedValue("10.0.0.7");
const mockAllowedHosts = jest.fn().mockResolvedValue(new Set(["10.0.0.7"]));
jest.mock("../gatewayProxy", () => ({
  rpcCall: mockRpcCall,
  resolveGatewayHostForProxy: mockResolveHost,
  allowedGatewayHostsForAgent: mockAllowedHosts,
}));

jest.mock("../runtimeAuth", () => ({ runtimeAuthHeaders: jest.fn().mockResolvedValue({}) }));
jest.mock("../agentRuntimeFields", () => ({
  buildAgentRuntimeFields: (agent) => ({
    runtime_family: agent.runtime_family || "openclaw",
    backend_type: agent.backend_type || agent.deploy_target || "docker",
    deploy_target: agent.deploy_target || agent.backend_type || "docker",
    execution_target_id: agent.execution_target_id || agent.deploy_target || "docker",
    sandbox_profile: agent.sandbox_profile || "standard",
    sandbox_type: agent.sandbox_profile || "standard",
  }),
  resolveAgentRuntimeFamily: (a) => a.runtime_family || "openclaw",
}));

const mockResumeAgentWithProviderAuth = jest.fn();
jest.mock("../authSync", () => ({
  resumeAgentWithProviderAuth: (...args) => mockResumeAgentWithProviderAuth(...args),
}));

const { runScheduledAction } = require("../scheduleRunner");

const OPENCLAW_AGENT = {
  id: "a1",
  name: "Op",
  user_id: "u1",
  status: "running",
  runtime_family: "openclaw",
  backend_type: "docker",
  deploy_target: "docker",
  execution_target_id: "docker",
  sandbox_profile: "standard",
  vcpu: 4,
  ram_mb: 4096,
  disk_gb: 40,
  container_id: "container-a1",
  container_name: "nora-oclaw-op-a1",
  host: "172.18.0.10",
  image: "nora-openclaw-agent:local",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockResolvedValue({ rows: [OPENCLAW_AGENT] });
  mockCancelDeploymentJobsForAgent.mockResolvedValue({ removed: 0, active: 0 });
  mockAcquireAgentProvisionLock.mockResolvedValue({ release: mockAgentProvisionLockRelease });
  mockAgentProvisionLockRelease.mockResolvedValue(undefined);
  mockContainer.persistLifecycleRuntimeAddress.mockResolvedValue(undefined);
  OPENCLAW_AGENT.status = "running";
  OPENCLAW_AGENT.paused_reason = null;
  mockResumeAgentWithProviderAuth.mockImplementation(async (agent) => ({
    agent: { ...agent, status: "running", paused_reason: null },
    lifecycleResult: null,
    syncResult: { agentId: agent.id, status: "synced" },
  }));
});

it("delivers a prompt to an OpenClaw agent via rpcCall and records the run", async () => {
  const out = await runScheduledAction({
    scheduleId: "s1",
    agentId: "a1",
    actionType: "prompt",
    prompt: "hello",
    createdBy: "u1",
  });
  expect(out).toEqual({ ok: true, status: "success" });
  expect(mockRpcCall).toHaveBeenCalledWith(
    OPENCLAW_AGENT,
    "chat.send",
    expect.objectContaining({ message: "hello" }),
    expect.any(Number),
  );
  expect(mockMarkRun).toHaveBeenCalledWith("s1", "success");
  expect(mockLogEvent).toHaveBeenCalledWith(
    "agent.schedule.run",
    expect.any(String),
    expect.objectContaining({ result: expect.objectContaining({ ok: true }) }),
  );
});

it.each(["start", "restart"])(
  "dispatches the %s lifecycle action through auth sync",
  async (action) => {
    const out = await runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: action });
    expect(out.ok).toBe(true);
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(OPENCLAW_AGENT, action);
    expect(mockContainer[action]).not.toHaveBeenCalled();
  },
);

it("dispatches stop directly to containerManager", async () => {
  const out = await runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "stop" });
  expect(out.ok).toBe(true);
  expect(mockContainer.stop).toHaveBeenCalledWith(OPENCLAW_AGENT);
  expect(mockResumeAgentWithProviderAuth).not.toHaveBeenCalled();
});

it.each(["start", "restart"])(
  "reconciles the durable owner's current auth after scheduled %s",
  async (action) => {
    const out = await runScheduledAction({
      scheduleId: "s1",
      agentId: "a1",
      actionType: action,
      createdBy: "workspace-editor-1",
    });

    expect(out.ok).toBe(true);
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1", user_id: "u1" }),
      action,
    );
  },
);

it("redeploy preserves runtime identity and enqueues a canonical owner replacement", async () => {
  await runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "redeploy" });
  expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledWith("a1");
  expect(mockContainer.destroy).not.toHaveBeenCalled();
  expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'queued'"), [
    "a1",
    "running",
    "container-a1",
    "nora-oclaw-op-a1",
    "docker",
    "openclaw",
    "docker",
    "docker",
    "standard",
    "172.18.0.10",
  ]);
  expect(mockDb.query).not.toHaveBeenCalledWith(expect.stringContaining("container_id = NULL"), [
    "a1",
  ]);
  expect(mockDb.query).toHaveBeenCalledWith(
    "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
    ["a1"],
  );
  expect(mockAddDeploymentJob).toHaveBeenCalledWith({
    id: "a1",
    name: "Op",
    userId: "u1",
    backend: "docker",
    runtime_family: "openclaw",
    deploy_target: "docker",
    execution_target_id: "docker",
    sandbox_profile: "standard",
    sandbox: "standard",
    specs: { vcpu: 4, ram_mb: 4096, disk_gb: 40 },
    container_name: "nora-oclaw-op-a1",
    image: "nora-openclaw-agent:local",
    replace_existing_runtime: true,
    previous_container_id: "container-a1",
    previous_container_name: "nora-oclaw-op-a1",
    previous_host: "172.18.0.10",
    previous_backend: "docker",
    previous_runtime_family: "openclaw",
    previous_deploy_target: "docker",
    previous_execution_target_id: "docker",
    previous_sandbox_profile: "standard",
  });
});

it("restores the previous status when scheduled redeploy enqueue fails", async () => {
  mockAddDeploymentJob.mockRejectedValueOnce(new Error("queue unavailable"));

  await expect(
    runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "redeploy" }),
  ).rejects.toThrow("queue unavailable");

  expect(mockDb.query).toHaveBeenCalledWith(
    "UPDATE agents SET status = $2 WHERE id = $1 AND status = 'queued'",
    ["a1", "running"],
  );
  expect(mockDb.query).toHaveBeenCalledWith(
    "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'",
    ["a1"],
  );
  expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(2);
  expect(mockContainer.destroy).not.toHaveBeenCalled();
});

it("restores the previous status when scheduled redeploy cannot insert its deployment row", async () => {
  mockDb.query.mockImplementation(async (sql) => {
    if (String(sql).startsWith("SELECT * FROM agents")) return { rows: [OPENCLAW_AGENT] };
    if (String(sql).startsWith("INSERT INTO deployments")) {
      throw new Error("deployment insert unavailable");
    }
    return { rows: [] };
  });

  await expect(
    runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "redeploy" }),
  ).rejects.toThrow("deployment insert unavailable");

  expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(1);
  expect(mockDb.query).toHaveBeenCalledWith(
    "UPDATE agents SET status = $2 WHERE id = $1 AND status = 'queued'",
    ["a1", "running"],
  );
  expect(mockDb.query).not.toHaveBeenCalledWith(
    "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'",
    ["a1"],
  );
  expect(mockContainer.destroy).not.toHaveBeenCalled();
});

it("stops a resumed agent when current provider auth reconciliation fails", async () => {
  mockResumeAgentWithProviderAuth.mockRejectedValueOnce(
    Object.assign(new Error("Current provider authentication could not be reconciled"), {
      code: "AGENT_AUTH_RECONCILIATION_FAILED",
    }),
  );

  await expect(
    runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "start" }),
  ).rejects.toThrow(/authentication could not be reconciled/);

  expect(mockMarkRun).toHaveBeenCalledWith(
    "s1",
    expect.stringContaining("authentication could not be reconciled"),
  );
});

it("records agent_missing without throwing when the agent is gone", async () => {
  mockDb.query.mockResolvedValue({ rows: [] });
  const out = await runScheduledAction({
    scheduleId: "s1",
    agentId: "gone",
    actionType: "restart",
  });
  expect(out).toEqual({ ok: false, status: "agent_missing" });
  expect(mockMarkRun).toHaveBeenCalledWith("s1", "agent_missing");
  expect(mockContainer.restart).not.toHaveBeenCalled();
});

it.each(["queued", "deploying"])(
  "rejects a scheduled lifecycle action while the agent is %s",
  async (status) => {
    mockDb.query.mockResolvedValue({ rows: [{ ...OPENCLAW_AGENT, status }] });

    await expect(
      runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "restart" }),
    ).rejects.toMatchObject({
      code: "AGENT_PROVISIONING_IN_PROGRESS",
      statusCode: 409,
    });

    expect(mockContainer.restart).not.toHaveBeenCalled();
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  },
);

it("holds the provision lock through runtime mutation and lifecycle persistence", async () => {
  const order = [];
  mockResumeAgentWithProviderAuth.mockImplementationOnce(async (agent) => {
    order.push("provider-fenced-resume");
    return { agent: { ...agent, status: "running", paused_reason: null } };
  });
  mockAgentProvisionLockRelease.mockImplementationOnce(async () => {
    order.push("release");
  });

  await runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "start" });

  expect(order).toEqual(["provider-fenced-resume", "release"]);
});

it("on action failure, records the failure and rethrows (for BullMQ retry)", async () => {
  mockResumeAgentWithProviderAuth.mockRejectedValueOnce(new Error("boom"));
  await expect(
    runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "restart" }),
  ).rejects.toThrow("boom");
  expect(mockMarkRun).toHaveBeenCalledWith("s1", expect.stringContaining("failed: boom"));
  expect(mockLogEvent).toHaveBeenCalledWith(
    "agent.schedule.run",
    expect.stringContaining("failed"),
    expect.objectContaining({ result: expect.objectContaining({ ok: false }) }),
  );
});

it("rejects a payload missing required fields", async () => {
  await expect(runScheduledAction({ scheduleId: "s1" })).rejects.toThrow(/requires/);
});

it("delivers a Hermes prompt through the SSRF-safe resolved host", async () => {
  const HERMES = {
    id: "h1",
    name: "Hermes",
    user_id: "u1",
    runtime_family: "hermes",
    runtime_host: "hermes.internal",
    runtime_port: 8642,
  };
  mockDb.query.mockResolvedValue({ rows: [HERMES] });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ usage: {} }) });

  const out = await runScheduledAction({
    scheduleId: "s1",
    agentId: "h1",
    actionType: "prompt",
    prompt: "hi",
    createdBy: "u1",
  });

  expect(out.ok).toBe(true);
  // Host must be validated/pinned via the gateway SSRF resolver, not used raw.
  expect(mockResolveHost).toHaveBeenCalledWith(
    "hermes.internal",
    "hermes runtime",
    expect.anything(),
  );
  expect(global.fetch).toHaveBeenCalledWith(
    "http://10.0.0.7:8642/v1/chat/completions",
    expect.objectContaining({ method: "POST" }),
  );
  delete global.fetch;
});

it("skips a revive action on a budget-paused agent (does not fight the budget)", async () => {
  mockDb.query.mockResolvedValue({
    rows: [{ ...OPENCLAW_AGENT, paused_reason: "budget_exceeded" }],
  });
  const out = await runScheduledAction({ scheduleId: "s1", agentId: "a1", actionType: "restart" });
  expect(out).toEqual({ ok: false, status: "skipped: budget_exceeded" });
  expect(mockContainer.restart).not.toHaveBeenCalled();
  expect(mockMarkRun).toHaveBeenCalledWith("s1", "skipped: budget_exceeded");
});
