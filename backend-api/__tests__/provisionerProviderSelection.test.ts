// @ts-nocheck
const mockWorkerDb = {
  query: jest.fn(),
  connect: jest.fn(),
};
const mockLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockLockClient);
const mockGetDeploymentProvider = jest.fn();
const mockWorkerOn = jest.fn();
let mockDeploymentProcessor;

jest.mock("../../workers/provisioner/node_modules/bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message) {
      super(message);
      this.name = "UnrecoverableError";
    }
  },
  Worker: jest.fn().mockImplementation((queueName, processor) => {
    if (queueName === "deployments") mockDeploymentProcessor = processor;
    return {
      on: mockWorkerOn,
      isRunning: jest.fn().mockReturnValue(true),
    };
  }),
}));
jest.mock("../../workers/provisioner/node_modules/ioredis", () => jest.fn());
jest.mock("../../workers/provisioner/node_modules/pg", () => ({
  Client: mockPgClient,
  Pool: jest.fn().mockImplementation(() => mockWorkerDb),
}));
jest.mock("../lib/connectionConfig", () => ({
  buildPostgresConfig: jest.fn().mockReturnValue({}),
  createRedisClient: jest.fn().mockReturnValue({}),
}));
jest.mock("../llmProviders", () => ({
  getDeploymentProvider: mockGetDeploymentProvider,
  getManagedProviderEnvNames: jest.fn(() => []),
  providerMutationLockKey: (userId) => `nora:llm-providers:${userId}`,
}));
jest.mock("../redisQueue", () => ({
  ALERT_DELIVERY_ATTEMPTS: 1,
}));
jest.mock("../alertRules", () => ({
  runAlertDeliveryJob: jest.fn(),
  recordDeliveryFailure: jest.fn(),
}));
jest.mock("../scheduleRunner", () => ({
  runScheduledAction: jest.fn(),
}));
jest.mock("http", () => ({
  ...jest.requireActual("http"),
  createServer: jest.fn().mockReturnValue({ listen: jest.fn() }),
}));

const {
  allocateAvailableLocalDockerGatewayPort,
  buildUnresolvedRuntimeError,
  cleanupProvisionedRuntimeAfterFailure,
  fetchDeploymentProvider,
  fetchUserLlmEnvVars,
  isFinalDeploymentAttempt,
  persistProvisioningFailure,
} = require("../../workers/provisioner/worker");

beforeEach(() => {
  jest.clearAllMocks();
  mockLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockLockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockLockClient.end.mockReset().mockResolvedValue(undefined);
  delete process.env.KEY_STORAGE;
});

describe("provisioner deployment provider selection", () => {
  it("limits startup credentials to an explicitly pinned provider", async () => {
    mockWorkerDb.query.mockResolvedValue({ rows: [] });

    await fetchUserLlmEnvVars("user-1", "provider-demo");

    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE user_id = \$1\s+AND id = \$2/),
      ["user-1", "provider-demo"],
    );
  });

  it("keeps legacy deployments compatible by loading all user providers", async () => {
    mockWorkerDb.query.mockResolvedValue({ rows: [] });

    await fetchUserLlmEnvVars("user-1");

    expect(mockWorkerDb.query).toHaveBeenCalledWith(expect.not.stringMatching(/AND id = \$2/), [
      "user-1",
    ]);
  });

  it("uses the explicit demo provider instead of a real global default", async () => {
    mockGetDeploymentProvider.mockImplementation(async (_userId, providerId) =>
      providerId
        ? { id: providerId, provider: "demo", model: "nora-demo-1" }
        : { id: "provider-openai", provider: "openai", model: "gpt-5.5" },
    );

    const explicit = await fetchDeploymentProvider("user-1", "provider-demo");
    const legacy = await fetchDeploymentProvider("user-1");

    expect(explicit).toEqual(expect.objectContaining({ id: "provider-demo", provider: "demo" }));
    expect(legacy).toEqual(expect.objectContaining({ id: "provider-openai", provider: "openai" }));
    expect(mockGetDeploymentProvider).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "provider-demo",
      mockWorkerDb,
    );
    expect(mockGetDeploymentProvider).toHaveBeenNthCalledWith(2, "user-1", null, mockWorkerDb);
  });

  it("fails closed when an explicit provider cannot be resolved", async () => {
    mockGetDeploymentProvider.mockRejectedValue(
      Object.assign(new Error("Deployment LLM provider was not found for this user"), {
        code: "DEPLOYMENT_LLM_PROVIDER_NOT_FOUND",
      }),
    );

    await expect(fetchDeploymentProvider("user-1", "missing-provider")).rejects.toMatchObject({
      code: "DEPLOYMENT_LLM_PROVIDER_NOT_FOUND",
    });
  });
});

