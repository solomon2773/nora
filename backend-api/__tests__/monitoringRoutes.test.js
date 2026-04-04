const express = require("express");
const request = require("supertest");

const mockDb = { query: jest.fn() };
const mockMonitoring = {
  getMetrics: jest.fn(),
  getRecentEvents: jest.fn(),
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

  beforeEach(() => {
    mockDb.query.mockReset();
    mockMonitoring.getMetrics.mockReset();
    mockMonitoring.getRecentEvents.mockReset();
    mockOwnership.findOwnedAgent.mockReset();

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: "user-1", role: "user" };
      next();
    });
    app.use(router);
  });

  it("scopes generic monitoring events to the current user's agents", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "evt-1",
          type: "deployment",
          message: "Deployed agent-1",
          metadata: { agentId: "agent-1" },
        },
      ],
    });

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
    expect(mockMonitoring.getRecentEvents).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id::text FROM agents WHERE user_id = $1"),
      ["user-1", 10]
    );
  });
});
