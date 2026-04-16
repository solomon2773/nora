const mockRunContainerCommand = jest.fn();

jest.mock("../authSync", () => ({
  runContainerCommand: mockRunContainerCommand,
}));

jest.mock("../containerManager", () => ({
  restart: jest.fn(),
}));

jest.mock("../healthChecks", () => ({
  waitForAgentReadiness: jest.fn(),
}));

const { readHermesRuntimeSnapshot } = require("../hermesUi");

describe("Hermes helper execution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
