// @ts-nocheck
process.env.NORA_BACKUP_ENCRYPTION_KEY = "0".repeat(64);

const mockProvisionLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockProvisionLockClient);
const mockDb = { query: jest.fn() };
const mockAddDeploymentJob = jest.fn();
const mockCancelDeploymentJobsForAgent = jest.fn();
const mockContainerManager = {
  canDestroy: jest.fn(),
  destroy: jest.fn(),
};
const mockAssertKubernetesExecutionTargetAvailable = jest.fn();
const mockAssertRemoteHostAgentUse = jest.fn();
const mockAssertRemoteHostExecutionTargetAvailable = jest.fn();
const mockIsRemoteDockerAgent = jest.fn();
const mockToPublicRemoteHostAuthorizationError = jest.fn();
const mockBuildMigrationManifestFromAgent = jest.fn();
const mockMaterializeManagedMigrationState = jest.fn();
const mockPersistMigrationManifestForAgent = jest.fn();
const mockPackMigrationBundle = jest.fn();
const mockParseUploadedMigrationBuffer = jest.fn();
const mockMaterializeTemplateWiring = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("pg", () => ({ Client: mockPgClient }));
jest.mock("../redisQueue", () => ({
  addBackupJob: jest.fn(),
  addDeploymentJob: mockAddDeploymentJob,
  cancelDeploymentJobsForAgent: mockCancelDeploymentJobsForAgent,
}));
jest.mock("../containerManager", () => mockContainerManager);
jest.mock("../platformSettings", () => ({
  getBackupSettings: jest.fn(async () => ({})),
  getBackupStorageConfig: jest.fn(async () => ({
    storageBackend: "local",
    localPath: "/tmp/test-backups",
  })),
}));
jest.mock("../billing", () => ({
  getEffectiveSubscription: jest.fn(),
}));
jest.mock("../agentMigrations", () => ({
  buildMigrationManifestFromAgent: mockBuildMigrationManifestFromAgent,
  createMigrationDraft: jest.fn(),
  materializeManagedMigrationState: mockMaterializeManagedMigrationState,
  packMigrationBundle: mockPackMigrationBundle,
  parseUploadedMigrationBuffer: mockParseUploadedMigrationBuffer,
  persistMigrationManifestForAgent: mockPersistMigrationManifestForAgent,
}));
jest.mock("../agentPayloads", () => ({
  createEmptyTemplatePayload: jest.fn(() => ({})),
  materializeTemplateWiring: mockMaterializeTemplateWiring,
  resolveContainerName: jest.fn(() => "container-name"),
  serializeAgent: jest.fn((row) => row),
}));
jest.mock("../kubernetesClusters", () => ({
  assertKubernetesExecutionTargetAvailable: mockAssertKubernetesExecutionTargetAvailable,
}));
jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: mockAssertRemoteHostAgentUse,
  assertRemoteHostExecutionTargetAvailable: mockAssertRemoteHostExecutionTargetAvailable,
  isRemoteDockerAgent: mockIsRemoteDockerAgent,
  toPublicRemoteHostAuthorizationError: mockToPublicRemoteHostAuthorizationError,
}));
jest.mock("../agentRuntimeFields", () => {
  const buildAgentRuntimeFields = (agent = {}) => {
    const deployTarget = agent.deploy_target || agent.backend_type || "docker";
    const sandboxProfile = agent.sandbox_profile || agent.sandbox_type || "standard";
    return {
      runtime_family: agent.runtime_family || "openclaw",
      backend_type: agent.backend_type || deployTarget,
      deploy_target: deployTarget,
      execution_target_id: agent.execution_target_id || deployTarget,
      sandbox_profile: sandboxProfile,
      sandbox_type: sandboxProfile,
    };
  };
  return {
    buildAgentRuntimeFields,
    resolveRequestedRuntimeFields: ({ request, fallback }) =>
      buildAgentRuntimeFields({ ...fallback, ...request }),
  };
});
jest.mock("../../agent-runtime/lib/backendCatalog", () => ({
  getRuntimeSelectionStatus: jest.fn(() => ({ enabled: true, configured: true })),
}));

const crypto = require("crypto");
const fs = require("fs/promises");
const tar = require("tar-stream");
const { promisify } = require("util");
const { gunzip } = require("zlib");

