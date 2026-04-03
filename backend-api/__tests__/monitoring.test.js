jest.mock("../db", () => ({
  query: jest.fn(),
}));

jest.mock("../redisQueue", () => ({
  deployQueue: {
    getJobCounts: jest.fn(),
  },
}));

const db = require("../db");
const { deployQueue } = require("../redisQueue");
const monitoring = require("../monitoring");

describe("monitoring metrics", () => {
  beforeEach(() => {
    db.query.mockReset();
    deployQueue.getJobCounts.mockReset();
  });

  it("surfaces warning and error agent counts alongside queue metrics", async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          { status: "running", count: 3 },
          { status: "warning", count: 2 },
          { status: "error", count: 1 },
          { status: "queued", count: 4 },
          { status: "stopped", count: 5 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 9 }] })
      .mockResolvedValueOnce({ rows: [{ total: 6 }] });

    deployQueue.getJobCounts.mockResolvedValue({
      waiting: 7,
      active: 1,
      completed: 11,
      failed: 2,
    });

    const metrics = await monitoring.getMetrics();

    expect(metrics).toEqual({
      activeAgents: 3,
      warningAgents: 2,
      errorAgents: 1,
      totalAgents: 15,
      queuedAgents: 4,
      stoppedAgents: 5,
      totalDeployments: 9,
      totalUsers: 6,
      queue: {
        waiting: 7,
        active: 1,
        completed: 11,
        failed: 2,
      },
    });

    expect(deployQueue.getJobCounts).toHaveBeenCalledWith(
      "waiting",
      "active",
      "completed",
      "failed"
    );
  });
});
