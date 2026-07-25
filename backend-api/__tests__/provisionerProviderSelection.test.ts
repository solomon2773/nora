// @ts-nocheck
const { EventEmitter } = require("events");

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
const mockGetIntegrationEnvVars = jest.fn();
const mockGetIntegrationsForSync = jest.fn();
const mockGetEnabledMcpRuntimeState = jest.fn();
const mockWaitForAgentReadiness = jest.fn();
const mockAssertRemoteHostAgentUse = jest.fn();
const mockGetAgentSecretEnvVars = jest.fn();
const mockAllocateGatewayPort = jest.fn();
const mockReallocateGatewayPort = jest.fn();
const mockRemoteProvisioner = {
  create: jest.fn(),
  destroy: jest.fn(),
  restart: jest.fn(),
  updateEnv: jest.fn(),
};
const mockHermesProvisioner = {
  create: jest.fn(),
  destroy: jest.fn(),
  restart: jest.fn(),
  updateEnv: jest.fn(),
};
const mockContainerManager = {
  canDestroy: jest.fn(),
  destroy: jest.fn(),
};
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
jest.mock("../integrations", () => {
  const actual = jest.requireActual("../integrations");
  return {
    ...actual,
    getIntegrationEnvVars: (...args) => mockGetIntegrationEnvVars(...args),
    getIntegrationsForSync: (...args) => mockGetIntegrationsForSync(...args),
  };
});
jest.mock("../mcpServers", () => ({
  SUPPORTED_MCP_PROVIDERS: {},
  normalizeEnabledIds: jest.fn(() => []),
  getEnabledMcpRuntimeState: (...args) => mockGetEnabledMcpRuntimeState(...args),
  isSupportedProvider: jest.fn(() => false),
  resolveMcpEntries: jest.fn(() => []),
}));
jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: mockAssertRemoteHostAgentUse,
  isRemoteHostAccessRevokedError: (error) => error?.code === "REMOTE_HOST_ACCESS_REVOKED",
}));
jest.mock("../containerManager", () => mockContainerManager);
jest.mock("../agentSecretOverrides", () => ({
  getAgentSecretEnvVars: mockGetAgentSecretEnvVars,
}));
jest.mock("../portAllocations", () => ({
  allocateGatewayPort: mockAllocateGatewayPort,
  reallocateGatewayPort: mockReallocateGatewayPort,
  DEFAULT_RANGE_MIN: 19000,
  DEFAULT_RANGE_MAX: 19999,
  LOCAL_HOST_KEY: "local",
  GATEWAY_PORT_PURPOSE: "gateway",
  DASHBOARD_PORT_PURPOSE: "dashboard",
  RUNTIME_PORT_PURPOSE: "runtime",
}));
jest.mock("../../workers/provisioner/backends/remote-docker", () =>
  jest.fn().mockImplementation(() => mockRemoteProvisioner),
);
jest.mock("../../workers/provisioner/backends/hermes", () =>
  jest.fn().mockImplementation(() => mockHermesProvisioner),
);
jest.mock("../../workers/provisioner/healthChecks", () => ({
  waitForAgentReadiness: (...args) => mockWaitForAgentReadiness(...args),
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
  guardRemoteProvisioner,
  isRemoteAuthorizationFailure,
  isFinalDeploymentAttempt,
  persistProvisioningFailure,
  prepareReplacementRuntime,
  resolveCanonicalDeploymentOwnerUserId,
  runProvisionerExecCommand,
  seedHermesArchiveForDeployment,
} = require("../../workers/provisioner/worker");
const { DASHBOARD_PORT_PURPOSE, GATEWAY_PORT_PURPOSE } = require("../portAllocations");

beforeEach(() => {
  jest.clearAllMocks();
  mockWorkerDb.query.mockReset();
  mockLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockLockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockLockClient.end.mockReset().mockResolvedValue(undefined);
  mockGetDeploymentProvider.mockReset().mockResolvedValue(null);
  mockGetIntegrationEnvVars.mockReset().mockResolvedValue({});
  mockGetIntegrationsForSync.mockReset().mockResolvedValue([]);
  mockGetEnabledMcpRuntimeState.mockReset().mockResolvedValue({
    enabledIds: [],
    entries: [],
    desiredServers: {},
    env: {},
    managedEnvNames: [],
  });
  mockWaitForAgentReadiness.mockReset().mockResolvedValue({
    ok: true,
    runtime: { ok: true },
    gateway: { ok: true },
  });
  mockAssertRemoteHostAgentUse.mockReset().mockResolvedValue({
    id: "remote:test-host",
    executionTargetId: "remote:test-host",
    configured: true,
    enabled: true,
  });
  mockGetAgentSecretEnvVars.mockReset().mockResolvedValue({});
  mockAllocateGatewayPort.mockReset().mockResolvedValue(19123);
  mockReallocateGatewayPort.mockReset().mockResolvedValue(19124);
  mockRemoteProvisioner.create.mockReset();
  mockRemoteProvisioner.destroy.mockReset().mockResolvedValue(undefined);
  mockRemoteProvisioner.restart.mockReset().mockResolvedValue(undefined);
  mockRemoteProvisioner.updateEnv.mockReset().mockResolvedValue(undefined);
  mockHermesProvisioner.create.mockReset();
  mockHermesProvisioner.destroy.mockReset().mockResolvedValue(undefined);
  mockHermesProvisioner.restart.mockReset().mockResolvedValue(undefined);
  mockHermesProvisioner.updateEnv.mockReset().mockResolvedValue(undefined);
  delete mockHermesProvisioner.isHostPortBound;
  mockContainerManager.canDestroy
    .mockReset()
    .mockImplementation((agent) => Boolean(agent?.container_id || agent?.container_name));
  mockContainerManager.destroy.mockReset().mockResolvedValue(undefined);
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

describe("provisioner Hermes restore seeding", () => {
  it("fails closed when the attached Hermes manifest cannot be loaded", async () => {
    const loadError = new Error("migration database unavailable");

    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {},
        containerId: "hermes-container",
        loadManifest: jest.fn().mockRejectedValue(loadError),
      }),
    ).rejects.toMatchObject({
      code: "HERMES_SEED_MANIFEST_LOAD_FAILED",
      agentId: "agent-hermes-restore",
      cause: loadError,
    });
  });

  it("fails when an attached Hermes file manifest cannot be archived", async () => {
    const buildError = new Error("invalid workspace payload");

    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {},
        containerId: "hermes-container",
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [{}] } }),
        buildSeedArchive: jest.fn().mockRejectedValue(buildError),
      }),
    ).rejects.toMatchObject({
      code: "HERMES_SEED_ARCHIVE_BUILD_FAILED",
      cause: buildError,
    });
  });

  it("fails when an attached Hermes file archive cannot be uploaded", async () => {
    const uploadError = new Error("remote disk is read-only");
    const putArchive = jest.fn().mockRejectedValue(uploadError);

    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {
          docker: {
            getContainer: jest.fn().mockReturnValue({ putArchive }),
          },
        },
        containerId: "hermes-container",
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [{}] } }),
        buildSeedArchive: jest.fn().mockResolvedValue(Buffer.from("seed")),
        authorize: jest.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toMatchObject({
      code: "HERMES_SEED_ARCHIVE_UPLOAD_FAILED",
      cause: uploadError,
    });

    expect(putArchive).toHaveBeenCalledWith(Buffer.from("seed"), { path: "/" });
  });

  it("rejects a Hermes seed upload when Remote Docker access is revoked mid-transfer", async () => {
    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    const authorize = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(revoked);

    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {
          docker: {
            getContainer: jest.fn().mockReturnValue({
              putArchive: jest.fn().mockResolvedValue(undefined),
            }),
          },
        },
        containerId: "hermes-container",
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [{}] } }),
        buildSeedArchive: jest.fn().mockResolvedValue(Buffer.from("seed")),
        authorize,
        repairOwnership: jest.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toBe(revoked);

    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("repairs Hermes workspace ownership after uploading attached files", async () => {
    const provisioner = {
      docker: {
        getContainer: jest.fn().mockReturnValue({
          putArchive: jest.fn().mockResolvedValue(undefined),
        }),
      },
    };
    const authorize = jest.fn().mockResolvedValue(undefined);
    const repairOwnership = jest.fn().mockResolvedValue(undefined);

    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner,
        containerId: "hermes-container",
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [{}] } }),
        buildSeedArchive: jest.fn().mockResolvedValue(Buffer.from("seed")),
        authorize,
        repairOwnership,
      }),
    ).resolves.toEqual({ seeded: true, reason: null });

    expect(repairOwnership).toHaveBeenCalledWith(
      provisioner,
      "hermes-container",
      "agent-hermes-restore",
    );
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("fails when restored Hermes workspace ownership cannot be repaired", async () => {
    const repairError = new Error("chown exited with code 1");

    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {
          docker: {
            getContainer: jest.fn().mockReturnValue({
              putArchive: jest.fn().mockResolvedValue(undefined),
            }),
          },
        },
        containerId: "hermes-container",
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [{}] } }),
        buildSeedArchive: jest.fn().mockResolvedValue(Buffer.from("seed")),
        authorize: jest.fn().mockResolvedValue(undefined),
        repairOwnership: jest.fn().mockRejectedValue(repairError),
      }),
    ).rejects.toMatchObject({
      code: "HERMES_SEED_OWNERSHIP_REPAIR_FAILED",
      cause: repairError,
    });
  });

  it("fails when the created Hermes runtime cannot accept attached files", async () => {
    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {},
        containerId: null,
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [{}] } }),
        buildSeedArchive: jest.fn().mockResolvedValue(Buffer.from("seed")),
      }),
    ).rejects.toMatchObject({
      code: "HERMES_SEED_RUNTIME_UNAVAILABLE",
    });
  });

  it("allows a Hermes manifest with no workspace files", async () => {
    const buildSeedArchive = jest.fn();
    await expect(
      seedHermesArchiveForDeployment({
        agentId: "agent-hermes-restore",
        provisioner: {},
        containerId: "hermes-container",
        loadManifest: jest.fn().mockResolvedValue({ hermesSeed: { files: [] } }),
        buildSeedArchive,
      }),
    ).resolves.toEqual({ seeded: false, reason: "archive-empty" });

    expect(buildSeedArchive).not.toHaveBeenCalled();
  });
});