const backups = require("../backups");
const gunzipAsync = promisify(gunzip);

beforeEach(() => {
  mockPgClient.mockClear();
  mockProvisionLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockProvisionLockClient.query.mockReset().mockImplementation((sql, params) => {
    const text = String(sql);
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
    return mockDb.query(sql, params);
  });
  mockProvisionLockClient.end.mockReset().mockResolvedValue(undefined);
  mockAddDeploymentJob.mockReset().mockResolvedValue(undefined);
  mockCancelDeploymentJobsForAgent.mockReset().mockResolvedValue({ removed: 0, active: 0 });
  mockContainerManager.canDestroy
    .mockReset()
    .mockImplementation((agent) => Boolean(agent?.container_id || agent?.container_name));
  mockContainerManager.destroy.mockReset().mockResolvedValue(undefined);
  mockAssertKubernetesExecutionTargetAvailable.mockReset().mockResolvedValue(undefined);
  mockAssertRemoteHostAgentUse.mockReset().mockResolvedValue(undefined);
  mockAssertRemoteHostExecutionTargetAvailable.mockReset().mockResolvedValue(undefined);
  mockIsRemoteDockerAgent
    .mockReset()
    .mockImplementation((agent) =>
      [agent?.deploy_target, agent?.backend_type, agent?.execution_target_id].some((value) =>
        String(value || "").startsWith("remote"),
      ),
    );
  mockToPublicRemoteHostAuthorizationError.mockReset().mockImplementation((error) => error);
  mockBuildMigrationManifestFromAgent.mockReset();
  mockMaterializeManagedMigrationState.mockReset().mockResolvedValue(undefined);
  mockPersistMigrationManifestForAgent.mockReset().mockResolvedValue({ id: "restore-manifest-1" });
  mockPackMigrationBundle.mockReset();
  mockParseUploadedMigrationBuffer.mockReset();
  mockMaterializeTemplateWiring.mockReset().mockResolvedValue(undefined);
});

function encryptedBackupBuffer(plaintext = Buffer.from("backup archive")) {
  const key = Buffer.from(process.env.NORA_BACKUP_ENCRYPTION_KEY, "hex");
  const iv = Buffer.alloc(16, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(`NORA-BACKUP-ENC-v1\n${iv.toString("hex")}:${tag.toString("hex")}\n`),
    encrypted,
  ]);
}

async function readInstallationManifest(buffer) {
  const extract = tar.extract();
  const archive = await gunzipAsync(buffer);
  return new Promise((resolve, reject) => {
    let manifest = null;
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        if (header.name === "manifest.json") {
          manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
        next();
      });
      stream.resume();
    });
    extract.on("finish", () => resolve(manifest));
    extract.on("error", reject);
    extract.end(archive);
  });
}

