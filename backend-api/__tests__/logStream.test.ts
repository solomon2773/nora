// @ts-nocheck
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const jwt = require("jsonwebtoken");

const mockDb = { query: jest.fn() };
const mockContainerManager = {
  status: jest.fn(),
  logs: jest.fn(),
};
const mockAssertRemoteHostAgentUse = jest.fn();
const wsConnections = [];

jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
  isRemoteDockerAgent: (agent = {}) => {
    const target = String(agent.deploy_target ?? agent.deployTarget ?? agent.backend_type ?? "");
    return target === "remote-docker" || target === "remote" || target.startsWith("remote:");
  },
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
jest.mock("../containerManager", () => mockContainerManager);
jest.mock("ws", () => ({
  WebSocketServer: mockFakeWebSocketServer,
}));

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

const originalRemoteHostAuthRecheckMs = process.env.REMOTE_HOST_AUTH_RECHECK_MS;

describe("log stream websocket auth", () => {
  let attachLogStream;
  let server;

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "secret";
    process.env.REMOTE_HOST_AUTH_RECHECK_MS = "250";
    mockDb.query.mockReset();
    mockContainerManager.status.mockReset();
    mockContainerManager.logs.mockReset();
    mockAssertRemoteHostAgentUse.mockReset();
    mockAssertRemoteHostAgentUse.mockResolvedValue(null);
    wsConnections.length = 0;

    ({ attachLogStream } = require("../logStream"));
    server = new EventEmitter();
    attachLogStream(server);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (originalRemoteHostAuthRecheckMs === undefined) {
      delete process.env.REMOTE_HOST_AUTH_RECHECK_MS;
    } else {
      process.env.REMOTE_HOST_AUTH_RECHECK_MS = originalRemoteHostAuthRecheckMs;
    }
  });

  function openLogStream(agentId, userPayload) {
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
        url: `/ws/logs/${agentId}?token=${encodeURIComponent(token)}`,
        headers: { host: "nora.test" },
      },
      socket,
      Buffer.alloc(0),
    );

    return wsConnections[0];
  }

  it("rejects users without direct ownership or workspace access", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            name: "Other Agent",
            status: "running",
            container_id: null,
            backend_type: "docker",
            user_id: "owner-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const ws = openLogStream("agent-1", { id: "user-2", role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Agent not found",
    });
    expect(ws.closed).toBe(true);
  });

  it("allows workspace viewers to inspect shared agent log streams", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            name: "Shared Agent",
            status: "running",
            container_id: null,
            backend_type: "docker",
            user_id: "owner-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "viewer" }] });

    const ws = openLogStream("agent-1", { id: "viewer-1", role: "user" });
    await flushAsyncWork();

    expect(ws.sent[0]).toEqual(
      expect.objectContaining({
        type: "system",
        message: "Connected to log stream for Shared Agent",
      }),
    );
    expect(ws.closed).toBe(false);
    ws.close();
  });

  it("allows admins to inspect any agent log stream", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          name: "Fleet Agent",
          status: "running",
          container_id: null,
          backend_type: "docker",
          user_id: "owner-1",
        },
      ],
    });

    const ws = openLogStream("agent-1", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    expect(ws.sent[0]).toEqual(
      expect.objectContaining({
        type: "system",
        message: "Connected to log stream for Fleet Agent",
      }),
    );
    expect(ws.sent[1]).toEqual(
      expect.objectContaining({
        type: "system",
        message: "No container assigned — agent may still be provisioning",
      }),
    );
    expect(ws.closed).toBe(false);
    ws.close();
  });

  it("surfaces backend log stream errors to the websocket client", async () => {
    const logStream = new PassThrough();
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-k8s",
          name: "K8s Agent",
          status: "running",
          container_id: "oclaw-agent-k8s",
          backend_type: "k8s",
          deploy_target: "k8s",
          user_id: "owner-1",
        },
      ],
    });
    mockContainerManager.status.mockResolvedValueOnce({ running: true });
    mockContainerManager.logs.mockResolvedValueOnce(logStream);

    const ws = openLogStream("agent-k8s", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    logStream.emit("error", new Error("pod log stream closed"));
    await flushAsyncWork();

    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "Log stream error: pod log stream closed",
      }),
    );
    expect(ws.closed).toBe(true);
  });

  it("closes when attaching the backend log stream fails", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-k8s",
          name: "K8s Agent",
          status: "running",
          container_id: "oclaw-agent-k8s",
          backend_type: "k8s",
          deploy_target: "k8s",
          user_id: "owner-1",
        },
      ],
    });
    mockContainerManager.status.mockResolvedValueOnce({ running: true });
    mockContainerManager.logs.mockRejectedValueOnce(new Error("attach unavailable"));

    const ws = openLogStream("agent-k8s", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "Failed to attach to container: attach unavailable",
      }),
    );
    expect(ws.closed).toBe(true);
  });

  it("fails closed without overlapping slow remote host authorization checks", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const logStream = new PassThrough();
    const agent = {
      id: "agent-remote",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    let rejectRecheck;
    const slowRecheck = new Promise((_resolve, reject) => {
      rejectRecheck = reject;
    });

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.logs.mockResolvedValue(logStream);
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockReturnValue(slowRecheck);

    const ws = openLogStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    await jest.advanceTimersByTimeAsync(250);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(750);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    rejectRecheck(new Error("authorization database unavailable"));
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    expect(ws.closed).toBe(true);
    expect(logStream.destroyed).toBe(true);
  });

  it("closes an active log stream when workspace access is removed", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const logStream = new PassThrough();
    const agent = {
      id: "agent-viewer-removed",
      name: "Shared Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "owner-1",
    };

    mockDb.query
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [{ role: "viewer" }] })
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.logs.mockResolvedValue(logStream);
    mockAssertRemoteHostAgentUse.mockResolvedValue({ id: "shared-host" });

    const ws = openLogStream(agent.id, { id: "viewer-1", role: "user" });
    await flushAsyncWork();
    expect(ws.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(250);

    expect(ws.sent).toContainEqual({ type: "error", message: "Agent not found" });
    expect(ws.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);
    expect(logStream.destroyed).toBe(true);
  });

  it("fails closed when current actor access cannot be revalidated", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const logStream = new PassThrough();
    const agent = {
      id: "agent-access-check-failure",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "owner-1",
    };

    mockDb.query
      .mockResolvedValueOnce({ rows: [agent] })
      .mockRejectedValueOnce(new Error("membership database unavailable"));
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.logs.mockResolvedValue(logStream);
    mockAssertRemoteHostAgentUse.mockResolvedValue({ id: "shared-host" });

    const ws = openLogStream(agent.id, { id: "owner-1", role: "user" });
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(250);

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unable to verify agent access",
      code: "AGENT_ACCESS_CHECK_FAILED",
    });
    expect(ws.closed).toBe(true);
    expect(logStream.destroyed).toBe(true);
  });

  it("sanitizes an initial Remote Docker authorization-store failure", async () => {
    const agent = {
      id: "agent-remote-auth-store",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "owner-1",
    };
    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockAssertRemoteHostAgentUse.mockRejectedValueOnce(
      Object.assign(new Error("password authentication failed for database"), { code: "28P01" }),
    );

    const ws = openLogStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    expect(ws.closed).toBe(true);
    expect(mockContainerManager.logs).not.toHaveBeenCalled();
  });

  it("closes a remote log socket when access is revoked during an unresolved status check", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote-hung-status",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    const revokedError = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockContainerManager.status.mockReturnValue(new Promise(() => {}));
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const ws = openLogStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();
    expect(mockContainerManager.status).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);

    expect(ws.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(ws.closed).toBe(true);
    expect(mockContainerManager.logs).not.toHaveBeenCalled();
  });

  it("destroys a late remote log stream after access is revoked during attachment", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const logStream = new PassThrough();
    const agent = {
      id: "agent-remote-revoked-attach",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    const revokedError = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    let resolveLogs;

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.logs.mockReturnValue(
      new Promise((resolve) => {
        resolveLogs = resolve;
      }),
    );
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const ws = openLogStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();
    expect(mockContainerManager.logs).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);
    expect(ws.closed).toBe(true);

    resolveLogs(logStream);
    await flushAsyncWork();

    expect(logStream.destroyed).toBe(true);
    expect(ws.sent).not.toContainEqual(
      expect.objectContaining({
        type: "system",
        message: expect.stringMatching(/^Streaming logs from/),
      }),
    );
  });

  it("destroys a remote log stream that attaches after the client disconnects", async () => {
    const logStream = new PassThrough();
    const agent = {
      id: "agent-remote-late-log",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "owner-1",
    };
    let resolveLogs;
    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.logs.mockReturnValue(
      new Promise((resolve) => {
        resolveLogs = resolve;
      }),
    );
    mockAssertRemoteHostAgentUse.mockResolvedValue({ id: "shared-host" });

    const ws = openLogStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();
    expect(mockContainerManager.logs).toHaveBeenCalledTimes(1);

    ws.close();
    resolveLogs(logStream);
    await flushAsyncWork();

    expect(logStream.destroyed).toBe(true);
  });

  it("closes active and rejects new remote log sessions after the workspace host grant is revoked", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const logStream = new PassThrough();
    const agent = {
      id: "agent-remote",
      name: "Remote Agent",
      status: "running",
      container_id: "remote-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      user_id: "workspace-editor-1",
    };
    const revokedError = Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.logs.mockResolvedValue(logStream);
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const activeWs = openLogStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    expect(activeWs.closed).toBe(false);
    expect(mockContainerManager.logs).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);

    expect(activeWs.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(activeWs.closed).toBe(true);
    expect(logStream.destroyed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(500);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    openLogStream(agent.id, { id: agent.user_id, role: "user" });
    const deniedWs = wsConnections.at(-1);
    await flushAsyncWork();

    expect(deniedWs.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(deniedWs.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(3);
    expect(mockContainerManager.logs).toHaveBeenCalledTimes(1);
  });
});
