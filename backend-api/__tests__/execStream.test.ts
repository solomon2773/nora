// @ts-nocheck
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const jwt = require("jsonwebtoken");

const mockDb = { query: jest.fn() };
const mockContainerManager = {
  status: jest.fn(),
  exec: jest.fn(),
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
jest.mock("dockerode", () => jest.fn());
jest.mock("ws", () => ({
  WebSocketServer: mockFakeWebSocketServer,
}));

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

const originalRemoteHostAuthRecheckMs = process.env.REMOTE_HOST_AUTH_RECHECK_MS;

describe("exec stream websocket auth", () => {
  let attachExecStream;
  let server;

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "secret";
    process.env.REMOTE_HOST_AUTH_RECHECK_MS = "250";
    mockDb.query.mockReset();
    mockContainerManager.status.mockReset();
    mockContainerManager.exec.mockReset();
    mockAssertRemoteHostAgentUse.mockReset();
    mockAssertRemoteHostAgentUse.mockResolvedValue(null);
    wsConnections.length = 0;

    ({ attachExecStream } = require("../execStream"));
    server = new EventEmitter();
    attachExecStream(server);
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

  function openExecStream(agentId, userPayload) {
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
        url: `/ws/exec/${agentId}?token=${encodeURIComponent(token)}`,
        headers: { host: "nora.test" },
      },
      socket,
      Buffer.alloc(0),
    );

    return wsConnections[0];
  }

  it("allows workspace editors to open terminal sessions for shared agents", async () => {
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
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] });

    const ws = openExecStream("agent-1", { id: "editor-1", role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "No container ID — agent may still be provisioning",
    });
    expect(ws.closed).toBe(true);
  });

  it("rejects workspace viewers from terminal sessions", async () => {
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

    const ws = openExecStream("agent-1", { id: "viewer-1", role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Agent not found",
    });
    expect(ws.closed).toBe(true);
  });

  it("allows admins to open terminal sessions for any agent", async () => {
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

    const ws = openExecStream("agent-1", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "No container ID — agent may still be provisioning",
    });
    expect(ws.closed).toBe(true);
  });

  it("forwards non-docker backend exec output and input over the websocket", async () => {
    const backendStream = new PassThrough();
    const backendStdin = new PassThrough();
    const resize = jest.fn().mockResolvedValue(undefined);
    const stdinChunks = [];
    backendStdin.on("data", (chunk) => stdinChunks.push(chunk.toString("utf8")));

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
    mockContainerManager.exec.mockResolvedValueOnce({
      stream: backendStream,
      stdin: backendStdin,
      exec: { resize },
    });

    const ws = openExecStream("agent-k8s", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    backendStream.write("ready\n");
    ws.emit("message", JSON.stringify({ type: "input", data: "echo NORA_WS_EXEC_OK\n" }));
    ws.emit("message", JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "system",
      message: "Terminal for k8s backend — limited TTY support",
    });
    expect(ws.sent).toContainEqual({
      type: "system",
      message: "Connected to K8s Agent via k8s",
    });
    expect(ws.sent).toContainEqual({
      type: "output",
      data: "ready\n",
    });
    expect(stdinChunks.join("")).toContain("echo NORA_WS_EXEC_OK\n");
    expect(resize).toHaveBeenCalledWith({ h: 30, w: 100 });

    ws.close();
    expect(backendStdin.destroyed || backendStdin.writableEnded).toBe(true);
    expect(backendStream.destroyed).toBe(true);
  });

  it("fails closed without overlapping slow remote host authorization checks", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const backendStream = new PassThrough();
    const backendStdin = new PassThrough();
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
    mockContainerManager.exec.mockResolvedValue({
      stream: backendStream,
      stdin: backendStdin,
    });
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockReturnValue(slowRecheck);

    const ws = openExecStream(agent.id, { id: agent.user_id, role: "user" });
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
    expect(backendStream.destroyed).toBe(true);
    expect(backendStdin.destroyed || backendStdin.writableEnded).toBe(true);
  });

  it("closes an active terminal when its workspace editor is demoted", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const backendStream = new PassThrough();
    const backendStdin = new PassThrough();
    const agent = {
      id: "agent-editor-demoted",
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
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [{ role: "viewer" }] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.exec.mockResolvedValue({
      stream: backendStream,
      stdin: backendStdin,
    });
    mockAssertRemoteHostAgentUse.mockResolvedValue({ id: "shared-host" });

    const ws = openExecStream(agent.id, { id: "editor-1", role: "user" });
    await flushAsyncWork();
    expect(ws.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(250);

    expect(ws.sent).toContainEqual({ type: "error", message: "Agent not found" });
    expect(ws.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);
    expect(backendStream.destroyed).toBe(true);
    expect(backendStdin.destroyed || backendStdin.writableEnded).toBe(true);
  });

  it("fails closed when current actor access cannot be revalidated", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const backendStream = new PassThrough();
    const backendStdin = new PassThrough();
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
    mockContainerManager.exec.mockResolvedValue({
      stream: backendStream,
      stdin: backendStdin,
    });
    mockAssertRemoteHostAgentUse.mockResolvedValue({ id: "shared-host" });

    const ws = openExecStream(agent.id, { id: "owner-1", role: "user" });
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(250);

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unable to verify agent access",
      code: "AGENT_ACCESS_CHECK_FAILED",
    });
    expect(ws.closed).toBe(true);
    expect(backendStream.destroyed).toBe(true);
    expect(backendStdin.destroyed || backendStdin.writableEnded).toBe(true);
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

    const ws = openExecStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    expect(ws.closed).toBe(true);
    expect(mockContainerManager.exec).not.toHaveBeenCalled();
  });

  it("closes a remote exec socket when access is revoked during an unresolved status check", async () => {
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

    const ws = openExecStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();
    expect(mockContainerManager.status).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);

    expect(ws.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(ws.closed).toBe(true);
    expect(mockContainerManager.exec).not.toHaveBeenCalled();
  });

  it("cleans up a remote exec stream that attaches after authorization closes the socket", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const backendStream = new PassThrough();
    const backendStdin = new PassThrough();
    const agent = {
      id: "agent-remote-late-attach",
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
    let resolveExec;
    const delayedExec = new Promise((resolve) => {
      resolveExec = resolve;
    });

    mockDb.query.mockResolvedValue({ rows: [agent] });
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.exec.mockReturnValue(delayedExec);
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const ws = openExecStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();
    expect(mockContainerManager.exec).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);
    expect(ws.closed).toBe(true);

    resolveExec({ stream: backendStream, stdin: backendStdin });
    await flushAsyncWork();

    expect(backendStream.destroyed).toBe(true);
    expect(backendStdin.destroyed || backendStdin.writableEnded).toBe(true);
    expect(ws.sent).not.toContainEqual(
      expect.objectContaining({ type: "system", message: expect.stringMatching(/^Connected to/) }),
    );
  });

  it("closes active and rejects new remote exec sessions after the workspace host grant is revoked", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const backendStream = new PassThrough();
    const backendStdin = new PassThrough();
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
    mockContainerManager.exec.mockResolvedValue({
      stream: backendStream,
      stdin: backendStdin,
    });
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host", access: "workspace", canDeploy: true })
      .mockRejectedValue(revokedError);

    const activeWs = openExecStream(agent.id, { id: agent.user_id, role: "user" });
    await flushAsyncWork();

    expect(activeWs.closed).toBe(false);
    expect(mockContainerManager.exec).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);

    expect(activeWs.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(activeWs.closed).toBe(true);
    expect(backendStream.destroyed).toBe(true);
    expect(backendStdin.destroyed || backendStdin.writableEnded).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(500);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

    openExecStream(agent.id, { id: agent.user_id, role: "user" });
    const deniedWs = wsConnections.at(-1);
    await flushAsyncWork();

    expect(deniedWs.sent).toContainEqual({
      type: "error",
      message: revokedError.message,
      code: revokedError.code,
    });
    expect(deniedWs.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(3);
    expect(mockContainerManager.exec).toHaveBeenCalledTimes(1);
  });
  // ── Provisioning race guard ───────────────────────────────────────────────
  // A live container observed while the agent is still status='deploying' must
  // NOT be promoted to 'running'. The provisioner's own writes are guarded on
  // status='deploying', so clobbering it makes readiness finalization match zero
  // rows, which the worker reads as "agent deleted" and destroys the new runtime.
  // 'queued' is protected too: a redeploy queues while the previous container
  // is still live, and promoting it makes the worker skip the queued job.
  const PROMOTION_GUARD = /status\s+NOT\s+IN\s+\('deploying',\s*'queued'\)/;
  function stubAgentDb(dbRow) {
    mockDb.query.mockImplementation((sql) => {
      if (/UPDATE\s+agents/i.test(sql) && /status\s*=\s*'running'/.test(sql)) {
        // Emulate Postgres row matching for the promotion UPDATE.
        const guarded = PROMOTION_GUARD.test(sql);
        if (guarded && ["deploying", "queued"].includes(dbRow.status)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        dbRow.status = "running";
        return Promise.resolve({ rows: [{ id: dbRow.id }], rowCount: 1 });
      }
      // Authorization SELECT — hand the handler its own copy so that in-memory
      // state and database state stay independently observable.
      return Promise.resolve({ rows: [{ ...dbRow }] });
    });
  }

  function promotionQueries() {
    return mockDb.query.mock.calls.filter(
      ([sql]) => /UPDATE\s+agents/i.test(sql) && /status\s*=\s*'running'/.test(sql),
    );
  }

  function stubLiveExec() {
    mockContainerManager.status.mockResolvedValue({ running: true });
    mockContainerManager.exec.mockResolvedValue({
      stream: new PassThrough(),
      stdin: new PassThrough(),
      exec: { resize: jest.fn().mockResolvedValue(undefined) },
    });
  }

  it.each(["deploying", "queued"])(
    "does not promote a '%s' agent whose container is already live",
    async (lifecycleStatus) => {
      const dbRow = {
        id: `agent-${lifecycleStatus}`,
        name: "Lifecycle Agent",
        status: lifecycleStatus,
        container_id: `hermes-agent-${lifecycleStatus}`,
        backend_type: "k8s",
        deploy_target: "k8s",
        user_id: "owner-1",
      };
      stubAgentDb(dbRow);
      stubLiveExec();

      const ws = openExecStream(`agent-${lifecycleStatus}`, { id: "admin-1", role: "admin" });
      await flushAsyncWork();

      const promotions = promotionQueries();
      expect(promotions).toHaveLength(1);
      expect(promotions[0][0]).toMatch(PROMOTION_GUARD);

      // The UPDATE matched no rows: the provisioner still owns this agent.
      expect(dbRow.status).toBe(lifecycleStatus);
      expect(dbRow.container_id).toBe(`hermes-agent-${lifecycleStatus}`);

      ws.close();
    },
  );

  it("keeps the in-memory agent as deploying when the guarded promotion matches no row", async () => {
    const dbRow = {
      id: "agent-deploying-mem",
      name: "Deploying Agent",
      status: "deploying",
      container_id: "hermes-agent-deploying-mem",
      backend_type: "k8s",
      deploy_target: "k8s",
      user_id: "owner-1",
    };
    stubAgentDb(dbRow);
    stubLiveExec();

    const ws = openExecStream("agent-deploying-mem", { id: "admin-1", role: "admin" });
    await flushAsyncWork();

    // containerManager.exec receives the live in-memory agent object; it must not
    // have been mutated to 'running' when the database refused the promotion.
    expect(mockContainerManager.exec).toHaveBeenCalledTimes(1);
    expect(mockContainerManager.exec.mock.calls[0][0].status).toBe("deploying");
    expect(dbRow.status).toBe("deploying");

    ws.close();
  });

  it.each(["stopped", "warning", "error"])(
    "still corrects a stale '%s' status when the container is observed live",
    async (staleStatus) => {
      const dbRow = {
        id: `agent-stale-${staleStatus}`,
        name: "Stale Agent",
        status: staleStatus,
        container_id: `hermes-agent-stale-${staleStatus}`,
        backend_type: "k8s",
        deploy_target: "k8s",
        user_id: "owner-1",
      };
      stubAgentDb(dbRow);
      stubLiveExec();

      const ws = openExecStream(`agent-stale-${staleStatus}`, { id: "admin-1", role: "admin" });
      await flushAsyncWork();

      expect(promotionQueries()).toHaveLength(1);
      expect(dbRow.status).toBe("running");
      expect(mockContainerManager.exec).toHaveBeenCalledTimes(1);
      expect(mockContainerManager.exec.mock.calls[0][0].status).toBe("running");

      ws.close();
    },
  );
});