function mockReadyRestore(targetOverrides = {}) {
  const backup = {
    id: "backup-1",
    kind: "agent",
    status: "ready",
    user_id: "owner-1",
    agent_id: "agent-1",
    storage_key: "agent/backup-1.tgz.enc",
    storage_backend: "local",
    storage_config: {},
    name: "Remote backup",
  };
  const target = {
    id: "agent-1",
    user_id: "owner-1",
    name: "my-agent",
    status: "stopped",
    runtime_family: "openclaw",
    backend_type: "remote-docker",
    deploy_target: "remote-docker",
    execution_target_id: "remote:shared-host",
    sandbox_profile: "standard",
    sandbox_type: "standard",
    container_id: "remote-container-id",
    container_name: "remote-container-name",
    host: "10.0.0.12",
    runtime_host: "10.0.0.12",
    runtime_port: 19090,
    gateway_host: "10.0.0.12",
    gateway_port: 18789,
    gateway_host_port: 19001,
    gateway_token: "encrypted-token",
    dashboard_port: 19044,
    image: "nora-openclaw-agent:test",
    vcpu: 2,
    ram_mb: 2048,
    disk_gb: 20,
    ...targetOverrides,
  };
  let currentAgent = target;

  const queryImplementation = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes("FROM backups")) return { rows: [backup] };
    if (text === "SELECT * FROM agents WHERE id = $1") return { rows: [currentAgent] };
    if (text.startsWith("DELETE FROM integrations")) return { rows: [] };
    if (text.startsWith("DELETE FROM channels")) return { rows: [] };
    if (
      text.includes("UPDATE agents") &&
      text.includes("SET status = $2") &&
      text.includes("container_id = NULL")
    ) {
      const status = params[1];
      const terminalAgent = {
        ...currentAgent,
        status,
        container_id: null,
        host: null,
        runtime_host: null,
        runtime_port: null,
        gateway_host: null,
        gateway_port: null,
        gateway_host_port: null,
        gateway_token: null,
        dashboard_port: null,
      };
      currentAgent = terminalAgent;
      return { rows: text.includes("RETURNING *") ? [terminalAgent] : [] };
    }
    if (text.includes("UPDATE deployments SET status = 'failed'")) return { rows: [] };
    if (text.includes("SET status = 'queued'") && text.includes("UPDATE agents")) {
      currentAgent = {
        ...currentAgent,
        status: "queued",
        container_id: null,
        host: null,
        runtime_host: null,
        runtime_port: null,
        gateway_host: null,
        gateway_port: null,
        gateway_host_port: null,
        gateway_token: null,
        dashboard_port: null,
        template_payload: JSON.parse(params[1]),
        container_name: params[2],
        image: params[3],
      };
      return { rows: [currentAgent] };
    }
    if (text.startsWith("INSERT INTO deployments")) return { rows: [] };
    if (text.includes("UPDATE backups")) return { rows: [] };
    throw new Error(`Unexpected restore SQL: ${text}`);
  };
  mockDb.query.mockImplementation(queryImplementation);

  mockParseUploadedMigrationBuffer.mockResolvedValue({
    runtimeFamily: "openclaw",
    templatePayload: { files: [], memoryFiles: [] },
    managed: { channels: [], integrations: [] },
    source: {
      backup: {
        agent: { image: target.image, vcpu: 2, ram_mb: 2048, disk_gb: 20 },
      },
    },
  });

  return {
    backup,
    target,
    queryImplementation,
    getCurrentAgent: () => currentAgent,
    setCurrentAgent: (agent) => {
      currentAgent = agent;
    },
  };
}

function restoreTerminalUpdateCalls() {
  return mockDb.query.mock.calls.filter(([sql]) => {
    const text = String(sql);
    return (
      text.includes("UPDATE agents") &&
      text.includes("SET status = $2") &&
      text.includes("container_id = NULL")
    );
  });
}

function expectClearedTerminalRuntimeUpdate(call) {
  const sql = String(call?.[0] || "");
  expect(sql).toContain("SET status = $2");
  for (const column of [
    "container_id",
    "host",
    "runtime_host",
    "runtime_port",
    "gateway_host",
    "gateway_port",
    "gateway_host_port",
    "gateway_token",
    "dashboard_port",
  ]) {
    expect(sql).toContain(`${column} = NULL`);
  }
  expect(call?.[1]).toEqual(["agent-1", "stopped"]);
}

describe("storageKeyForBackup", () => {
  it("accepts the allowlisted kinds", () => {
    expect(backups.storageKeyForBackup({ id: "abc", kind: "agent" })).toBe("agent/abc.tgz.enc");
    expect(backups.storageKeyForBackup({ id: "abc", kind: "installation" })).toBe(
      "installation/abc.tgz.enc",
    );
  });

  it("rejects unknown kinds (path-traversal hardening)", () => {
    const tests = ["../etc/passwd", "", null, undefined, "snapshot", "agent/../foo"];
    for (const kind of tests) {
      expect(() => backups.storageKeyForBackup({ id: "x", kind })).toThrow(/Invalid backup kind/);
    }
  });
});

