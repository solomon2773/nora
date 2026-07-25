// @ts-nocheck
process.env.ENCRYPTION_KEY = "1".repeat(64);

const { PassThrough } = require("stream");

const mockBackendFor = jest.fn();
const mockContainerManagerStop = jest.fn();
const mockIsIgnorableStopError = jest.fn();
const mockLocalDockerGetContainer = jest.fn();
const mockDb = { query: jest.fn() };

jest.mock("../db", () => mockDb);
jest.mock("../containerManager", () => ({
  backendFor: (...args) => mockBackendFor(...args),
  stop: (...args) => mockContainerManagerStop(...args),
  isIgnorableStopError: (...args) => mockIsIgnorableStopError(...args),
}));
jest.mock("dockerode", () =>
  jest.fn().mockImplementation(() => ({
    getContainer: (...args) => mockLocalDockerGetContainer(...args),
  })),
);

const {
  __test,
  buildHermesSeedArchive,
  buildLiveMigrationManifest,
  buildMigrationManifestFromAgent,
  getMigrationManifestForAgent,
  normalizeMigrationManifest,
  persistMigrationManifestForAgent,
  resolveHermesDockerContainer,
} = require("../agentMigrations");

beforeEach(() => {
  mockBackendFor.mockReset();
  mockContainerManagerStop.mockReset().mockResolvedValue(undefined);
  mockIsIgnorableStopError.mockReset().mockReturnValue(false);
  mockLocalDockerGetContainer.mockReset();
  mockDb.query.mockReset().mockResolvedValue({ rows: [] });
});

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

it("persists a Hermes backup manifest as the durable provisioner handoff", async () => {
  const manifest = {
    name: "Hermes backup",
    runtimeFamily: "hermes",
    hermesSeed: {
      version: 1,
      files: [{ path: "notes.md", contentBase64: "aGVsbG8=", mode: 0o600 }],
      modelConfig: { defaultModel: "kimi" },
      channels: [],
    },
    managed: { llmProviders: [], integrations: [], channels: [], agentSecretOverrides: [] },
    warnings: [],
  };
  mockDb.query.mockResolvedValueOnce({
    rows: [
      {
        id: "migration-restore-1",
        user_id: "owner-1",
        deployed_agent_id: "agent-1",
        runtime_family: "hermes",
      },
    ],
  });

  await expect(
    persistMigrationManifestForAgent({
      userId: "owner-1",
      agentId: "agent-1",
      manifest,
      sourceKind: "backup",
      sourceTransport: "managed-backup",
    }),
  ).resolves.toEqual(
    expect.objectContaining({
      id: "migration-restore-1",
      deployed_agent_id: "agent-1",
      manifest: expect.objectContaining({
        runtimeFamily: "hermes",
        hermesSeed: expect.objectContaining({ files: manifest.hermesSeed.files }),
      }),
    }),
  );

  expect(mockDb.query).toHaveBeenCalledWith(
    expect.stringMatching(/INSERT INTO agent_migrations[\s\S]*deployed_agent_id[\s\S]*expires_at/),
    expect.arrayContaining(["owner-1", "agent-1", "backup", "managed-backup"]),
  );
});

it("loads the newest attached manifest deterministically for provisioning", async () => {
  mockDb.query.mockResolvedValueOnce({ rows: [] });

  await expect(getMigrationManifestForAgent("agent-1")).resolves.toBeNull();
  expect(mockDb.query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY created_at DESC, id DESC"),
    ["agent-1"],
  );
});

it.each([
  "../escape.txt",
  "nested/../../escape.txt",
  "/etc/passwd",
  "C:\\Windows\\system.ini",
  "nested/..\\escape.txt",
  "nul\0byte.txt",
])("rejects an unsafe Hermes seed path: %s", (unsafePath) => {
  try {
    normalizeMigrationManifest({
      name: "Unsafe Hermes import",
      runtimeFamily: "hermes",
      hermesSeed: {
        files: [{ path: unsafePath, contentBase64: "eA==", mode: 0o644 }],
      },
    });
    throw new Error("Expected unsafe Hermes seed path to be rejected");
  } catch (error) {
    expect(error).toMatchObject({ code: "UNSAFE_HERMES_SEED_PATH" });
  }
});

