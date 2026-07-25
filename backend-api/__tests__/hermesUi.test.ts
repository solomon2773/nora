// @ts-nocheck
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockDb = { query: jest.fn() };
const mockRunContainerCommand = jest.fn();
const mockBuildHermesManagedEnvForAgent = jest.fn();
const mockWriteHermesEnvToContainer = jest.fn();
const mockIsKubernetesAgent = jest.fn();
const mockUpdateEnv = jest.fn();
const mockRestart = jest.fn();
const mockWaitForAgentReadiness = jest.fn();
const mockPersistLifecycleRuntimeAddress = jest.fn();
const mockAssertRemoteHostAgentUse = jest.fn();

jest.mock("../db", () => mockDb);

jest.mock("../authSync", () => ({
  runContainerCommand: mockRunContainerCommand,
  buildHermesManagedEnvForAgent: mockBuildHermesManagedEnvForAgent,
  writeHermesEnvToContainer: mockWriteHermesEnvToContainer,
}));

jest.mock("../containerManager", () => ({
  restart: mockRestart,
  isKubernetesAgent: mockIsKubernetesAgent,
  updateEnv: mockUpdateEnv,
  persistLifecycleRuntimeAddress: mockPersistLifecycleRuntimeAddress,
}));

jest.mock("../healthChecks", () => ({
  waitForAgentReadiness: mockWaitForAgentReadiness,
}));

jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
}));

const {
  getPersistedHermesState,
  persistHermesModelConfig,
  readHermesRuntimeSnapshot,
  repairHermesAgentConfig,
  replacePersistedHermesState,
  saveHermesChannel,
  snapshotToPersistedHermesState,
} = require("../hermesUi");

function decodeHermesHelperScript(command) {
  const match = String(command || "").match(/base64\.b64decode\("([^"]+)"\)\.decode\('utf-8'\)/);
  if (!match) return "";
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("Hermes helper execution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockReset().mockResolvedValue({ rows: [] });
    mockIsKubernetesAgent.mockReset().mockReturnValue(false);
    mockUpdateEnv.mockReset().mockResolvedValue(undefined);
    mockRestart.mockReset().mockResolvedValue(undefined);
    mockPersistLifecycleRuntimeAddress
      .mockReset()
      .mockImplementation(async (_db, agent, result) => {
        const host = typeof result?.host === "string" ? result.host.trim() : "";
        const runtimeHost =
          typeof result?.runtimeHost === "string" ? result.runtimeHost.trim() : host;
        if (host) agent.host = host;
        if (runtimeHost) agent.runtime_host = runtimeHost;
        return agent;
      });
    mockWaitForAgentReadiness.mockReset().mockResolvedValue({
      ok: true,
      runtime: { ok: true },
      gateway: { ok: true },
    });
    mockAssertRemoteHostAgentUse.mockReset().mockResolvedValue(null);
    mockBuildHermesManagedEnvForAgent.mockReset().mockResolvedValue({});
    mockWriteHermesEnvToContainer.mockReset().mockResolvedValue(undefined);
    mockRunContainerCommand.mockReset().mockResolvedValue({
      output: JSON.stringify({
        runtimeStatus: {},
        directory: { updated_at: null, platforms: {} },
        platformDetails: {},
        envValues: {},
        jobsCount: 0,
        modelConfig: {},
      }),
    });
  });

  it("projects Hermes channel env onto the Deployment env for kubernetes agents", async () => {
    mockIsKubernetesAgent.mockReturnValue(true);
    mockBuildHermesManagedEnvForAgent.mockResolvedValue({
      TELEGRAM_BOT_TOKEN: "tok-123",
      OPENAI_API_KEY: "sk-test",
    });

    const agent = {
      id: "agent-hermes-k8s",
      user_id: "user-1",
      container_id: "nora-hermes-qa-1",
      backend_type: "k8s",
      host: "runtime.internal",
      runtime_host: "runtime.internal",
      runtime_port: 8642,
    };

    await saveHermesChannel(agent, "telegram", { TELEGRAM_BOT_TOKEN: "tok-123" });

    // k8s: the exec-written /opt/data/.env would be wiped by the rollout the
    // save triggers, so the full managed env must go through the Deployment.
    expect(mockBuildHermesManagedEnvForAgent).toHaveBeenCalledWith("user-1", "agent-hermes-k8s");
    expect(mockWriteHermesEnvToContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-hermes-k8s" }),
      { TELEGRAM_BOT_TOKEN: "tok-123", OPENAI_API_KEY: "sk-test" },
    );
    const execCommands = mockRunContainerCommand.mock.calls.map((call) => String(call[1] || ""));
    expect(execCommands.some((command) => command.includes("save_env_value"))).toBe(false);
    expect(mockRestart).toHaveBeenCalled();
  });

  it("uses a refreshed Proxmox address for readiness after a Hermes restart", async () => {
    mockRestart.mockResolvedValueOnce({
      host: "10.100.110.71",
      runtimeHost: "10.100.110.71",
    });
    const agent = {
      id: "agent-hermes-proxmox",
      user_id: "user-1",
      container_id: "601",
      backend_type: "proxmox",
      runtime_family: "hermes",
      host: "10.100.110.10",
      runtime_host: "10.100.110.10",
      runtime_port: 8642,
    };

    await saveHermesChannel(agent, "telegram", { TELEGRAM_BOT_TOKEN: "tok-proxmox" });

    expect(mockPersistLifecycleRuntimeAddress).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ id: "agent-hermes-proxmox" }),
      { host: "10.100.110.71", runtimeHost: "10.100.110.71" },
    );
    expect(mockWaitForAgentReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "10.100.110.71",
        runtimeHost: "10.100.110.71",
      }),
      expect.any(Object),
    );
  });

  it("rechecks a Remote Docker host grant before every Hermes readiness attempt", async () => {
    const agent = {
      id: "agent-hermes-remote",
      user_id: "user-1",
      container_id: "remote-hermes-1",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      runtime_family: "hermes",
      host: "203.0.113.10",
      runtime_host: "203.0.113.10",
      runtime_port: 8642,
    };

    await saveHermesChannel(agent, "telegram", { TELEGRAM_BOT_TOKEN: "tok-remote" });

    const readinessOptions = mockWaitForAgentReadiness.mock.calls[0][1];
    await readinessOptions.beforeAttempt();
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledWith(agent, {
      includeProfile: false,
    });
  });

  it("runs helper scripts from /opt/hermes inside the Hermes virtualenv", async () => {
    await readHermesRuntimeSnapshot({
      id: "agent-hermes-1",
      container_id: "hermes-container-1",
    });

    expect(mockRunContainerCommand).toHaveBeenCalledTimes(1);

    const [agent, command, options] = mockRunContainerCommand.mock.calls[0];
    expect(agent).toEqual(
      expect.objectContaining({
        id: "agent-hermes-1",
        container_id: "hermes-container-1",
      }),
    );
    expect(options).toEqual({ timeout: 30000 });
    expect(command).toContain('HERMES_ROOT="/opt/hermes"');
    expect(command).toContain('HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python"');
    expect(command).toContain('if [ -d "$HERMES_ROOT" ]; then cd "$HERMES_ROOT"; fi');
    expect(command).toContain(
      'PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}" exec "$HERMES_PYTHON" - <<\'PY\'',
    );
    expect(command).not.toContain("python3 - <<'PY'");
  });

  it("runs the surrogate repair script and reports whether the file was mutated", async () => {
    mockRunContainerCommand.mockResolvedValueOnce({
      output: JSON.stringify({
        ok: true,
        mutated: true,
        configPath: "/opt/hermes/config.json",
      }),
    });

    const result = await repairHermesAgentConfig({
      id: "agent-hermes-1",
      container_id: "hermes-container-1",
    });

    expect(result).toEqual({
      ok: true,
      mutated: true,
      configPath: "/opt/hermes/config.json",
    });

    const [, command] = mockRunContainerCommand.mock.calls[0];
    const script = decodeHermesHelperScript(command);
    expect(script).toContain("def repair_surrogates(value):");
    expect(script).toContain("repaired = repair_surrogates(original)");
    expect(script).toContain("save_config(repaired)");
  });

  it("persists model config through Hermes save_config and repairs surrogate pairs", async () => {
    mockRunContainerCommand.mockResolvedValueOnce({
      output: JSON.stringify({ ok: true }),
    });

    await persistHermesModelConfig(
      {
        id: "agent-hermes-1",
        container_id: "hermes-container-1",
      },
      {
        defaultModel: "gpt-5.5",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    );

    const [, command] = mockRunContainerCommand.mock.calls[0];
    const script = decodeHermesHelperScript(command);
    expect(script).toContain("repair_surrogates(load_config() or {})");
    expect(script).toContain('decode("utf-16", "replace")');
    expect(script).toContain("save_config(config)");
    expect(script).not.toContain("json.dumps(config, indent=2)");
  });
});