describe("pruneExpiredBackups", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("only flips status to 'deleted' when storage delete succeeded", async () => {
    // Two rows: one whose storage delete will succeed, one that throws.
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "b1",
            kind: "agent",
            storage_key: "agent/b1.tgz.enc",
            storage_backend: "local",
            storage_config: {},
            expires_at: new Date(Date.now() - 1000).toISOString(),
            status: "ready",
          },
          {
            id: "b2",
            kind: "agent",
            storage_key: "agent/b2.tgz.enc",
            storage_backend: "local",
            storage_config: {},
            expires_at: new Date(Date.now() - 1000).toISOString(),
            status: "ready",
          },
        ],
      })
      // first deleteStorage succeeds (no DB call captured here, just fs.unlink).
      // Then UPDATE is issued for b1.
      .mockResolvedValueOnce({ rowCount: 1 });

    // Mock fs.unlink: succeed for b1, fail for b2.
    const realUnlink = fs.unlink;
    const unlinkSpy = jest.spyOn(fs, "unlink").mockImplementation((target) => {
      if (String(target).includes("b1")) return Promise.resolve();
      return Promise.reject(new Error("storage backend offline"));
    });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await backups.pruneExpiredBackups();
      expect(result).toEqual({ deleted: 1, scanned: 2 });

      // Only one UPDATE issued (for b1). b2 stays untouched on disk.
      const updateCalls = mockDb.query.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("UPDATE backups"),
      );
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0][1]).toEqual(["b1"]);

      // The b2 storage failure was logged, not swallowed silently.
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
      warnSpy.mockRestore();
      fs.unlink = realUnlink;
    }
  });
});

describe("installation backup Remote Docker revocation", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("omits the revoked agent and records the warning in the archive manifest", async () => {
    const remoteAgent = {
      id: "remote-agent",
      user_id: "former-grantee",
      name: "Revoked remote agent",
      runtime_family: "openclaw",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      sandbox_profile: "standard",
    };
    const localAgent = {
      id: "local-agent",
      user_id: "owner-1",
      name: "Local agent",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
    };
    const revoked = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteAgent, localAgent] });
    mockAssertRemoteHostAgentUse.mockImplementation(async (agent) => {
      if (agent.id === remoteAgent.id) throw revoked;
    });
    mockBuildMigrationManifestFromAgent.mockResolvedValue({
      runtimeFamily: "openclaw",
      source: {},
      warnings: [],
    });
    mockPackMigrationBundle.mockResolvedValue(Buffer.from("local-agent-archive"));

    const result = await backups.__test.buildInstallationBackupArchive(
      { id: "installation-backup-1" },
      { databaseDumpBuilder: jest.fn().mockResolvedValue(Buffer.from("database-dump")) },
    );

    expect(mockBuildMigrationManifestFromAgent).toHaveBeenCalledTimes(1);
    expect(mockBuildMigrationManifestFromAgent).toHaveBeenCalledWith(localAgent, {
      userId: localAgent.user_id,
      signal: undefined,
    });
    expect(result.summary).toEqual(
      expect.objectContaining({ agentCount: 2, agentBackupCount: 1, warningCount: 1 }),
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "agent_backup_remote_host_access_revoked",
        agentId: remoteAgent.id,
        message: expect.stringMatching(/revoked.*omitted/i),
      }),
    ]);

    const manifest = await readInstallationManifest(result.buffer);
    expect(manifest.agents).toEqual([expect.objectContaining({ agentId: localAgent.id })]);
    expect(manifest.warnings).toEqual(result.warnings);
  });

  it("aborts an in-flight Remote Docker capture when access is revoked", async () => {
    const remoteAgent = {
      id: "remote-agent",
      user_id: "workspace-editor",
      name: "Remote agent",
      runtime_family: "openclaw",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      sandbox_profile: "standard",
    };
    const revoked = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    let captureSignal = null;
    mockDb.query.mockResolvedValueOnce({ rows: [remoteAgent] });
    mockAssertRemoteHostAgentUse.mockResolvedValueOnce(undefined).mockRejectedValue(revoked);
    mockBuildMigrationManifestFromAgent.mockImplementation((_agent, options) => {
      captureSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    });

    const result = await backups.__test.buildInstallationBackupArchive(
      { id: "installation-backup-1" },
      {
        authorizationRecheckMs: 1,
        databaseDumpBuilder: jest.fn().mockResolvedValue(Buffer.from("database-dump")),
      },
    );

    expect(captureSignal).toBeTruthy();
    expect(captureSignal.aborted).toBe(true);
    expect(captureSignal.reason).toBe(revoked);
    expect(mockPackMigrationBundle).not.toHaveBeenCalled();
    expect(result.summary).toEqual(
      expect.objectContaining({ agentBackupCount: 0, warningCount: 1 }),
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "agent_backup_remote_host_access_revoked",
        agentId: remoteAgent.id,
      }),
    ]);
  });

  it("requires final Remote Docker authorization after the archive is packed", async () => {
    const remoteAgent = {
      id: "remote-agent",
      user_id: "workspace-editor",
      name: "Remote agent",
      runtime_family: "openclaw",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      sandbox_profile: "standard",
    };
    const revoked = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteAgent] });
    mockAssertRemoteHostAgentUse.mockResolvedValueOnce(undefined).mockRejectedValueOnce(revoked);
    mockBuildMigrationManifestFromAgent.mockResolvedValue({
      runtimeFamily: "openclaw",
      source: {},
      warnings: [],
    });
    mockPackMigrationBundle.mockResolvedValue(Buffer.from("remote-agent-archive"));

    const result = await backups.__test.buildInstallationBackupArchive(
      { id: "installation-backup-1" },
      {
        authorizationRecheckMs: 60000,
        databaseDumpBuilder: jest.fn().mockResolvedValue(Buffer.from("database-dump")),
      },
    );

    expect(mockPackMigrationBundle).toHaveBeenCalledTimes(1);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);
    expect(result.summary.agentBackupCount).toBe(0);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "agent_backup_remote_host_access_revoked" }),
    ]);
  });
});