it("normalizes Hermes seed paths and strips special mode bits", () => {
  const normalized = normalizeMigrationManifest({
    name: "Safe Hermes import",
    runtimeFamily: "hermes",
    hermesSeed: {
      files: [{ path: "./nested\\notes.txt", contentBase64: "eA==", mode: 0o107755 }],
    },
  });

  expect(normalized.hermesSeed.files).toEqual([
    { path: "nested/notes.txt", contentBase64: "eA==", mode: 0o755 },
  ]);
});

it("strips control-plane-only activation metadata from portable OpenClaw manifests", () => {
  const normalized = normalizeMigrationManifest({
    name: "Copied demo",
    runtimeFamily: "openclaw",
    templatePayload: {
      metadata: {
        source: "demo-activation",
        activation: "local-docker-demo-v1",
      },
      files: [],
    },
  });

  expect(normalized.templatePayload.metadata).toEqual({ source: "demo-activation" });
});

it("defensively rejects traversal when building a Hermes seed archive", async () => {
  await expect(
    buildHermesSeedArchive({
      hermesSeed: {
        files: [{ path: "skills/../../root.txt", contentBase64: "eA==", mode: 0o644 }],
      },
    }),
  ).rejects.toMatchObject({ code: "UNSAFE_HERMES_SEED_PATH" });
});

it("uses the selected backend Docker client for Remote Docker Hermes capture", async () => {
  const container = { id: "remote-hermes-1" };
  const getContainer = jest.fn().mockReturnValue(container);
  mockBackendFor.mockResolvedValue({ docker: { getContainer } });
  const agent = {
    container_id: "remote-hermes-1",
    runtime_family: "hermes",
    deploy_target: "remote-docker",
    execution_target_id: "remote:build-host",
  };

  await expect(resolveHermesDockerContainer(agent)).resolves.toBe(container);
  expect(mockBackendFor).toHaveBeenCalledWith(agent);
  expect(getContainer).toHaveBeenCalledWith("remote-hermes-1");
});

it("fails explicitly when the selected backend cannot provide a Docker archive", async () => {
  mockBackendFor.mockResolvedValue({});

  await expect(
    resolveHermesDockerContainer({
      container_id: "hermes-k8s-1",
      runtime_family: "hermes",
      deploy_target: "k8s",
    }),
  ).rejects.toMatchObject({ code: "MIGRATION_CAPTURE_UNSUPPORTED", statusCode: 409 });
});

