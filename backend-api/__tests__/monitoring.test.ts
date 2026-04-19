// @ts-nocheck
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
          { status: "deploying", count: 2 },
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
      deployingAgents: 2,
      warningAgents: 2,
      errorAgents: 1,
      totalAgents: 17,
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

  it("scopes regular-user metrics to that user's agents only", async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          { status: "running", count: 2 },
          { status: "deploying", count: 1 },
          { status: "warning", count: 1 },
          { status: "queued", count: 3 },
          { status: "stopped", count: 4 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 7 }] });

    const metrics = await monitoring.getMetrics({ userId: "user-1" });

    expect(metrics).toEqual({
      activeAgents: 2,
      deployingAgents: 1,
      warningAgents: 1,
      errorAgents: 0,
      totalAgents: 11,
      queuedAgents: 3,
      stoppedAgents: 4,
      totalDeployments: 7,
      queue: {
        waiting: 3,
        active: 1,
        completed: 0,
        failed: 0,
      },
    });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      "SELECT status, count(*)::int FROM agents WHERE user_id = $1 GROUP BY status",
      ["user-1"]
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM deployments d"),
      ["user-1"]
    );
    expect(deployQueue.getJobCounts).not.toHaveBeenCalled();
  });

  it("returns paged audit events with search filters and available types", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 14 }] })
      .mockResolvedValueOnce({
        rows: [{ type: "admin_action_failed" }, { type: "agent_started" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "event-1",
            type: "admin_action_failed",
            message: "Invalid role",
            metadata: { error: { message: "Invalid role" } },
            created_at: "2026-04-08T12:00:00.000Z",
          },
        ],
      });

    const result = await monitoring.getAuditEventsPage({
      search: "invalid",
      type: "admin_action_failed",
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-09T23:59:59.999Z"),
      page: 2,
      limit: 10,
    });

    expect(result).toEqual({
      events: [
        expect.objectContaining({
          id: "event-1",
          type: "admin_action_failed",
        }),
      ],
      total: 14,
      page: 2,
      limit: 10,
      totalPages: 2,
      availableTypes: ["admin_action_failed", "agent_started"],
    });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT count(*)::int AS total FROM events"),
      expect.arrayContaining([
        "%invalid%",
        "admin_action_failed",
        expect.any(Date),
        expect.any(Date),
      ])
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("ORDER BY created_at DESC LIMIT"),
      expect.arrayContaining([
        "%invalid%",
        "admin_action_failed",
        expect.any(Date),
        expect.any(Date),
        10,
        10,
      ])
    );
  });

  it("returns recent user events scoped to owned and account-related activity", async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "event-user-1",
          type: "agent_started",
          message: "Agent started",
          metadata: {
            source: {
              kind: "account",
              account: { userId: "user-1" },
            },
            agent: { id: "agent-1", ownerUserId: "user-1" },
          },
        },
      ],
    });

    const result = await monitoring.getUserRecentEvents("user-1", {
      limit: 25,
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: "event-user-1",
        type: "agent_started",
      }),
    ]);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT e.* FROM events e"),
      ["user-1", "user-1", 25]
    );
    expect(db.query.mock.calls[0][0]).toContain(
      "metadata #>> '{source,account,userId}' = $1"
    );
    expect(db.query.mock.calls[0][0]).toContain(
      "metadata #>> '{agent,ownerUserId}' = $1"
    );
    expect(db.query.mock.calls[0][0]).toContain(
      "scoped_agents.user_id = $2::uuid"
    );
  });

  it("returns paged user events with available types", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 12 }] })
      .mockResolvedValueOnce({
        rows: [{ type: "agent_started" }, { type: "marketplace_install" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "event-user-page-1",
            type: "marketplace_install",
            message: "Installed listing",
            metadata: {
              listing: { ownerUserId: "user-1" },
            },
            created_at: "2026-04-08T12:00:00.000Z",
          },
        ],
      });

    const result = await monitoring.getUserEventsPage("user-1", {
      page: 2,
      limit: 10,
      search: "installed",
      type: "marketplace_install",
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-09T23:59:59.999Z"),
    });

    expect(result).toEqual({
      events: [
        expect.objectContaining({
          id: "event-user-page-1",
          type: "marketplace_install",
        }),
      ],
      total: 12,
      page: 2,
      limit: 10,
      totalPages: 2,
      availableTypes: ["agent_started", "marketplace_install"],
    });
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SELECT count(*)::int AS total FROM events e"),
      expect.arrayContaining([
        "user-1",
        "user-1",
        "%installed%",
        "marketplace_install",
        expect.any(Date),
        expect.any(Date),
      ])
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT DISTINCT e.type"),
      ["user-1", "user-1"]
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("ORDER BY e.created_at DESC LIMIT"),
      expect.arrayContaining([
        "user-1",
        "user-1",
        "%installed%",
        "marketplace_install",
        expect.any(Date),
        expect.any(Date),
        10,
        10,
      ])
    );
    expect(db.query.mock.calls[0][0]).toContain("scoped_agents.user_id = $2::uuid");
    expect(db.query.mock.calls[2][0]).toContain("scoped_agents.user_id = $2::uuid");
  });

  it("adds a system source when logging events without an explicit origin", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await monitoring.logEvent("maintenance_completed", "Maintenance completed", {
      result: { status: "ok" },
    });

    expect(db.query).toHaveBeenCalledWith(
      "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
      [
        "maintenance_completed",
        "Maintenance completed",
        expect.any(String),
      ]
    );

    const serializedMetadata = db.query.mock.calls[0][1][2];
    const metadata = JSON.parse(serializedMetadata);
    expect(metadata).toEqual(
      expect.objectContaining({
        result: { status: "ok" },
        source: expect.objectContaining({
          kind: "system",
          service: "backend-api",
          label: "System · backend-api",
        }),
      })
    );
  });
});