describe("restoreBackupInPlace runtime transition", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("clears runtime identity immediately after destroy and compensates an enqueue failure", async () => {
    const { target } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    const queuedJobs = [];
    mockCancelDeploymentJobsForAgent.mockImplementation(async () => {
      const removed = queuedJobs.length;
      queuedJobs.length = 0;
      return { removed, active: 0 };
    });
    mockContainerManager.destroy.mockImplementation(async (agent) => {
      expect(agent).toEqual(target);
      expect(agent.container_id).toBe("remote-container-id");
      expect(
        mockDb.query.mock.calls.some(
          ([sql]) => String(sql).includes("UPDATE agents") && String(sql).includes("queued"),
        ),
      ).toBe(false);
    });
    mockAddDeploymentJob.mockImplementationOnce(async (job) => {
      // Model an ambiguous Redis failure: the write landed, then the client
      // rejected. Compensation must re-cancel this side effect.
      queuedJobs.push(job);
      throw new Error("redis unavailable");
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("redis unavailable");
    } finally {
      readSpy.mockRestore();
    }

    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(3);
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenNthCalledWith(1, target.id);
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenNthCalledWith(2, target.id);
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenNthCalledWith(3, target.id);
    expect(queuedJobs).toEqual([]);
    expect(mockContainerManager.destroy).toHaveBeenCalledWith(target);
    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    terminalCalls.forEach(expectClearedTerminalRuntimeUpdate);
    const firstTerminalCallIndex = mockDb.query.mock.calls.indexOf(terminalCalls[0]);
    const firstDeleteCallIndex = mockDb.query.mock.calls.findIndex(([sql]) =>
      String(sql).startsWith("DELETE FROM integrations"),
    );
    expect(mockContainerManager.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.query.mock.invocationCallOrder[firstTerminalCallIndex],
    );
    expect(firstTerminalCallIndex).toBeLessThan(firstDeleteCallIndex);
    expect(mockAssertRemoteHostExecutionTargetAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ execution_target_id: target.execution_target_id }),
      { ownerUserId: target.user_id },
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: target.id,
        userId: target.user_id,
        runtime_family: "openclaw",
        deploy_target: "remote-docker",
        execution_target_id: target.execution_target_id,
        sandbox_profile: "standard",
      }),
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status IN ('queued', 'deploying')",
      [target.id],
    );
    const restoreMetadataCalls = mockDb.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SET restore_metadata = $2"),
    );
    expect(restoreMetadataCalls).toHaveLength(2);
    expect(restoreMetadataCalls[1][1]).toEqual(["backup-1", null]);
  });

  it.each([
    ["agent status fencing", (sql) => sql.includes("SET status = $2")],
    [
      "deployment status fencing",
      (sql) => sql.includes("UPDATE deployments SET status = 'failed'"),
    ],
  ])("surfaces compensation failure when mandatory %s cannot persist", async (_phase, fails) => {
    mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockAddDeploymentJob.mockRejectedValueOnce(new Error("redis unavailable"));
    mockProvisionLockClient.query.mockImplementation((sql, params) => {
      const text = String(sql);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
      if (fails(text)) throw new Error("mandatory fence write failed");
      return mockDb.query(sql, params);
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toMatchObject({
        code: "RESTORE_COMPENSATION_FAILED",
        restoreError: expect.objectContaining({ message: "redis unavailable" }),
      });
    } finally {
      readSpy.mockRestore();
    }

    expect(mockProvisionLockClient.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [
      expect.any(String),
    ]);
  });

  it("fences an active ambiguous deployment and destroys the runtime it created", async () => {
    const { target, getCurrentAgent, setCurrentAgent } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockCancelDeploymentJobsForAgent
      .mockResolvedValueOnce({ removed: 0, active: 0 })
      .mockResolvedValueOnce({ removed: 0, active: 0 })
      .mockResolvedValueOnce({ removed: 0, active: 1 });
    mockAddDeploymentJob.mockImplementationOnce(async () => {
      setCurrentAgent({
        ...getCurrentAgent(),
        status: "running",
        container_id: "racing-runtime-id",
        host: "10.0.0.99",
        runtime_host: "10.0.0.99",
        runtime_port: 19099,
      });
      throw new Error("redis response lost after activation");
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("redis response lost after activation");
    } finally {
      readSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(mockProvisionLockClient.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock($1) AS locked",
      [expect.any(String)],
    );
    expect(mockProvisionLockClient.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [
      expect.any(String),
    ]);
    expect(mockProvisionLockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockProvisionLockClient.end).toHaveBeenCalledTimes(1);
    expect(mockContainerManager.destroy).toHaveBeenCalledTimes(2);
    expect(mockContainerManager.destroy).toHaveBeenNthCalledWith(1, target);
    expect(mockContainerManager.destroy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ container_id: "racing-runtime-id", status: "running" }),
    );
    expect(getCurrentAgent()).toEqual(
      expect.objectContaining({
        status: "stopped",
        container_id: null,
        runtime_host: null,
        runtime_port: null,
        dashboard_port: null,
      }),
    );
  });

  it("does not race cleanup when the provisioner lock cannot be acquired", async () => {
    const previousTimeout = process.env.AGENT_PROVISION_LOCK_TIMEOUT_MS;
    process.env.AGENT_PROVISION_LOCK_TIMEOUT_MS = "10";
    const { getCurrentAgent, setCurrentAgent } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockProvisionLockClient.query.mockResolvedValue({ rows: [{ locked: false }] });
    mockAddDeploymentJob.mockImplementationOnce(async () => {
      setCurrentAgent({
        ...getCurrentAgent(),
        status: "running",
        container_id: "racing-runtime-id",
        host: "10.0.0.99",
        runtime_host: "10.0.0.99",
        runtime_port: 19099,
      });
      throw new Error("redis response lost after activation");
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toMatchObject({ code: "AGENT_PROVISION_LOCK_TIMEOUT" });
    } finally {
      readSpy.mockRestore();
      if (previousTimeout == null) delete process.env.AGENT_PROVISION_LOCK_TIMEOUT_MS;
      else process.env.AGENT_PROVISION_LOCK_TIMEOUT_MS = previousTimeout;
    }

    expect(mockCancelDeploymentJobsForAgent).not.toHaveBeenCalled();
    expect(mockContainerManager.destroy).not.toHaveBeenCalled();
    expect(getCurrentAgent()).toEqual(
      expect.objectContaining({
        status: "stopped",
        container_id: "remote-container-id",
        runtime_host: "10.0.0.12",
      }),
    );
    expect(mockProvisionLockClient.query).not.toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      expect.anything(),
    );
    expect(mockProvisionLockClient.end).toHaveBeenCalledTimes(1);
  });

  it("keeps identity NULL and status stopped when managed-state deletion fails", async () => {
    const { queryImplementation } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockDb.query.mockImplementation(async (sql, params) => {
      if (String(sql).startsWith("DELETE FROM integrations")) {
        throw new Error("integration delete failed");
      }
      return queryImplementation(sql, params);
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("integration delete failed");
    } finally {
      readSpy.mockRestore();
    }

    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    terminalCalls.forEach(expectClearedTerminalRuntimeUpdate);
    expect(mockMaterializeManagedMigrationState).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status IN ('queued', 'deploying')",
      ["agent-1"],
    );
  });

  it("keeps identity NULL and status stopped when managed-state materialization fails", async () => {
    mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockMaterializeManagedMigrationState.mockRejectedValueOnce(new Error("materialization failed"));

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("materialization failed");
    } finally {
      readSpy.mockRestore();
    }

    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    terminalCalls.forEach(expectClearedTerminalRuntimeUpdate);
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("compensates back to NULL identity and stopped status when the queued agent update fails", async () => {
    const { queryImplementation } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockDb.query.mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (text.includes("UPDATE agents") && text.includes("SET status = 'queued'")) {
        throw new Error("agent update failed");
      }
      return queryImplementation(sql, params);
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("agent update failed");
    } finally {
      readSpy.mockRestore();
    }

    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    terminalCalls.forEach(expectClearedTerminalRuntimeUpdate);
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status IN ('queued', 'deploying')",
      ["agent-1"],
    );
  });

  it("compensates a restore-metadata update failure before enqueue", async () => {
    const { queryImplementation } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockDb.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes("SET restore_metadata = $2")) {
        throw new Error("restore metadata update failed");
      }
      return queryImplementation(sql, params);
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("restore metadata update failed");
    } finally {
      readSpy.mockRestore();
    }

    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    terminalCalls.forEach(expectClearedTerminalRuntimeUpdate);
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status IN ('queued', 'deploying')",
      ["agent-1"],
    );
  });

  it("retries terminal compensation when the immediate post-destroy agent update fails", async () => {
    const { queryImplementation } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    let failedImmediateUpdate = false;
    mockDb.query.mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (
        !failedImmediateUpdate &&
        text.includes("UPDATE agents") &&
        text.includes("SET status = $2") &&
        text.includes("RETURNING *")
      ) {
        failedImmediateUpdate = true;
        throw new Error("terminal agent update failed");
      }
      return queryImplementation(sql, params);
    });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toThrow("terminal agent update failed");
    } finally {
      readSpy.mockRestore();
    }

    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    terminalCalls.forEach(expectClearedTerminalRuntimeUpdate);
    expect(mockContainerManager.destroy).toHaveBeenCalledTimes(2);
    expect(mockMaterializeManagedMigrationState).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("cleans up with persisted identity when the Remote Docker grant is revoked after validation", async () => {
    const { target } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    let grantRevoked = false;
    mockAssertRemoteHostExecutionTargetAvailable.mockImplementation(
      async (_runtimeFields, options) => {
        expect(options).toEqual({ ownerUserId: target.user_id });
        grantRevoked = true;
      },
    );
    mockContainerManager.destroy.mockImplementation(async (agent) => {
      expect(grantRevoked).toBe(true);
      expect(agent).toEqual(
        expect.objectContaining({
          user_id: target.user_id,
          execution_target_id: target.execution_target_id,
          container_id: target.container_id,
        }),
      );
    });

    let restored;
    try {
      restored = await backups.restoreBackupInPlace({
        backupId: "backup-1",
        targetAgentId: "agent-1",
        confirmAgentName: "my-agent",
        actor: { id: "admin-1", role: "admin" },
      });
    } finally {
      readSpy.mockRestore();
    }

    expect(mockContainerManager.destroy).toHaveBeenCalledTimes(1);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({ userId: target.user_id }),
    );
    expect(mockAddDeploymentJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-1" }),
    );
    expect(restored).toEqual(
      expect.objectContaining({ id: target.id, status: "queued", container_id: null }),
    );
  });

  it("durably attaches Hermes workspace state before publishing the restore deployment", async () => {
    const { target } = mockReadyRestore({
      runtime_family: "hermes",
      image: "nousresearch/hermes-agent:test",
    });
    const hermesManifest = {
      name: "Hermes backup",
      runtimeFamily: "hermes",
      hermesSeed: {
        version: 1,
        files: [{ path: "memory/notes.md", contentBase64: "aGVsbG8=", mode: 0o600 }],
        modelConfig: { defaultModel: "kimi" },
        channels: [{ type: "telegram", config: { token: "secret" } }],
      },
      managed: {
        llmProviders: [],
        integrations: [],
        channels: [],
        agentSecretOverrides: [],
      },
      source: { backup: { agent: { image: target.image } } },
      warnings: [],
    };
    mockParseUploadedMigrationBuffer.mockResolvedValueOnce(hermesManifest);
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).resolves.toEqual(expect.objectContaining({ id: target.id, status: "queued" }));
    } finally {
      readSpy.mockRestore();
    }

    expect(mockPersistMigrationManifestForAgent).toHaveBeenCalledWith({
      userId: target.user_id,
      agentId: target.id,
      manifest: hermesManifest,
      sourceKind: "backup",
      sourceTransport: "managed-backup",
    });
    expect(mockPersistMigrationManifestForAgent.mock.invocationCallOrder[0]).toBeLessThan(
      mockAddDeploymentJob.mock.invocationCallOrder[0],
    );
    expect(mockMaterializeTemplateWiring).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob.mock.calls[0][0]).not.toHaveProperty("backup_restore_id");
    expect(mockProvisionLockClient.query.mock.invocationCallOrder[0]).toBeLessThan(
      mockContainerManager.destroy.mock.invocationCallOrder[0],
    );
    expect(mockAddDeploymentJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvisionLockClient.query.mock.invocationCallOrder.at(-1),
    );
  });

  it("fences a deployment that becomes active while restore state is materializing", async () => {
    const { getCurrentAgent } = mockReadyRestore();
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue(encryptedBackupBuffer());
    mockCancelDeploymentJobsForAgent
      .mockResolvedValueOnce({ removed: 0, active: 0 })
      .mockResolvedValueOnce({ removed: 0, active: 1 })
      .mockResolvedValue({ removed: 0, active: 1 });

    try {
      await expect(
        backups.restoreBackupInPlace({
          backupId: "backup-1",
          targetAgentId: "agent-1",
          confirmAgentName: "my-agent",
          actor: { id: "admin-1", role: "admin" },
        }),
      ).rejects.toMatchObject({ code: "RESTORE_DEPLOYMENT_RACE", statusCode: 409 });
    } finally {
      readSpy.mockRestore();
    }

    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(getCurrentAgent()).toEqual(
      expect.objectContaining({ status: "stopped", container_id: null, runtime_host: null }),
    );
    const terminalCalls = restoreTerminalUpdateCalls();
    expect(terminalCalls).toHaveLength(2);
    expect(mockDb.query.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockProvisionLockClient.query.mock.invocationCallOrder.at(-1),
    );
  });
});

