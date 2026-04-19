// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockContainerManager = { status: jest.fn() };
const mockCollectTelemetry = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../containerManager", () => mockContainerManager);
jest.mock("../agentTelemetry", () => ({
  collectAgentTelemetrySample: mockCollectTelemetry,
}));

const {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
} = require("../backgroundTasks");

describe("background tasks", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockContainerManager.status.mockReset();
    mockCollectTelemetry.mockReset();
  });

  it("reconciles supported non-docker backends through containerManager status", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-k8s-1",
          container_id: "oclaw-agent-123",
          backend_type: "k8s",
          status: "running",
        },
      ],
    });
    mockContainerManager.status.mockResolvedValueOnce({ running: true });

    await reconcileBackgroundAgentStatuses();

    expect(mockContainerManager.status).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-1",
        backend_type: "k8s",
        container_id: "oclaw-agent-123",
      })
    );
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("marks unreachable warning agents as stopped", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-err-1",
          container_id: "runtime-1",
          backend_type: "k8s",
          status: "warning",
        },
      ],
    });
    mockContainerManager.status.mockRejectedValueOnce(new Error("unreachable"));
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    await reconcileBackgroundAgentStatuses();

    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "UPDATE agents SET status = $1 WHERE id = $2",
      ["stopped", "agent-err-1"]
    );
  });

  it("collects telemetry for running agents and prunes old samples", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-run-1",
            container_id: "ctr-1",
            backend_type: "docker",
            status: "running",
            host: "10.0.0.10",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockCollectTelemetry.mockResolvedValueOnce(undefined);

    await collectBackgroundTelemetry();

    expect(mockCollectTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-run-1",
        backend_type: "docker",
      })
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM container_stats WHERE recorded_at < NOW() - INTERVAL '7 days'"
    );
  });
});