describe("provisioner deployment lifecycle", () => {
  it("destroys the exact previous Remote Docker runtime before committing replacement placement", async () => {
    const agentRow = {
      id: "agent-1",
      user_id: "owner-1",
      runtime_family: "openclaw",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:old-host",
      sandbox_profile: "standard",
      container_id: "old-container",
      container_name: "old-container-name",
      host: "10.0.0.12",
      status: "deploying",
    };
    const desired = {
      runtime_family: "hermes",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:new-host",
      sandbox_profile: "standard",
    };
    const queryable = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            ...agentRow,
            ...desired,
            container_id: null,
            container_name: "new-container-name",
            host: null,
            image: "nousresearch/hermes-agent:latest",
          },
        ],
      }),
    };

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: "agent-1",
        agentRow,
        name: "Shared Agent",
        jobData: {
          replace_existing_runtime: true,
          container_name: "new-container-name",
          previous_container_id: "old-container",
          previous_container_name: "old-container-name",
          previous_host: "10.0.0.12",
          previous_backend: "remote-docker",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "remote-docker",
          previous_execution_target_id: "remote:old-host",
          previous_sandbox_profile: "standard",
        },
        resolvedRuntimeFields: desired,
        resolvedImage: "nousresearch/hermes-agent:latest",
      }),
    ).resolves.toEqual(expect.objectContaining({ replacement: true }));

    expect(mockContainerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        user_id: "owner-1",
        container_id: "old-container",
        container_name: "old-container-name",
        host: "10.0.0.12",
        deploy_target: "remote-docker",
        execution_target_id: "remote:old-host",
      }),
    );
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringMatching(/container_id IS NOT DISTINCT FROM \$10/),
      [
        "agent-1",
        "remote-docker",
        "standard",
        "hermes",
        "remote-docker",
        "remote:new-host",
        "standard",
        "new-container-name",
        "nousresearch/hermes-agent:latest",
        "old-container",
        "old-container-name",
        "remote-docker",
        "openclaw",
        "remote-docker",
        "remote:old-host",
        "standard",
        "10.0.0.12",
      ],
    );
    expect(agentRow).toEqual(
      expect.objectContaining({
        container_id: null,
        execution_target_id: "remote:new-host",
        runtime_family: "hermes",
      }),
    );
  });

  it("refuses replacement when the queued previous runtime differs from durable identity", async () => {
    const queryable = { query: jest.fn() };

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: "agent-1",
        agentRow: {
          id: "agent-1",
          user_id: "owner-1",
          status: "deploying",
          container_id: "durable-container",
          deploy_target: "docker",
          execution_target_id: "docker",
          runtime_family: "openclaw",
          sandbox_profile: "standard",
        },
        jobData: {
          replace_existing_runtime: true,
          previous_container_id: "different-container",
          previous_container_name: null,
          previous_host: null,
          previous_backend: "docker",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "docker",
          previous_execution_target_id: "docker",
          previous_sandbox_profile: "standard",
        },
        resolvedRuntimeFields: {
          runtime_family: "openclaw",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          sandbox_profile: "standard",
        },
        resolvedImage: "nora-openclaw-agent:local",
      }),
    ).rejects.toMatchObject({ code: "REPLACEMENT_RUNTIME_IDENTITY_MISMATCH" });

    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("refuses replacement when the queued previous host differs from durable runtime state", async () => {
    const queryable = { query: jest.fn() };

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: "agent-host-mismatch",
        agentRow: {
          id: "agent-host-mismatch",
          user_id: "owner-1",
          status: "deploying",
          container_id: "durable-container",
          container_name: "durable-name",
          host: "durable-runtime.default.svc.cluster.local",
          backend_type: "k8s",
          deploy_target: "k8s",
          execution_target_id: "k8s:cluster-1",
          runtime_family: "openclaw",
          sandbox_profile: "standard",
        },
        jobData: {
          replace_existing_runtime: true,
          previous_container_id: "durable-container",
          previous_container_name: "durable-name",
          previous_host: "durable-runtime.stale.svc.cluster.local",
          previous_backend: "k8s",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "k8s",
          previous_execution_target_id: "k8s:cluster-1",
          previous_sandbox_profile: "standard",
        },
        resolvedRuntimeFields: {
          runtime_family: "openclaw",
          backend_type: "k8s",
          deploy_target: "k8s",
          execution_target_id: "k8s:cluster-1",
          sandbox_profile: "standard",
        },
        resolvedImage: "nora-openclaw-agent:local",
      }),
    ).rejects.toMatchObject({ code: "REPLACEMENT_RUNTIME_IDENTITY_MISMATCH" });

    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it.each([
    ["previous_backend", "remote-docker"],
    ["previous_runtime_family", "hermes"],
    ["previous_deploy_target", "k8s"],
    ["previous_execution_target_id", "remote:other-host"],
    ["previous_sandbox_profile", "nemoclaw"],
  ])("refuses replacement when queued %s differs from durable placement", async (field, value) => {
    const queryable = { query: jest.fn() };
    const jobData = {
      replace_existing_runtime: true,
      previous_container_id: "durable-container",
      previous_container_name: "durable-name",
      previous_host: null,
      previous_backend: "docker",
      previous_runtime_family: "openclaw",
      previous_deploy_target: "docker",
      previous_execution_target_id: "docker",
      previous_sandbox_profile: "standard",
      [field]: value,
    };

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: "agent-tuple-mismatch",
        agentRow: {
          id: "agent-tuple-mismatch",
          user_id: "owner-1",
          status: "deploying",
          container_id: "durable-container",
          container_name: "durable-name",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          runtime_family: "openclaw",
          sandbox_profile: "standard",
        },
        jobData,
        resolvedRuntimeFields: {
          runtime_family: "openclaw",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          sandbox_profile: "standard",
        },
        resolvedImage: "nora-openclaw-agent:local",
      }),
    ).rejects.toMatchObject({ code: "REPLACEMENT_RUNTIME_TUPLE_MISMATCH" });

    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("fails closed for a non-Kubernetes name-only runtime that cannot be destroyed", async () => {
    const queryable = { query: jest.fn() };
    mockContainerManager.canDestroy.mockReturnValueOnce(false);

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: "agent-name-only",
        agentRow: {
          id: "agent-name-only",
          user_id: "owner-1",
          status: "deploying",
          container_id: null,
          container_name: "nora-oclaw-name-only",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          runtime_family: "openclaw",
          sandbox_profile: "standard",
        },
        jobData: {
          replace_existing_runtime: true,
          previous_container_id: null,
          previous_container_name: "nora-oclaw-name-only",
          previous_host: null,
          previous_backend: "docker",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "docker",
          previous_execution_target_id: "docker",
          previous_sandbox_profile: "standard",
        },
        resolvedRuntimeFields: {
          runtime_family: "openclaw",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          sandbox_profile: "standard",
        },
        resolvedImage: "nora-openclaw-agent:local",
      }),
    ).rejects.toMatchObject({ code: "REPLACEMENT_RUNTIME_DESTROY_UNAVAILABLE" });

    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("destroys a Kubernetes runtime by deterministic name fallback when persisted ids are empty", async () => {
    mockContainerManager.canDestroy.mockImplementationOnce(
      (agent) => agent.deploy_target === "k8s" && Boolean(agent.id),
    );
    const agentRow = {
      id: "agent-k8s-fallback",
      name: "Kubernetes Fallback",
      user_id: "owner-1",
      status: "deploying",
      container_id: null,
      container_name: null,
      host: null,
      backend_type: "k8s",
      deploy_target: "k8s",
      execution_target_id: "k8s:cluster-1",
      runtime_family: "openclaw",
      sandbox_profile: "standard",
    };
    const queryable = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            ...agentRow,
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            container_name: "nora-oclaw-kubernetes-fallback-agent-k8s-fallback",
          },
        ],
      }),
    };

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: agentRow.id,
        agentRow,
        name: agentRow.name,
        jobData: {
          replace_existing_runtime: true,
          container_name: "nora-oclaw-kubernetes-fallback-agent-k8s-fallback",
          previous_container_id: null,
          previous_container_name: null,
          previous_host: null,
          previous_backend: "k8s",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "k8s",
          previous_execution_target_id: "k8s:cluster-1",
          previous_sandbox_profile: "standard",
        },
        resolvedRuntimeFields: {
          runtime_family: "openclaw",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          sandbox_profile: "standard",
        },
        resolvedImage: "nora-openclaw-agent:local",
      }),
    ).resolves.toEqual(expect.objectContaining({ replacement: true }));

    expect(mockContainerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-fallback",
        name: "Kubernetes Fallback",
        deploy_target: "k8s",
        execution_target_id: "k8s:cluster-1",
        container_id: null,
        container_name: null,
      }),
    );
  });

  it("refuses a duplicate replacement after the durable previous identity was cleared", async () => {
    const queryable = { query: jest.fn() };

    await expect(
      prepareReplacementRuntime({
        queryable,
        agentId: "agent-1",
        agentRow: {
          id: "agent-1",
          user_id: "owner-1",
          status: "deploying",
          container_id: null,
          container_name: "new-container-name",
          deploy_target: "docker",
          execution_target_id: "docker",
          runtime_family: "openclaw",
          sandbox_profile: "standard",
        },
        jobData: {
          replace_existing_runtime: true,
          previous_container_id: "old-container",
          previous_container_name: "old-container-name",
          previous_host: null,
          previous_backend: "docker",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "docker",
          previous_execution_target_id: "docker",
          previous_sandbox_profile: "standard",
        },
        resolvedRuntimeFields: {
          runtime_family: "openclaw",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
          sandbox_profile: "standard",
        },
        resolvedImage: "nora-openclaw-agent:local",
      }),
    ).rejects.toMatchObject({ code: "REPLACEMENT_RUNTIME_IDENTITY_MISMATCH" });

    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("terminalizes a replacement when placement persistence fails after destroying the old runtime", async () => {
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "remote-docker",
              runtime_family: "openclaw",
              deploy_target: "remote-docker",
              execution_target_id: "remote:old-host",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: "old-container",
              container_name: "old-container-name",
              host: "10.0.0.12",
              user_id: "owner-1",
            },
          ],
        };
      }
      if (text.includes("SET container_id = NULL") && text.includes("status = 'deploying'")) {
        throw new Error("database write failed after destroy");
      }
      if (text === "SELECT id FROM agents WHERE id = $1") {
        return { rows: [{ id: "agent-1" }] };
      }
      return { rows: [] };
    });

    await expect(
      mockDeploymentProcessor({
        id: "deploy-agent-1",
        data: {
          id: "agent-1",
          name: "Remote Agent",
          userId: "owner-1",
          replace_existing_runtime: true,
          backend: "remote-docker",
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: "remote:new-host",
          sandbox_profile: "standard",
          previous_container_id: "old-container",
          previous_container_name: "old-container-name",
          previous_host: "10.0.0.12",
          previous_backend: "remote-docker",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "remote-docker",
          previous_execution_target_id: "remote:old-host",
          previous_sandbox_profile: "standard",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "REPLACEMENT_RUNTIME_STATE_PERSIST_FAILED",
      previousRuntimeDestroyed: true,
    });

    expect(mockContainerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ container_id: "old-container" }),
    );
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1",
      ["agent-1"],
    );
    expect(mockRemoteProvisioner.create).not.toHaveBeenCalled();
  });

  it("revalidates every Remote Docker adapter operation while leaving destroy available for cleanup", async () => {
    const baseProvisioner = {
      exec: jest.fn().mockResolvedValue({ ok: true }),
      restart: jest.fn().mockResolvedValue(undefined),
      updateEnv: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    const runtimeFields = {
      runtime_family: "openclaw",
      deploy_target: "remote-docker",
      execution_target_id: "remote:test-host",
      sandbox_profile: "standard",
      backend_type: "remote-docker",
    };
    const provisioner = guardRemoteProvisioner(baseProvisioner, runtimeFields, "user-1");

    await expect(provisioner.exec("container-1", {})).resolves.toEqual({ ok: true });
    await expect(provisioner.restart("container-1", {})).resolves.toBeUndefined();
    await expect(provisioner.updateEnv("container-1", {}, {})).resolves.toBeUndefined();

    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(3);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        deploy_target: "remote-docker",
        execution_target_id: "remote:test-host",
      }),
      { includeProfile: false },
    );

    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockAssertRemoteHostAgentUse.mockRejectedValue(revoked);

    let denied;
    try {
      await provisioner.restart("container-1", {});
    } catch (error) {
      denied = error;
    }
    expect(denied).toMatchObject({
      name: "UnrecoverableError",
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    expect(isRemoteAuthorizationFailure(denied)).toBe(true);
    expect(
      isRemoteAuthorizationFailure(Object.assign(new Error("wrapped"), { cause: denied })),
    ).toBe(true);

    const checksBeforeCleanup = mockAssertRemoteHostAgentUse.mock.calls.length;
    await expect(
      provisioner.destroy("container-1", { agentId: "agent-1" }),
    ).resolves.toBeUndefined();
    expect(baseProvisioner.destroy).toHaveBeenCalledWith("container-1", { agentId: "agent-1" });
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(checksBeforeCleanup);
  });

  it("terminates a long-running Remote Docker exec when its grant is revoked", async () => {
    jest.useFakeTimers();
    try {
      const stream = new EventEmitter();
      stream.destroy = jest.fn();
      const execHandle = {
        inspect: jest.fn().mockResolvedValue({ Running: true, ExitCode: null }),
      };
      const cleanupStream = new EventEmitter();
      const baseProvisioner = {
        exec: jest
          .fn()
          .mockResolvedValueOnce({ exec: execHandle, stream })
          .mockResolvedValueOnce({
            exec: {
              inspect: jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 }),
            },
            stream: cleanupStream,
          }),
        destroy: jest.fn(),
      };
      cleanupStream.resume = jest.fn(() => {
        const trackedCommand = baseProvisioner.exec.mock.calls[0][1].cmd[2];
        const commandId = trackedCommand.match(/\.nora-worker-exec-([a-f0-9]{32})/)?.[1];
        queueMicrotask(() => {
          cleanupStream.emit("data", Buffer.from(`NORA_EXEC_CLEANUP_OK:${commandId}\n`));
          cleanupStream.emit("end");
        });
      });
      const provisioner = guardRemoteProvisioner(
        baseProvisioner,
        {
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: "remote:test-host",
          sandbox_profile: "standard",
          backend_type: "remote-docker",
        },
        "user-1",
      );

      const commandPromise = runProvisionerExecCommand(
        provisioner,
        "remote-container-1",
        "sleep 60",
        { timeout: 10000, agentId: "agent-1" },
      );
      const rejection = expect(commandPromise).rejects.toMatchObject({
        name: "UnrecoverableError",
        code: "REMOTE_HOST_ACCESS_REVOKED",
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(baseProvisioner.exec).toHaveBeenCalledTimes(1);

      mockAssertRemoteHostAgentUse.mockRejectedValue(
        Object.assign(new Error("Remote host access was revoked"), {
          code: "REMOTE_HOST_ACCESS_REVOKED",
          statusCode: 403,
        }),
      );
      await jest.advanceTimersByTimeAsync(2500);

      await rejection;
      expect(stream.destroy).toHaveBeenCalledTimes(1);
      expect(execHandle.inspect).toHaveBeenCalled();
      expect(baseProvisioner.exec).toHaveBeenCalledTimes(2);
      const trackedCommand = baseProvisioner.exec.mock.calls[0][1].cmd[2];
      const cleanupCommand = baseProvisioner.exec.mock.calls[1][1].cmd[2];
      expect(trackedCommand).toContain("sleep 60");
      expect(trackedCommand).toMatch(/\.nora-worker-exec-[a-f0-9]{32}/);
      expect(cleanupCommand).not.toContain("sleep 60");
      expect(cleanupCommand).toContain("kill -TERM");
      expect(cleanupCommand).toContain("kill -KILL");
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects a queued deployment whose claimed user differs from the persisted owner", async () => {
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "docker",
              runtime_family: "openclaw",
              deploy_target: "docker",
              execution_target_id: "docker",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: null,
              user_id: "owner-1",
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
          name: "Tampered Agent",
          userId: "workspace-editor-1",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "DEPLOYMENT_OWNER_MISMATCH",
    });

    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1",
      ["agent-1"],
    );
    expect(mockGetDeploymentProvider).not.toHaveBeenCalled();
    expect(mockLockClient.end).toHaveBeenCalledTimes(1);
  });

  it("uses the persisted owner for legacy jobs that omit userId", () => {
    expect(
      resolveCanonicalDeploymentOwnerUserId(
        { id: "agent-1" },
        { id: "agent-1", user_id: "owner-1" },
      ),
    ).toBe("owner-1");
  });

  it("forces terminal agent and deployment state when Remote Docker access is denied before create", async () => {
    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockAssertRemoteHostAgentUse.mockRejectedValue(revoked);
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "remote-docker",
              runtime_family: "openclaw",
              deploy_target: "remote-docker",
              execution_target_id: "remote:test-host",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: null,
              user_id: "user-1",
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
          name: "Remote Agent",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });

    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1",
      ["agent-1"],
    );
    expect(
      mockWorkerDb.query.mock.calls.some(([sql]) => String(sql).includes("status = 'queued'")),
    ).toBe(false);
    expect(
      mockWorkerDb.query.mock.calls.some(([sql]) => String(sql).includes("status = 'deploying'")),
    ).toBe(false);
    expect(mockLockClient.end).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous runtime identity when replacement-target authorization fails", async () => {
    const revoked = Object.assign(new Error("New remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockAssertRemoteHostAgentUse.mockRejectedValue(revoked);
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "remote-docker",
              runtime_family: "openclaw",
              deploy_target: "remote-docker",
              execution_target_id: "remote:old-host",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: "old-container",
              container_name: "old-container-name",
              host: "10.0.0.12",
              user_id: "owner-1",
            },
          ],
        };
      }
      if (text === "SELECT id FROM agents WHERE id = $1") {
        return { rows: [{ id: "agent-1" }] };
      }
      return { rows: [] };
    });

    await expect(
      mockDeploymentProcessor({
        id: "deploy-agent-1",
        data: {
          id: "agent-1",
          name: "Remote Agent",
          userId: "owner-1",
          replace_existing_runtime: true,
          backend: "remote-docker",
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: "remote:new-host",
          sandbox_profile: "standard",
          previous_container_id: "old-container",
          previous_container_name: "old-container-name",
          previous_host: "10.0.0.12",
          previous_backend: "remote-docker",
          previous_runtime_family: "openclaw",
          previous_deploy_target: "remote-docker",
          previous_execution_target_id: "remote:old-host",
          previous_sandbox_profile: "standard",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });

    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(
      mockWorkerDb.query.mock.calls.some(([sql]) =>
        String(sql).includes("container_name IS NOT DISTINCT FROM $11"),
      ),
    ).toBe(false);
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
  });

  it("destroys a just-created Remote Docker runtime and suppresses retry when access is revoked during create", async () => {
    const allowedProfile = {
      id: "test-host",
      executionTargetId: "remote:test-host",
      configured: true,
      enabled: true,
    };
    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce(allowedProfile)
      .mockResolvedValueOnce(allowedProfile)
      .mockResolvedValueOnce(allowedProfile)
      .mockRejectedValueOnce(revoked);
    mockRemoteProvisioner.create.mockImplementationOnce(async (config) => {
      await config.onRuntimeIdentity({
        containerId: "remote-container-1",
        containerName: "nora-oclaw-remote-agent-agent-1",
      });
      return {
        containerId: "remote-container-1",
        containerName: "nora-oclaw-remote-agent-agent-1",
        host: "remote.example.test",
        runtimeHost: "remote.example.test",
        runtimePort: 19124,
        gatewayHost: "remote.example.test",
        gatewayPort: 19123,
        gatewayHostPort: 19123,
        gatewayToken: "runtime-token",
      };
    });
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      const normalizedSql = String(sql);
      if (normalizedSql.includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "remote-docker",
              runtime_family: "openclaw",
              deploy_target: "remote-docker",
              execution_target_id: "remote:test-host",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: null,
              user_id: "user-1",
            },
          ],
        };
      }
      if (normalizedSql.includes("FROM llm_providers")) return { rows: [] };
      if (normalizedSql.includes("FROM integrations")) return { rows: [] };
      if (normalizedSql === "SELECT status FROM agents WHERE id = $1") {
        return { rows: [{ status: "deploying" }] };
      }
      if (normalizedSql.includes("RETURNING id, container_id")) {
        return { rows: [{ id: "agent-1", container_id: "remote-container-1" }] };
      }
      if (normalizedSql === "SELECT id FROM agents WHERE id = $1") {
        return { rows: [{ id: "agent-1" }] };
      }
      return { rows: [] };
    });

    await expect(
      mockDeploymentProcessor({
        id: "deploy-agent-1",
        data: {
          id: "agent-1",
          name: "Remote Agent",
          userId: "user-1",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5, timeout: 900000 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });

    expect(mockRemoteProvisioner.create).toHaveBeenCalledTimes(1);
    expect(mockGetDeploymentProvider).toHaveBeenCalledWith("user-1", null, mockWorkerDb);
    expect(mockRemoteProvisioner.destroy).toHaveBeenCalledWith("remote-container-1", {
      agentId: "agent-1",
    });
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      expect.stringMatching(/SET container_id = NULL/),
      ["agent-1", "remote-container-1"],
    );
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error' WHERE id = $1",
      ["agent-1"],
    );
    expect(mockWorkerDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1",
      ["agent-1"],
    );
    expect(mockLockClient.end).toHaveBeenCalledTimes(1);
  });

  it("treats integration-backed LLM credential changes as provider fingerprint drift", async () => {
    mockGetIntegrationEnvVars
      .mockResolvedValueOnce({ OPENAI_API_KEY: "integration-provider-v1" })
      .mockResolvedValueOnce({ OPENAI_API_KEY: "integration-provider-v2" });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    });
    mockRemoteProvisioner.create.mockImplementationOnce(async (config) => {
      await config.onRuntimeIdentity({
        containerId: "remote-container-fingerprint",
        containerName: "nora-oclaw-fingerprint-agent",
      });
      return {
        containerId: "remote-container-fingerprint",
        containerName: "nora-oclaw-fingerprint-agent",
        host: "remote.example.test",
        runtimeHost: "remote.example.test",
        runtimePort: 19124,
        gatewayHost: "remote.example.test",
        gatewayPort: 19123,
        gatewayHostPort: 19123,
        gatewayToken: "runtime-token",
      };
    });
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      const normalizedSql = String(sql);
      if (normalizedSql.includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "ghcr.io/example/openclaw:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "remote-docker",
              runtime_family: "openclaw",
              deploy_target: "remote-docker",
              execution_target_id: "remote:test-host",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: null,
              user_id: "user-1",
            },
          ],
        };
      }
      if (normalizedSql.includes("FROM llm_providers")) return { rows: [] };
      if (normalizedSql.includes("FROM integrations")) return { rows: [] };
      if (normalizedSql === "SELECT status FROM agents WHERE id = $1") {
        return { rows: [{ status: "deploying" }] };
      }
      if (normalizedSql.includes("RETURNING id, container_id")) {
        return {
          rows: [{ id: "agent-1", container_id: "remote-container-fingerprint" }],
        };
      }
      if (normalizedSql === "SELECT id FROM agents WHERE id = $1") {
        return { rows: [{ id: "agent-1" }] };
      }
      return { rows: [] };
    });

    try {
      await expect(
        mockDeploymentProcessor({
          id: "deploy-agent-fingerprint",
          data: {
            id: "agent-1",
            name: "Fingerprint Agent",
            userId: "user-1",
            specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
          },
          attemptsMade: 0,
          opts: { attempts: 1, timeout: 900000 },
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_STATE_UNSTABLE" });

      expect(mockGetIntegrationEnvVars).toHaveBeenCalledTimes(2);
      expect(mockRemoteProvisioner.updateEnv).toHaveBeenCalledWith(
        "remote-container-fingerprint",
        expect.objectContaining({ OPENAI_API_KEY: "integration-provider-v1" }),
        expect.objectContaining({
          agentId: "agent-1",
          runtimeFamily: "openclaw",
        }),
      );
      expect(mockRemoteProvisioner.restart).toHaveBeenCalledWith("remote-container-fingerprint", {
        agentId: "agent-1",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

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

  function queueLocalHermesAgentRow(overrides = {}) {
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockImplementation(async (sql) => {
      const normalizedSql = String(sql);
      if (normalizedSql.includes("SELECT image, template_payload")) {
        return {
          rows: [
            {
              image: "nousresearch/hermes-agent:latest",
              template_payload: {},
              sandbox_type: "standard",
              backend_type: "docker",
              runtime_family: "hermes",
              deploy_target: "docker",
              execution_target_id: "docker",
              sandbox_profile: "standard",
              gateway_token: null,
              mcp_servers: [],
              status: "queued",
              container_id: null,
              user_id: "user-1",
              ...overrides,
            },
          ],
        };
      }
      if (normalizedSql.includes("FROM llm_providers")) return { rows: [] };
      if (normalizedSql.includes("FROM integrations")) return { rows: [] };
      if (normalizedSql === "SELECT status FROM agents WHERE id = $1") {
        return { rows: [{ status: "deploying" }] };
      }
      if (normalizedSql.includes("RETURNING id, container_id")) {
        return { rows: [{ id: "agent-1", container_id: "hermes-local-container-1" }] };
      }
      if (normalizedSql === "SELECT id FROM agents WHERE id = $1") {
        return { rows: [{ id: "agent-1" }] };
      }
      return { rows: [] };
    });
  }

  function runLocalHermesDeployment() {
    // The dashboard/gateway port allocation happens before the runtime is
    // reachable; forcing a post-create authorization failure lets the test
    // observe the create() call args without modeling the entire rest of the
    // successful-deployment pipeline (health checks, MCP sync, final status
    // updates), matching the pattern used by the Remote Docker tests above.
    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ configured: true, enabled: true })
      .mockRejectedValueOnce(revoked);
    mockHermesProvisioner.create.mockImplementationOnce(async (config) => {
      await config.onRuntimeIdentity({
        containerId: "hermes-local-container-1",
        containerName: "nora-hermes-local-agent-agent-1",
      });
      return {
        containerId: "hermes-local-container-1",
        containerName: "nora-hermes-local-agent-agent-1",
        host: "10.0.0.9",
        runtimeHost: "10.0.0.9",
        runtimePort: 8642,
        gatewayHost: "10.0.0.9",
        gatewayPort: 8642,
        gatewayHostPort: config.gatewayHostPort,
        gatewayToken: "runtime-token",
        dashboardPort: config.dashboardHostPort,
      };
    });

    return expect(
      mockDeploymentProcessor({
        id: "deploy-agent-1",
        data: {
          id: "agent-1",
          name: "Local Hermes Agent",
          userId: "user-1",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5, timeout: 900000 },
      }),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
  }

  it("allocates a dashboard host port for local Docker Hermes", async () => {
    const allocations = [];
    mockAllocateGatewayPort.mockImplementation(async ({ purpose }) => {
      const port = purpose === DASHBOARD_PORT_PURPOSE ? 19044 : 19500;
      allocations.push({ purpose: purpose || GATEWAY_PORT_PURPOSE, port });
      return port;
    });
    queueLocalHermesAgentRow();

    await runLocalHermesDeployment();

    expect(mockHermesProvisioner.create).toHaveBeenCalledTimes(1);
    const createArgs = mockHermesProvisioner.create.mock.calls[0][0];
    expect(createArgs.gatewayHostPort).toBe(19500);
    expect(createArgs.dashboardHostPort).toBe(19044);

    const purposes = allocations.map((a) => a.purpose);
    expect(purposes).toContain(GATEWAY_PORT_PURPOSE);
    expect(purposes).toContain(DASHBOARD_PORT_PURPOSE);
  });

  it("reallocates the local Docker Hermes dashboard port when it is already bound outside Nora's allocation table", async () => {
    mockAllocateGatewayPort.mockImplementation(async ({ purpose }) =>
      purpose === DASHBOARD_PORT_PURPOSE ? 19044 : 19500,
    );
    mockReallocateGatewayPort.mockImplementation(async ({ purpose }) =>
      purpose === DASHBOARD_PORT_PURPOSE ? 19045 : 19501,
    );
    mockHermesProvisioner.isHostPortBound = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    queueLocalHermesAgentRow();

    await runLocalHermesDeployment();

    expect(mockHermesProvisioner.isHostPortBound).toHaveBeenCalledWith(19044, expect.any(Object));
    expect(mockReallocateGatewayPort).toHaveBeenCalledWith(
      expect.objectContaining({
        hostKey: "local",
        agentId: "agent-1",
        previousPort: 19044,
        purpose: DASHBOARD_PORT_PURPOSE,
      }),
    );
    const createArgs = mockHermesProvisioner.create.mock.calls[0][0];
    expect(createArgs.dashboardHostPort).toBe(19045);
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

  it("automatically treats unrecoverable first-attempt failures as terminal", async () => {
    const queryable = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "agent-1" }] })
        .mockResolvedValue({ rows: [] }),
    };
    const error = Object.assign(new Error("replacement state changed"), {
      name: "UnrecoverableError",
      code: "REPLACEMENT_RUNTIME_STATE_CHANGED",
    });

    await expect(
      persistProvisioningFailure({
        queryable,
        job: { attemptsMade: 0, opts: { attempts: 5 } },
        agentId: "agent-1",
        name: "Demo Agent",
        error,
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

  it("does not run a queued job after another flow terminalized the agent", async () => {
    mockLockClient.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    mockWorkerDb.query.mockResolvedValueOnce({
      rows: [
        {
          image: "ghcr.io/example/openclaw:latest",
          template_payload: {},
          sandbox_type: "standard",
          backend_type: "remote-docker",
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: "remote:test-host",
          sandbox_profile: "standard",
          gateway_token: null,
          mcp_servers: [],
          status: "error",
          container_id: null,
          user_id: "owner-1",
        },
      ],
    });

    await expect(
      mockDeploymentProcessor({
        id: "deploy-agent-1",
        data: {
          id: "agent-1",
          name: "Terminal Agent",
          userId: "owner-1",
          specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }),
    ).resolves.toEqual({ canceled: true, reason: "agent-error" });

    expect(mockAssertRemoteHostAgentUse).not.toHaveBeenCalled();
    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(mockRemoteProvisioner.create).not.toHaveBeenCalled();
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
              user_id: "user-1",
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
    expect(
      mockWorkerDb.query.mock.calls.find(([sql]) =>
        String(sql).includes("SELECT image, template_payload"),
      )?.[0],
    ).toMatch(/\buser_id\b/);
    expect(mockLockClient.end).toHaveBeenCalledTimes(1);
  });
});
