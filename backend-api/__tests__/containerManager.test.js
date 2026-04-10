const mockStart = jest.fn();
const mockStop = jest.fn();
const mockRestart = jest.fn();
const mockDestroy = jest.fn();
const mockStatus = jest.fn();
const mockStats = jest.fn();
const mockLogs = jest.fn();
const mockExec = jest.fn();

jest.mock("../../workers/provisioner/backends/nemoclaw", () => {
  return jest.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    restart: mockRestart,
    destroy: mockDestroy,
    status: mockStatus,
    stats: mockStats,
    logs: mockLogs,
    exec: mockExec,
  }));
});

describe("containerManager NemoClaw routing", () => {
  beforeEach(() => {
    jest.resetModules();
    mockStart.mockReset().mockResolvedValue(undefined);
    mockStop.mockReset().mockResolvedValue(undefined);
    mockRestart.mockReset().mockResolvedValue(undefined);
    mockDestroy.mockReset().mockResolvedValue(undefined);
    mockStatus.mockReset().mockResolvedValue({ running: true });
    mockStats.mockReset().mockResolvedValue({
      backend_type: "nemoclaw",
      capabilities: { cpu: true, memory: true, network: true, disk: true, pids: true },
      current: { recorded_at: "2026-04-08T00:00:00.000Z", running: true, uptime_seconds: 5 },
    });
    mockLogs.mockReset().mockResolvedValue("log-stream");
    mockExec.mockReset().mockResolvedValue({ exec: "exec-instance", stream: "stream-instance" });
  });

  it("routes lifecycle, telemetry, logs, and exec calls to the NemoClaw backend", async () => {
    const containerManager = require("../containerManager");
    const agent = { backend_type: "nemoclaw", container_id: "nemo-123" };

    await containerManager.start(agent);
    await containerManager.stop(agent);
    await containerManager.restart(agent);
    await containerManager.destroy(agent);
    await containerManager.status(agent);
    const telemetry = await containerManager.stats(agent);
    const logs = await containerManager.logs(agent, { tail: 50 });
    const exec = await containerManager.exec(agent, { tty: true });

    expect(mockStart).toHaveBeenCalledWith("nemo-123");
    expect(mockStop).toHaveBeenCalledWith("nemo-123");
    expect(mockRestart).toHaveBeenCalledWith("nemo-123");
    expect(mockDestroy).toHaveBeenCalledWith("nemo-123");
    expect(mockStatus).toHaveBeenCalledWith("nemo-123");
    expect(mockStats).toHaveBeenCalledWith("nemo-123", agent);
    expect(mockLogs).toHaveBeenCalledWith("nemo-123", { tail: 50 });
    expect(mockExec).toHaveBeenCalledWith("nemo-123", { tty: true });
    expect(telemetry).toEqual(expect.objectContaining({ backend_type: "nemoclaw" }));
    expect(logs).toBe("log-stream");
    expect(exec).toEqual({ exec: "exec-instance", stream: "stream-instance" });
  });
});