describe("provisioner deployment lifecycle", () => {
  it("skips Docker-published ports that are missing from the allocation table", async () => {
    const allocatePort = jest.fn().mockResolvedValueOnce(19000).mockResolvedValueOnce(19001);
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const provisioner = {
      isHostPortBound: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    };

    await expect(
      allocateAvailableLocalDockerGatewayPort({
        agentId: "agent-1",
        containerName: "nora-oclaw-demo-agent-agent-1",
        provisioner,
        allocatePort,
        queryable,
      }),
    ).resolves.toBe(19001);

    expect(allocatePort).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ hostKey: "local", agentId: "agent-1", rangeMin: 19000 }),
    );
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM gateway_port_allocations/),
      ["local", "agent-1", "gateway", 19000],
    );
    expect(allocatePort).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ hostKey: "local", agentId: "agent-1", rangeMin: 19001 }),
    );
  });

  it("treats only the last configured attempt as terminal", () => {
    expect(isFinalDeploymentAttempt({ attemptsMade: 0, opts: { attempts: 5 } })).toBe(false);
    expect(isFinalDeploymentAttempt({ attemptsMade: 3, opts: { attempts: 5 } })).toBe(false);
    expect(isFinalDeploymentAttempt({ attemptsMade: 4, opts: { attempts: 5 } })).toBe(true);
  });

  it("uses BullMQ's unrecoverable error contract for unresolved runtime identity", () => {
    const error = buildUnresolvedRuntimeError({
      agentId: "agent-1",
      containerId: "108",
      error: new Error("destroy failed"),
    });

    expect(error).toMatchObject({
      name: "UnrecoverableError",
      code: "UNRESOLVED_RUNTIME_IDENTITY",
      containerId: "108",
    });
    expect(error.message).toMatch(/automatic retry disabled/i);
  });

  it("returns retryable failures to queued without exposing terminal error state", async () => {
    const queryable = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "agent-1" }] })
        .mockResolvedValue({ rows: [] }),
    };

    await expect(
      persistProvisioningFailure({
        queryable,
        job: { attemptsMade: 0, opts: { attempts: 5 } },
        agentId: "agent-1",
        name: "Demo Agent",
        error: new Error("port is already allocated"),
      }),
    ).resolves.toEqual({ canceled: false, terminal: false });

    expect(queryable.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'queued' WHERE id = $1 AND status IN ('deploying', 'running', 'warning')",
      ["agent-1"],
    );
    expect(queryable.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'queued' WHERE agent_id = $1 AND status IN ('deploying', 'completed')",
      ["agent-1"],
    );
    expect(queryable.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/status = 'error'/),
      expect.anything(),
    );
  });

  it("records terminal error only after attempts are exhausted", async () => {
    const queryable = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "agent-1" }] })
        .mockResolvedValue({ rows: [] }),
    };

    await expect(
      persistProvisioningFailure({
        queryable,
        job: { attemptsMade: 4, opts: { attempts: 5 } },
        agentId: "agent-1",
        name: "Demo Agent",
        error: new Error("still unavailable"),
      }),
    ).resolves.toEqual({ canceled: false, terminal: true });

    expect(queryable.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(queryable.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1",
      ["agent-1"],
    );
  });

  it("forces terminal state on the first attempt when a prior runtime cannot be reconciled", async () => {
    const queryable = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "agent-1" }] })
        .mockResolvedValue({ rows: [] }),
    };

    await expect(
      persistProvisioningFailure({
        queryable,
        job: { attemptsMade: 0, opts: { attempts: 5 } },
        agentId: "agent-1",
        name: "Demo Agent",
        error: Object.assign(new Error("runtime cleanup failed"), { containerId: "108" }),
        forceTerminal: true,
      }),
    ).resolves.toEqual({ canceled: false, terminal: true });

    expect(queryable.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(queryable.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/status = 'queued'/),
      expect.anything(),
    );
  });

  it("makes an active job harmless after the agent row was deleted", async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      persistProvisioningFailure({
        queryable,
        job: { attemptsMade: 0, opts: { attempts: 5 } },
        agentId: "deleted-agent",
        name: "Deleted Agent",
        error: new Error("create failed after delete"),
      }),
    ).resolves.toEqual({ canceled: true, terminal: false });

    expect(queryable.query).toHaveBeenCalledTimes(1);
    expect(queryable.query).toHaveBeenCalledWith("SELECT id FROM agents WHERE id = $1", [
      "deleted-agent",
    ]);
  });

  it("destroys a created runtime before clearing persisted identity after failure", async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const provisioner = { destroy: jest.fn().mockResolvedValue(undefined) };

    await expect(
      cleanupProvisionedRuntimeAfterFailure({
        queryable,
        provisioner,
        agentId: "agent-1",
        containerId: "nora-oclaw-agent-1",
      }),
    ).resolves.toEqual({ destroyed: true, retrySafe: true });

    expect(provisioner.destroy).toHaveBeenCalledWith("nora-oclaw-agent-1", {
      agentId: "agent-1",
    });
    expect(queryable.query).toHaveBeenCalledWith(expect.stringMatching(/SET container_id = NULL/), [
      "agent-1",
      "nora-oclaw-agent-1",
    ]);
    expect(provisioner.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      queryable.query.mock.invocationCallOrder[0],
    );
  });

  it("preserves runtime identity when cleanup cannot destroy the container", async () => {
    const queryable = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: "agent-1", container_id: "nora-oclaw-agent-1" }],
      }),
    };
    const provisioner = { destroy: jest.fn().mockRejectedValue(new Error("Docker unavailable")) };

    await expect(
      cleanupProvisionedRuntimeAfterFailure({
        queryable,
        provisioner,
        agentId: "agent-1",
        containerId: "nora-oclaw-agent-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        destroyed: false,
        reason: "destroy-failed",
        retrySafe: false,
        identityPersisted: true,
      }),
    );

    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringMatching(/container_id = COALESCE\(container_id, \$2\)/),
      ["agent-1", "nora-oclaw-agent-1", null],
    );
  });

  it("never destroys a runtime whose ownership was not verified and suppresses retry", async () => {
    const queryable = { query: jest.fn() };
    const provisioner = { destroy: jest.fn() };

    await expect(
      cleanupProvisionedRuntimeAfterFailure({
        queryable,
        provisioner,
        agentId: "agent-1",
        containerId: "108",
        destroyAllowed: false,
        persistIdentity: false,
      }),
    ).resolves.toEqual({
      destroyed: false,
      reason: "destroy-not-authorized",
      retrySafe: false,
      identityPersisted: false,
    });

    expect(provisioner.destroy).not.toHaveBeenCalled();
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("refuses to provision a replacement while a prior runtime identity remains", async () => {
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "proxmox",
              runtime_family: "openclaw",
              deploy_target: "proxmox",
              execution_target_id: "proxmox",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: "108",
            },
          ],
        };
      }
      if (sql === "SELECT id FROM agents WHERE id = $1") {
        return { rows: [{ id: "agent-1" }] };
      }
      return { rows: [] };
    });

    await expect(
      mockDeploymentProcessor({
        id: "deploy-agent-1",
        data: {
          id: "agent-1",
          name: "Demo Agent",
          userId: "user-1",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 1,
        opts: { attempts: 5 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "UNRESOLVED_RUNTIME_IDENTITY",
      containerId: "108",
    });

    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(
      mockWorkerDb.query.mock.calls.some(([sql]) => String(sql).includes("status = 'deploying'")),
    ).toBe(false);
    expect(mockLockClient.end).toHaveBeenCalledTimes(1);
  });
});