it("aborts an in-flight Hermes archive stream with the authorization error", async () => {
  const stream = new PassThrough();
  const destroySpy = jest.spyOn(stream, "destroy");
  const container = { getArchive: jest.fn().mockResolvedValue(stream) };
  const controller = new AbortController();
  const revoked = Object.assign(new Error("Remote Docker access revoked"), {
    code: "REMOTE_HOST_ACCESS_REVOKED",
  });

  const capture = __test.getDockerArchiveFiles(container, "/opt/data/workspace", {
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(revoked);

  await expect(capture).rejects.toBe(revoked);
  expect(destroySpy).toHaveBeenCalled();
});

it("aborts an in-flight Hermes snapshot exec with the authorization error", async () => {
  const stream = new PassThrough();
  const destroySpy = jest.spyOn(stream, "destroy");
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const inspect = jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 });
  const start = jest.fn().mockResolvedValue(stream);
  const container = {
    exec: jest.fn().mockResolvedValue({ start, inspect }),
  };
  const controller = new AbortController();
  const authCheckFailed = Object.assign(new Error("Unable to verify Remote Docker access"), {
    code: "REMOTE_HOST_AUTH_CHECK_FAILED",
  });

  const capture = __test.execDockerText(container, "echo snapshot", {
    signal: controller.signal,
    onUnconfirmedTermination: cleanup,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(authCheckFailed);

  await expect(capture).rejects.toBe(authCheckFailed);
  expect(destroySpy).toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(inspect).not.toHaveBeenCalled();
});

it("rejects a Docker archive stream that closes before end", async () => {
  const stream = new PassThrough();
  const container = { getArchive: jest.fn().mockResolvedValue(stream) };

  const capture = __test.getDockerArchiveFiles(container, "/opt/data/workspace");
  await nextTurn();
  stream.destroy();

  await expect(capture).rejects.toMatchObject({ code: "DOCKER_ARCHIVE_STREAM_TRUNCATED" });
});

it("propagates Docker archive transport failures", async () => {
  const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const container = { getArchive: jest.fn().mockRejectedValue(transportError) };

  await expect(__test.getDockerArchiveFiles(container, "/opt/data/workspace")).rejects.toBe(
    transportError,
  );
});

it("treats an explicit missing-path Docker 404 as an empty archive", async () => {
  const missingPath = Object.assign(
    new Error("Could not find the file /opt/data/workspace in container hermes-1"),
    { statusCode: 404 },
  );
  const container = { getArchive: jest.fn().mockRejectedValue(missingPath) };

  await expect(__test.getDockerArchiveFiles(container, "/opt/data/workspace")).resolves.toEqual([]);
});

it("runs fail-safe cleanup when a Docker exec stream closes before end", async () => {
  const stream = new PassThrough();
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const inspect = jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 });
  const container = {
    exec: jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(stream),
      inspect,
    }),
  };

  const capture = __test.execDockerText(container, "echo snapshot", {
    onUnconfirmedTermination: cleanup,
  });
  await nextTurn();
  stream.destroy();

  await expect(capture).rejects.toMatchObject({ code: "DOCKER_EXEC_COMPLETION_UNCONFIRMED" });
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(inspect).not.toHaveBeenCalled();
});

it.each([
  ["still running", { Running: true, ExitCode: 0 }],
  ["null exit code", { Running: false, ExitCode: null }],
  ["noninteger exit code", { Running: false, ExitCode: 0.5 }],
])("runs fail-safe cleanup when Docker exec completion is %s", async (_label, inspectResult) => {
  const stream = new PassThrough();
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const container = {
    exec: jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(stream),
      inspect: jest.fn().mockResolvedValue(inspectResult),
    }),
  };

  const capture = __test.execDockerText(container, "echo snapshot", {
    onUnconfirmedTermination: cleanup,
  });
  await nextTurn();
  stream.end("snapshot");

  await expect(capture).rejects.toMatchObject({ code: "DOCKER_EXEC_COMPLETION_UNCONFIRMED" });
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("accepts a Docker exec only after a confirmed zero exit", async () => {
  const stream = new PassThrough();
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const inspect = jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 });
  const container = {
    exec: jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(stream),
      inspect,
    }),
  };

  const capture = __test.execDockerText(container, "echo snapshot", {
    onUnconfirmedTermination: cleanup,
  });
  await nextTurn();
  stream.end("snapshot");

  await expect(capture).resolves.toBe("snapshot");
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled();
});

it("rejects empty Hermes snapshot output after a confirmed exec", async () => {
  const stream = new PassThrough();
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const container = {
    exec: jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(stream),
      inspect: jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 }),
    }),
  };

  const capture = __test.readHermesSnapshotFromDocker(container, {
    onUnconfirmedTermination: cleanup,
  });
  await nextTurn();
  stream.end("  \n");

  await expect(capture).rejects.toMatchObject({ code: "HERMES_SNAPSHOT_EMPTY" });
  expect(cleanup).not.toHaveBeenCalled();
});

it.each(["", "  \n"])("rejects empty Hermes snapshot text through the shared parser", (output) => {
  expect(() => __test.parseHermesSnapshotOutput(output)).toThrow(
    expect.objectContaining({ code: "HERMES_SNAPSHOT_EMPTY" }),
  );
});

