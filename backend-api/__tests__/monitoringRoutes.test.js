const express = require("express");
const request = require("supertest");

const mockDb = { query: jest.fn() };
const mockMonitoring = {
  getMetrics: jest.fn(),
  getRecentEvents: jest.fn(),
  getUserRecentEvents: jest.fn(),
  getUserEventsPage: jest.fn(),
};
const mockMetrics = {
  getAgentMetrics: jest.fn(),
  getAgentSummary: jest.fn(),
  getAgentCost: jest.fn(),
};
const mockOwnership = {
  findOwnedAgent: jest.fn(),
  requireOwnedAgent: jest.fn(() => (req, res, next) => next()),
};

jest.mock("../db", () => mockDb);
jest.mock("../monitoring", () => mockMonitoring);
jest.mock("../metrics", () => mockMetrics);
jest.mock("../middleware/ownership", () => mockOwnership);

const router = require("../routes/monitoring");

describe("monitoring route ownership", () => {
  let app;
  let currentUser;

  beforeEach(() => {
    mockDb.query.mockReset();
    mockMonitoring.getMetrics.mockReset();
    mockMonitoring.getRecentEvents.mockReset();
    mockMonitoring.getUserRecentEvents.mockReset();
    mockMonitoring.getUserEventsPage.mockReset();
    mockOwnership.findOwnedAgent.mockReset();
    currentUser = { id: "user-1", role: "user" };

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = currentUser;
      next();
    });
    app.use(router);
  });

  it("returns the current user's recent events", async () => {
    mockMonitoring.getUserRecentEvents.mockResolvedValueOnce([
      {
        id: "evt-1",
        type: "deployment",
        message: "Deployed agent-1",
        metadata: { agentId: "agent-1" },
      },
    ]);

    const res = await request(app).get("/monitoring/events?limit=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "evt-1",
        type: "deployment",
        message: "Deployed agent-1",
        metadata: { agentId: "agent-1" },
      },
    ]);
    expect(mockMonitoring.getUserRecentEvents).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ limit: 10 })
    );
  });

  it("returns paginated filtered events for the current user", async () => {
    mockMonitoring.getUserEventsPage.mockResolvedValueOnce({
      events: [
        {
          id: "evt-2",
          type: "agent_started",
          message: "Agent started",
          metadata: {
            agent: { id: "agent-1", ownerUserId: "user-1" },
          },
          created_at: "2026-04-08T12:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 30,
      totalPages: 1,
      availableTypes: ["agent_started"],
    });

    const res = await request(app).get(
      "/monitoring/events?page=1&limit=30&type=agent_started&from=2026-04-01&to=2026-04-08"
    );

    expect(res.status).toBe(200);
    expect(mockMonitoring.getUserEventsPage).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        page: 1,
        limit: 30,
        type: "agent_started",
        from: expect.any(Date),
        to: expect.any(Date),
      })
    );
    expect(res.body.events).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it("blocks non-admin users from platform-wide performance metrics", async () => {
    const res = await request(app).get("/monitoring/performance");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin access required/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("returns platform-wide performance metrics for admins", async () => {
    currentUser = { id: "admin-1", role: "admin" };
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          value: 25,
          metadata: { avgLatencyMs: 120 },
          recorded_at: "2026-04-10T12:00:00.000Z",
        },
      ],
    });

    const res = await request(app).get("/monitoring/performance?since=2026-04-09T00:00:00.000Z");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT value, metadata, recorded_at FROM usage_metrics WHERE metric_type = 'api_performance' AND recorded_at >= $1 ORDER BY recorded_at",
      ["2026-04-09T00:00:00.000Z"]
    );
  });
});
