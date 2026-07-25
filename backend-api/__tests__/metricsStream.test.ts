// @ts-nocheck
const { EventEmitter } = require("events");
const jwt = require("jsonwebtoken");

const mockDb = { query: jest.fn() };
const mockBuildAgentStatsResponse = jest.fn().mockResolvedValue({
  status: "running",
  runtime: { health: "ok" },
});
const mockAssertRemoteHostAgentUse = jest.fn();
const wsConnections = [];

jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
  isRemoteHostAccessRevokedError: (error) => error?.code === "REMOTE_HOST_ACCESS_REVOKED",
}));

class mockFakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = mockFakeWebSocket.OPEN;
    this.sent = [];
    this.closed = false;
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
    this.readyState = mockFakeWebSocket.CLOSED;
    this.emit("close");
  }
}

mockFakeWebSocket.OPEN = 1;
mockFakeWebSocket.CLOSED = 3;

class mockFakeWebSocketServer extends EventEmitter {
  handleUpgrade(_request, _socket, _head, callback) {
    const ws = new mockFakeWebSocket();
    wsConnections.push(ws);
    callback(ws);
  }
}

jest.mock("../db", () => mockDb);
jest.mock("../agentTelemetry", () => ({
  buildAgentStatsResponse: mockBuildAgentStatsResponse,
}));
jest.mock("ws", () => ({
  WebSocketServer: mockFakeWebSocketServer,
}));

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("metrics stream websocket auth", () => {
  let attachMetricsStream;
  let server;

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "secret";
    mockDb.query.mockReset();
    mockBuildAgentStatsResponse.mockClear();
    mockBuildAgentStatsResponse.mockResolvedValue({
      status: "running",
      runtime: { health: "ok" },
    });
    mockAssertRemoteHostAgentUse.mockReset();
    mockAssertRemoteHostAgentUse.mockResolvedValue(null);
    wsConnections.length = 0;

    ({ attachMetricsStream } = require("../metricsStream"));
    server = new EventEmitter();
    attachMetricsStream(server);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function openMetricsStream(agentId, userPayload) {
    const token = jwt.sign(userPayload, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    const socket = {
      write: jest.fn(),
      destroy: jest.fn(),
    };

    server.emit(
      "upgrade",
      {
        url: `/ws/metrics/${agentId}?token=${encodeURIComponent(token)}`,
        headers: { host: "nora.test" },
      },
      socket,
      Buffer.alloc(0),
    );

    return wsConnections[0];
  }

  it("allows workspace viewers to stream shared agent metrics", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            name: "Shared Agent",
            status: "running",
            user_id: "owner-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "viewer" }] });

    const ws = openMetricsStream("agent-1", { id: "viewer-1", role: "user" });
    await flushAsyncWork();

    expect(mockBuildAgentStatsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", effective_role: "viewer" }),
    );
    expect(ws.sent).toContainEqual({
      type: "snapshot",
      payload: { status: "running", runtime: { health: "ok" } },
    });
    ws.close();
  });

  it("rejects users without access to the agent", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            name: "Shared Agent",
            status: "running",
            user_id: "owner-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const ws = openMetricsStream("agent-1", { id: "user-2", role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Agent not found",
    });
    expect(ws.closed).toBe(true);
  });

  it("allows admins to stream metrics for any agent", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          name: "Fleet Agent",
          status: "running",
          user_id: "owner-1",
        },
      ],
    });

    const ws = openMetricsStream("agent-1", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    expect(mockBuildAgentStatsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", effective_role: "admin" }),
    );
    expect(ws.sent[0]).toEqual(
      expect.objectContaining({
        type: "snapshot",
      }),
    );
    ws.close();
  });

  it("fails closed without overlapping slow remote host authorization checks", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote",
      name: "Remote Agent",
      status: "running",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    let rejectRecheck;
    const slowRecheck = new Promise((_resolve, reject) => {
      rejectRecheck = reject;
    });

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockReturnValue(slowRecheck);

    const ws = openMetricsStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    jest.advanceTimersByTime(5000);
    await flushAsyncWork();
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(15000);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    rejectRecheck(new Error("authorization database unavailable"));
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    expect(ws.closed).toBe(true);
    expect(mockBuildAgentStatsResponse).toHaveBeenCalledTimes(1);
  });

  it("closes a remote metrics socket when access is revoked during the initial stats snapshot", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote-hung-stats",
      name: "Remote Agent",
      status: "running",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    const revokedError = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    let resolveStats;

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockBuildAgentStatsResponse.mockReturnValue(
      new Promise((resolve) => {
        resolveStats = resolve;
      }),
    );
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const ws = openMetricsStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();
    expect(mockBuildAgentStatsResponse).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5000);

    expect(ws.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(ws.closed).toBe(true);

    resolveStats({ status: "running", runtime: { health: "ok" } });
    await flushAsyncWork();
    expect(ws.sent).not.toContainEqual(expect.objectContaining({ type: "snapshot" }));
  });

  it("closes active and rejects new remote metrics sessions after the workspace host grant is revoked", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote",
      name: "Remote Agent",
      status: "running",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    const revokedError = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const activeWs = openMetricsStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    expect(activeWs.sent).toContainEqual({
      type: "snapshot",
      payload: { status: "running", runtime: { health: "ok" } },
    });
    expect(activeWs.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(5000);

    expect(activeWs.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(activeWs.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5000);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    openMetricsStream(agent.id, { id: agent.user_id, role: "user" });
    const deniedWs = wsConnections.at(-1);
    await flushAsyncWork();

    expect(deniedWs.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(deniedWs.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(3);
    expect(mockBuildAgentStatsResponse).toHaveBeenCalledTimes(1);
  });
});