it.each(["ssh", "remote-docker", ""])(
  "rejects unsupported live migration transport %j at the service boundary",
  async (transport) => {
    await expect(
      buildLiveMigrationManifest({
        runtime_family: "openclaw",
        transport,
        container_id: "source-agent",
      }),
    ).rejects.toMatchObject({
      code: "LIVE_MIGRATION_DOCKER_ONLY",
      statusCode: 400,
      message: "Live migration inspection requires the local Docker transport",
    });
    expect(mockLocalDockerGetContainer).not.toHaveBeenCalled();
  },
);

it.each(["{", "[]", "null", '{"profiles":"invalid"}'])(
  "rejects malformed non-empty auth-profiles.json: %s",
  (content) => {
    expect(() => __test.llmProvidersFromAuthProfiles(content)).toThrow(
      expect.objectContaining({ code: "MIGRATION_AUTH_PROFILES_INVALID", statusCode: 400 }),
    );
  },
);

it("parses the current OpenClaw auth profile store without dropping providers", () => {
  expect(
    __test.llmProvidersFromAuthProfiles(
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-live",
            endpoint: "https://api.example.test/v1",
            api_version: "2026-07-01",
          },
        },
      }),
    ),
  ).toEqual([
    {
      provider: "openai",
      apiKey: "sk-live",
      config: {
        endpoint: "https://api.example.test/v1",
        api_version: "2026-07-01",
      },
    },
  ]);
});

it("treats a missing auth-profiles.json file as no imported providers", () => {
  expect(__test.llmProvidersFromAuthProfiles("")).toEqual([]);
});

it("stops a managed Hermes agent and records stopped state when exec termination is unconfirmed", async () => {
  const archiveStream = new PassThrough();
  const execStream = new PassThrough();
  const container = {
    getArchive: jest.fn().mockResolvedValue(archiveStream),
    exec: jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(execStream),
      inspect: jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 }),
    }),
  };
  const getContainer = jest.fn().mockReturnValue(container);
  mockBackendFor.mockResolvedValue({ docker: { getContainer } });
  const agent = {
    id: "agent-hermes-1",
    user_id: "owner-1",
    name: "Managed Hermes",
    runtime_family: "hermes",
    deploy_target: "remote-docker",
    container_id: "remote-hermes-1",
  };

  const capture = buildMigrationManifestFromAgent(agent, { userId: agent.user_id });
  await nextTurn();
  archiveStream.end();
  execStream.destroy();

  await expect(capture).rejects.toMatchObject({ code: "DOCKER_EXEC_COMPLETION_UNCONFIRMED" });
  expect(mockContainerManagerStop).toHaveBeenCalledWith(agent);
  expect(mockDb.query).toHaveBeenCalledWith("UPDATE agents SET status = 'stopped' WHERE id = $1", [
    agent.id,
  ]);
  expect(agent.status).toBe("stopped");
});

it("safely stops a direct Docker Hermes source when exec termination is unconfirmed", async () => {
  const archiveStream = new PassThrough();
  const execStream = new PassThrough();
  const stop = jest.fn().mockRejectedValue(
    Object.assign(new Error("No such container: external-hermes-1"), {
      statusCode: 404,
    }),
  );
  const container = {
    getArchive: jest.fn().mockResolvedValue(archiveStream),
    exec: jest.fn().mockResolvedValue({
      start: jest.fn().mockResolvedValue(execStream),
      inspect: jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 }),
    }),
    stop,
  };
  mockLocalDockerGetContainer.mockReturnValue(container);

  const capture = buildLiveMigrationManifest({
    runtime_family: "hermes",
    transport: "docker",
    container_id: "external-hermes-1",
  });
  await nextTurn();
  archiveStream.end();
  execStream.destroy();

  let captureError;
  try {
    await capture;
  } catch (error) {
    captureError = error;
  }
  expect(captureError).toMatchObject({ code: "DOCKER_EXEC_COMPLETION_UNCONFIRMED" });
  expect(captureError).not.toHaveProperty("cleanupError");
  expect(stop).toHaveBeenCalledWith({ t: 10 });
});
