// @ts-nocheck
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockDb = { query: jest.fn() };
const mockRunContainerCommand = jest.fn();

jest.mock("../db", () => mockDb);

jest.mock("../authSync", () => ({
  runContainerCommand: mockRunContainerCommand,
}));

jest.mock("../containerManager", () => ({
  restart: jest.fn(),
}));

jest.mock("../healthChecks", () => ({
  waitForAgentReadiness: jest.fn(),
}));

const {
  getPersistedHermesState,
  readHermesRuntimeSnapshot,
  replacePersistedHermesState,
  snapshotToPersistedHermesState,
} = require("../hermesUi");

describe("Hermes helper execution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockReset();
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
      })
    );
    expect(options).toEqual({ timeout: 30000 });
    expect(command).toContain('HERMES_ROOT="/opt/hermes"');
    expect(command).toContain('HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python"');
    expect(command).toContain('if [ -d "$HERMES_ROOT" ]; then cd "$HERMES_ROOT"; fi');
    expect(command).toContain(
      'PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}" exec "$HERMES_PYTHON" - <<\'PY\''
    );
    expect(command).not.toContain("python3 - <<'PY'");
  });
});

describe("Hermes persisted runtime state", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("stores sensitive channel config encrypted and reads it back decrypted", async () => {
    await replacePersistedHermesState("agent-hermes-1", {
      modelConfig: {
        defaultModel: "gpt-5.4",
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

    expect(parsedStoredChannels.telegram.TELEGRAM_BOT_TOKEN).not.toBe(
      "telegram-secret"
    );
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
        defaultModel: "gpt-5.4",
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
        defaultModel: "gpt-5.4",
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
        defaultModel: "gpt-5.4",
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
