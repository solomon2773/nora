// @ts-nocheck
const express = require("express");
const request = require("supertest");

const mockRemoteHosts = {
  getRemoteHost: jest.fn(),
  resetRemoteHostHostKeyPin: jest.fn(),
};
const mockMonitoring = { logEvent: jest.fn() };

jest.mock("../remoteHosts", () => mockRemoteHosts);
jest.mock("../monitoring", () => mockMonitoring);
jest.mock("../middleware/ownership", () => ({ findWorkspaceMembership: jest.fn() }));

const router = require("../routes/remoteHosts");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: req.get("x-test-user") || "user-1", role: "user" };
    if (req.get("x-test-api-key")) req.apiKey = { id: "key-1" };
    next();
  });
  app.use("/remote-hosts", router);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMonitoring.logEvent.mockResolvedValue(undefined);
});

describe("POST /remote-hosts/:id/reset-host-key", () => {
  it("rejects API-key authentication because the route is session-only", async () => {
    const response = await request(buildApp())
      .post("/remote-hosts/build-host/reset-host-key")
      .set("x-test-api-key", "yes")
      .send({ confirmation: "Build Host" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("session_required");
    expect(mockRemoteHosts.getRemoteHost).not.toHaveBeenCalled();
  });

  it("returns 404 without resetting another owner's host", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({
      id: "build-host",
      label: "Build Host",
      ownerUserId: "user-2",
    });

    const response = await request(buildApp())
      .post("/remote-hosts/build-host/reset-host-key")
      .send({ confirmation: "Build Host" });

    expect(response.status).toBe(404);
    expect(mockRemoteHosts.resetRemoteHostHostKeyPin).not.toHaveBeenCalled();
    expect(mockMonitoring.logEvent).not.toHaveBeenCalled();
  });

  it("passes the explicit confirmation and records an owner-scoped audit event", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({
      id: "build-host",
      label: "Build Host",
      ownerUserId: "user-1",
      lastTestStatus: "failed",
    });
    mockRemoteHosts.resetRemoteHostHostKeyPin.mockResolvedValue({
      id: "build-host",
      label: "Build Host",
      ownerUserId: "user-1",
      connected: false,
      lastTestStatus: null,
    });

    const response = await request(buildApp())
      .post("/remote-hosts/build-host/reset-host-key")
      .send({ confirmation: "Build Host" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ connected: false, lastTestStatus: null });
    expect(mockRemoteHosts.resetRemoteHostHostKeyPin).toHaveBeenCalledWith(
      "build-host",
      "Build Host",
      { expectedOwnerUserId: "user-1" },
    );
    expect(mockMonitoring.logEvent).toHaveBeenCalledWith(
      "remote_host_ssh_pin_reset",
      'Reset the pinned SSH host key for remote host "Build Host"',
      {
        userId: "user-1",
        remoteHost: { id: "build-host", label: "Build Host" },
        previousTestStatus: "failed",
      },
    );
  });
});