describe("restoreBackupInPlace ownership defense-in-depth", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  function mockBackupAndAgent(backupUserId, agentUserId, agentName = "my-agent") {
    mockDb.query
      // loadBackup -> SELECT * FROM backups WHERE id = $1 ...
      .mockResolvedValueOnce({
        rows: [
          {
            id: "backup-1",
            kind: "agent",
            user_id: backupUserId,
            agent_id: "agent-1",
            storage_key: "agent/backup-1.tgz.enc",
            storage_backend: "local",
            storage_config: {},
          },
        ],
      })
      // SELECT * FROM agents WHERE id = $1
      .mockResolvedValueOnce({
        rows: [{ id: "agent-1", user_id: agentUserId, name: agentName }],
      });
  }

  it("rejects a non-admin actor who does not own the target agent", async () => {
    mockBackupAndAgent("owner-1", "owner-1");
    await expect(
      backups.restoreBackupInPlace({
        backupId: "backup-1",
        targetAgentId: "agent-1",
        confirmAgentName: "my-agent",
        actor: { id: "intruder", role: "user" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a non-admin owner whose backup belongs to a different user", async () => {
    mockBackupAndAgent("other-owner", "current-user");
    await expect(
      backups.restoreBackupInPlace({
        backupId: "backup-1",
        targetAgentId: "agent-1",
        confirmAgentName: "my-agent",
        actor: { id: "current-user", role: "user" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("admin actor passes the ownership gate even when the backup belongs to another user", async () => {
    // The admin owns nothing; the backup and target agent both belong to
    // tenant-a. The ownership check must let the admin through; we then
    // hit readBackupArchive's READY_STATUSES guard (status is undefined on
    // our mock row), which throws 409 — proving the gate was open.
    mockBackupAndAgent("tenant-a", "tenant-a");
    await expect(
      backups.restoreBackupInPlace({
        backupId: "backup-1",
        targetAgentId: "agent-1",
        confirmAgentName: "my-agent",
        actor: { id: "admin-1", role: "admin" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Backup is not ready" });
  });
});