describe("Hermes persisted runtime state", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("stores sensitive channel config encrypted and reads it back decrypted", async () => {
    await replacePersistedHermesState("agent-hermes-1", {
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
      channels: [
        {
          type: "telegram",
          config: {
            TELEGRAM_BOT_TOKEN: "telegram-secret",
            TELEGRAM_HOME_CHANNEL: "12345",
          },
        },
      ],
    });

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const replaceParams = mockDb.query.mock.calls[0][1];
    const storedModelConfig = replaceParams[1];
    const storedChannelConfigs = replaceParams[2];
    const parsedStoredChannels = JSON.parse(storedChannelConfigs);

    expect(parsedStoredChannels.telegram.TELEGRAM_BOT_TOKEN).not.toBe("telegram-secret");
    expect(parsedStoredChannels.telegram.TELEGRAM_HOME_CHANNEL).toBe("12345");

    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          model_config: storedModelConfig,
          channel_configs: storedChannelConfigs,
        },
      ],
    });

    const state = await getPersistedHermesState("agent-hermes-1");

    expect(state).toEqual({
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
      channels: [
        {
          type: "telegram",
          config: {
            TELEGRAM_BOT_TOKEN: "telegram-secret",
            TELEGRAM_ALLOWED_USERS: "",
            TELEGRAM_HOME_CHANNEL: "12345",
            TELEGRAM_HOME_CHANNEL_NAME: "",
          },
        },
      ],
    });
  });

  it("derives persisted state from a live snapshot and skips empty channel payloads", () => {
    const state = snapshotToPersistedHermesState({
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
      envValues: {
        telegram: {
          TELEGRAM_BOT_TOKEN: "telegram-secret",
          TELEGRAM_HOME_CHANNEL: "12345",
        },
        slack: {
          SLACK_BOT_TOKEN: "",
          SLACK_APP_TOKEN: "",
        },
      },
    });

    expect(state).toEqual({
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
      channels: [
        {
          type: "telegram",
          config: {
            TELEGRAM_BOT_TOKEN: "telegram-secret",
            TELEGRAM_HOME_CHANNEL: "12345",
          },
        },
      ],
    });
  });
});
