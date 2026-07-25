// @ts-nocheck
/**
 * __tests__/remoteHostGatewayAllowlist.test.ts — A3a: the HTTP gateway proxy
 * allows a remote-docker agent's own registered host address (which is not
 * RFC1918), while never widening the allowlist for other agents and still
 * enforcing the hard blocked-IP floor.
 */
const { EventEmitter } = require("events");

const mockDbQuery = jest.fn();
const mockGatewaySockets = [];
jest.mock("../db", () => ({ query: (...args) => mockDbQuery(...args) }));
jest.mock("../integrations", () => ({}));
jest.mock("../metrics", () => ({ recordMetric: jest.fn(), recordTokenUsage: jest.fn() }));
jest.mock("../agentBudgets", () => ({ checkAndEnforce: jest.fn() }));
jest.mock("ws", () => {
  const { EventEmitter: MockEventEmitter } = jest.requireActual("events");

  class MockWebSocket extends MockEventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      this.closed = false;
      mockGatewaySockets.push(this);
    }

    send(payload) {
      this.sent.push(payload.toString());
    }

    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.alloc(0));
    }
  }

  class MockWebSocketServer {
    constructor() {
      this.handlers = {};
    }

    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }

    handleUpgrade() {}
  }

  return { WebSocket: MockWebSocket, WebSocketServer: MockWebSocketServer };
});

const mockGetRemoteHostByExecutionTarget = jest.fn();
const mockUserCanUseRemoteHost = jest.fn().mockResolvedValue(false);
const mockAssertRemoteHostAgentUse = jest.fn();
jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
  getRemoteHostByExecutionTarget: (...args) => mockGetRemoteHostByExecutionTarget(...args),
  isRemoteDockerAgent: (agent = {}) =>
    [
      agent.deploy_target,
      agent.deployTarget,
      agent.backend_type,
      agent.backendType,
      agent.execution_target_id,
      agent.executionTargetId,
    ].some((value) => {
      const normalized = String(value || "")
        .trim()
        .toLowerCase();
      return (
        normalized === "remote-docker" ||
        normalized === "remote" ||
        normalized.startsWith("remote:")
      );
    }),
  isRemoteHostAccessRevokedError: (error) => error?.code === "REMOTE_HOST_ACCESS_REVOKED",
  toPublicRemoteHostAuthorizationError: (error) => {
    if (error?.code === "REMOTE_HOST_ACCESS_REVOKED") return error;
    return Object.assign(new Error("Unable to verify Remote Docker host access"), {
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
      statusCode: 503,
      cause: error,
    });
  },
  userCanUseRemoteHost: (...args) => mockUserCanUseRemoteHost(...args),
}));

const originalRemoteHostAuthRecheckMs = process.env.REMOTE_HOST_AUTH_RECHECK_MS;
process.env.REMOTE_HOST_AUTH_RECHECK_MS = "250";

const {
  allowedGatewayHostsForAgent,
  attachGatewayWS,
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
  assertExternalEndpointReachable,
  rpcCall,
} = require("../gatewayProxy");

const PUBLIC_IP = "203.0.113.5";
const originalPlatformMode = process.env.PLATFORM_MODE;

function remoteAgent(overrides = {}) {
  return {
    id: "agent-1",
    user_id: "user-1",
    deploy_target: "remote-docker",
    execution_target_id: "remote:my-vps",
    gateway_host: PUBLIC_IP,
    gateway_port: 19042,
    ...overrides,
  };
}

function createClientWebSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.closed = false;
  ws.send = jest.fn((payload) => {
    ws.sent.push(JSON.parse(payload.toString()));
  });
  ws.close = jest.fn(() => {
    if (ws.closed) return;
    ws.closed = true;
    ws.readyState = 3;
    ws.emit("close");
  });
  return ws;
}

async function flushPromiseWork() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  process.env.PLATFORM_MODE = "selfhosted";
  mockDbQuery.mockReset();
  mockGetRemoteHostByExecutionTarget.mockReset();
  mockUserCanUseRemoteHost.mockReset();
  mockUserCanUseRemoteHost.mockResolvedValue(false);
  mockAssertRemoteHostAgentUse.mockReset();
  mockGatewaySockets.length = 0;
  mockAssertRemoteHostAgentUse.mockImplementation(async (agent) => {
    const host = await mockGetRemoteHostByExecutionTarget(agent.execution_target_id);
    if (host?.ownerUserId === agent.user_id) return host;
    if (host && (await mockUserCanUseRemoteHost(agent.user_id, host.id))) return host;
    throw Object.assign(new Error("Remote Docker host access has been revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
  });
});

afterEach(() => {
  for (const socket of mockGatewaySockets) socket.close();
  jest.useRealTimers();
});

afterAll(() => {
  if (originalPlatformMode === undefined) delete process.env.PLATFORM_MODE;
  else process.env.PLATFORM_MODE = originalPlatformMode;
  if (originalRemoteHostAuthRecheckMs === undefined) {
    delete process.env.REMOTE_HOST_AUTH_RECHECK_MS;
  } else {
    process.env.REMOTE_HOST_AUTH_RECHECK_MS = originalRemoteHostAuthRecheckMs;
  }
});

describe("remote-host gateway allowlist (HTTP proxy)", () => {
  it("allows a remote-docker agent's own registered (non-RFC1918) host", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const target = await resolveSafeGatewayHttpTarget(remoteAgent(), "status");
    expect(target.url).toBe(`http://${PUBLIC_IP}:19042/status`);
    expect(mockGetRemoteHostByExecutionTarget).toHaveBeenCalledWith("remote:my-vps");
  });

  it("treats a legacy backend-only Remote Docker row as grant-controlled", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const legacyAgent = remoteAgent({ deploy_target: "", backend_type: "remote-docker" });

    await expect(resolveSafeGatewayHttpTarget(legacyAgent, "status")).rejects.toMatchObject({
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
  });

  it("fails closed on authorization-store errors even when the gateway address is private", async () => {
    const authError = new Error("authorization database unavailable");
    mockAssertRemoteHostAgentUse.mockRejectedValue(authError);

    await expect(
      resolveSafeGatewayHttpTarget(
        remoteAgent({ gateway_host: "10.0.0.25", runtime_host: "10.0.0.25" }),
        "status",
      ),
    ).rejects.toMatchObject({
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
      statusCode: 503,
      cause: authError,
    });
  });

  it("does NOT trust a remote host registered by a different operator", async () => {
    // Cross-tenant execution_target_id reference: the host belongs to user-2 and is
    // NOT shared to user-1 (userCanUseRemoteHost defaults to false).
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    await expect(resolveSafeGatewayHttpTarget(remoteAgent(), "status")).rejects.toMatchObject({
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    expect(mockUserCanUseRemoteHost).toHaveBeenCalledWith("user-1", "my-vps");
  });

  it("trusts another operator's host when it is SHARED to the agent owner (C3 grant)", async () => {
    // host owned by user-2 but shared into a workspace where user-1 is editor+.
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    mockUserCanUseRemoteHost.mockResolvedValue(true);
    const target = await resolveSafeGatewayHttpTarget(remoteAgent(), "status");
    expect(target.url).toBe(`http://${PUBLIC_IP}:19042/status`);
    expect(mockUserCanUseRemoteHost).toHaveBeenCalledWith("user-1", "my-vps");
  });

  it("rejects a public host when no matching remote host is registered", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue(null);
    await expect(resolveSafeGatewayHttpTarget(remoteAgent(), "status")).rejects.toMatchObject({
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
  });

  it("fails closed on a null-owner host — runs the grant check, does not short-circuit", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: null,
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    // userCanUseRemoteHost defaults to false → no grant → blocked.
    await expect(resolveSafeGatewayHttpTarget(remoteAgent(), "status")).rejects.toMatchObject({
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
    expect(mockUserCanUseRemoteHost).toHaveBeenCalledWith("user-1", "my-vps");
  });

  it("does NOT widen the allowlist for a non-remote agent with a public host", async () => {
    // A docker agent must never reach a public address — the registry lookup is
    // skipped entirely (deploy_target !== remote-docker).
    const dockerAgent = remoteAgent({ deploy_target: "docker", execution_target_id: "docker" });
    await expect(resolveSafeGatewayHttpTarget(dockerAgent, "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("still blocks dangerous addresses even for a registered remote host", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: "169.254.169.254",
      sshHost: "169.254.169.254",
    });
    const linkLocal = remoteAgent({ gateway_host: "169.254.169.254" });
    await expect(resolveSafeGatewayHttpTarget(linkLocal, "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
  });

  it("blocks historical Remote Docker rows before a hosted-mode registry lookup", async () => {
    process.env.PLATFORM_MODE = "paas";
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: "10.0.0.7",
      sshHost: "10.0.0.7",
    });

    await expect(
      resolveSafeGatewayHttpTarget(remoteAgent({ gateway_host: "10.0.0.7" }), "status"),
    ).rejects.toMatchObject({
      code: "REMOTE_HOSTS_DISABLED_IN_PAAS",
      statusCode: 403,
    });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("trusts a k8s agent's operator-provisioned (public LoadBalancer) address", async () => {
    // k8s exposure addresses (LB/NodePort) are operator-provisioned, so RPC/WS/HTTP
    // must reach them even when public — without a registry lookup.
    const k8sAgent = {
      id: "agent-k8s",
      user_id: "user-1",
      deploy_target: "k8s",
      execution_target_id: "k8s:prod",
      gateway_host: "203.0.113.20",
      gateway_port: 18789,
    };
    const target = await resolveSafeGatewayHttpTarget(k8sAgent, "status");
    expect(target.url).toBe("http://203.0.113.20:18789/status");
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("allows a docker agent to reach a custom (non-RFC1918) GATEWAY_HOST published host", async () => {
    // Regression guard: a docker agent reaches its gateway via the operator's
    // GATEWAY_HOST (publishedHost), which may not be RFC1918. Trusting it keeps
    // docker chat working regardless of what the operator configured.
    const prev = process.env.GATEWAY_HOST;
    process.env.GATEWAY_HOST = "198.51.100.7"; // public test IP, not RFC1918
    try {
      const dockerAgent = {
        id: "agent-docker",
        user_id: "user-1",
        deploy_target: "docker",
        execution_target_id: "docker",
        gateway_host: null,
        gateway_host_port: 19042,
      };
      const target = await resolveSafeGatewayHttpTarget(dockerAgent, "status");
      expect(target.url).toBe("http://198.51.100.7:19042/status");
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_HOST;
      else process.env.GATEWAY_HOST = prev;
    }
  });

  it("still allows an ordinary RFC1918 docker host (no regression)", async () => {
    const dockerAgent = remoteAgent({
      deploy_target: "docker",
      execution_target_id: "docker",
      gateway_host: "10.0.0.10",
      gateway_port: 19000,
    });
    const target = await resolveSafeGatewayHttpTarget(dockerAgent, "status");
    expect(target.url).toBe("http://10.0.0.10:19000/status");
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});

describe("hosted-mode Remote Docker gateway shutdown", () => {
  beforeEach(() => {
    process.env.PLATFORM_MODE = "paas";
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
  });

  it("rejects the shared allowlist boundary even when a historical public host resolves", async () => {
    await expect(allowedGatewayHostsForAgent(remoteAgent())).rejects.toMatchObject({
      code: "REMOTE_HOSTS_DISABLED_IN_PAAS",
      statusCode: 403,
    });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("rejects pooled RPC before opening or reusing a remote gateway connection", async () => {
    await expect(
      rpcCall(remoteAgent({ gateway_token: "legacy-gateway-token" }), "status"),
    ).rejects.toMatchObject({
      code: "REMOTE_HOSTS_DISABLED_IN_PAAS",
      statusCode: 403,
    });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("rejects the Remote Hermes embed path before consulting the host registry", async () => {
    await expect(
      resolveSafeHermesDashboardTarget({
        ...remoteAgent(),
        runtime_family: "hermes",
        runtime_host: PUBLIC_IP,
        dashboard_port: 19044,
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_HOSTS_DISABLED_IN_PAAS",
      statusCode: 403,
    });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("rejects the WebSocket relay for a historical Remote Docker agent", async () => {
    const agent = {
      ...remoteAgent(),
      status: "running",
      gateway_token: "legacy-gateway-token",
    };
    mockDbQuery.mockResolvedValue({ rows: [agent] });
    const server = { on: jest.fn() };
    const wss = attachGatewayWS(server);
    const ws = { send: jest.fn(), close: jest.fn() };

    await wss.handlers.connection(ws, {}, agent.id, { id: agent.user_id });

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining("Remote Docker gateway access is disabled in hosted mode"),
    );
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});

describe("remote-host gateway relay grant revocation", () => {
  it("does not open an upstream socket after the relay client disconnects during authorization", async () => {
    let releaseAuthorization;
    const authorization = new Promise((resolve) => {
      releaseAuthorization = resolve;
    });
    const agent = {
      ...remoteAgent(),
      status: "running",
      gateway_token: "legacy-gateway-token",
    };
    const host = {
      id: "my-vps",
      ownerUserId: agent.user_id,
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    };
    mockDbQuery.mockResolvedValue({ rows: [agent] });
    mockAssertRemoteHostAgentUse.mockImplementationOnce(() => authorization);

    const server = { on: jest.fn() };
    const wss = attachGatewayWS(server);
    const clientWs = createClientWebSocket();
    const connecting = wss.handlers.connection(clientWs, {}, agent.id, { id: agent.user_id });
    await flushPromiseWork();

    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);
    clientWs.close();
    releaseAuthorization(host);
    await connecting;

    expect(mockGatewaySockets).toHaveLength(0);
    expect(clientWs.sent).toHaveLength(0);
  });

  it("rechecks the host grant immediately before sending the relay credential", async () => {
    let grantActive = true;
    const agent = {
      ...remoteAgent(),
      status: "running",
      gateway_token: "legacy-gateway-token",
    };
    const host = {
      id: "my-vps",
      ownerUserId: "host-owner-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    };

    mockDbQuery.mockResolvedValue({ rows: [agent] });
    mockGetRemoteHostByExecutionTarget.mockResolvedValue(host);
    mockUserCanUseRemoteHost.mockImplementation(async () => grantActive);

    const server = { on: jest.fn() };
    const wss = attachGatewayWS(server);
    const clientWs = createClientWebSocket();
    await wss.handlers.connection(clientWs, {}, agent.id, { id: agent.user_id });

    const authorizationCallsBeforeGatewayHandshake = mockAssertRemoteHostAgentUse.mock.calls.length;
    const gatewayWs = mockGatewaySockets[0];
    gatewayWs.readyState = 1;
    gatewayWs.emit("open");

    grantActive = false;
    gatewayWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "relay-nonce" },
        }),
      ),
    );
    await flushPromiseWork();

    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(
      authorizationCallsBeforeGatewayHandshake + 1,
    );
    expect(gatewayWs.sent).toHaveLength(0);
    expect(clientWs.sent).toContainEqual({
      type: "error",
      message: "Remote Docker host access has been revoked",
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    expect(clientWs.closed).toBe(true);
    expect(gatewayWs.closed).toBe(true);
  });

  it("closes the active relay, stops forwarding, and rejects a new relay after revocation", async () => {
    jest.useFakeTimers();
    let grantActive = true;
    const agent = {
      ...remoteAgent(),
      status: "running",
      gateway_token: "legacy-gateway-token",
    };
    const host = {
      id: "my-vps",
      ownerUserId: "host-owner-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    };

    mockDbQuery.mockResolvedValue({ rows: [agent] });
    mockGetRemoteHostByExecutionTarget.mockResolvedValue(host);
    mockUserCanUseRemoteHost.mockImplementation(async () => grantActive);

    const server = { on: jest.fn() };
    const wss = attachGatewayWS(server);
    const clientWs = createClientWebSocket();

    await wss.handlers.connection(clientWs, {}, agent.id, { id: agent.user_id });

    expect(mockGatewaySockets).toHaveLength(1);
    const gatewayWs = mockGatewaySockets[0];
    gatewayWs.readyState = 1;
    gatewayWs.emit("open");

    const challenge = {
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "relay-nonce" },
    };
    gatewayWs.emit("message", Buffer.from(JSON.stringify(challenge)));
    await flushPromiseWork();

    expect(clientWs.sent).toContainEqual(challenge);
    expect(gatewayWs.sent.map((payload) => JSON.parse(payload))).toContainEqual(
      expect.objectContaining({ id: "__relay_connect__", method: "connect" }),
    );

    gatewayWs.emit(
      "message",
      Buffer.from(JSON.stringify({ id: "__relay_connect__", ok: true, payload: {} })),
    );
    await flushPromiseWork();

    const beforeRevocation = { type: "req", id: "before-revocation", method: "status" };
    clientWs.emit("message", Buffer.from(JSON.stringify(beforeRevocation)));
    await flushPromiseWork();
    expect(gatewayWs.sent.map((payload) => JSON.parse(payload))).toContainEqual(beforeRevocation);

    grantActive = false;
    await jest.advanceTimersByTimeAsync(250);

    expect(clientWs.sent).toContainEqual({
      type: "error",
      message: "Remote Docker host access has been revoked",
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    expect(clientWs.closed).toBe(true);
    expect(gatewayWs.closed).toBe(true);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(4);

    await jest.advanceTimersByTimeAsync(250);
    expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(4);

    const gatewaySendCount = gatewayWs.sent.length;
    clientWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "req", id: "after-revocation", method: "status" })),
    );
    gatewayWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "event", event: "post-revocation", payload: { leaked: true } }),
      ),
    );
    await flushPromiseWork();

    expect(gatewayWs.sent).toHaveLength(gatewaySendCount);
    expect(clientWs.sent).not.toContainEqual(expect.objectContaining({ event: "post-revocation" }));

    const deniedClientWs = createClientWebSocket();
    await wss.handlers.connection(deniedClientWs, {}, agent.id, { id: agent.user_id });

    expect(deniedClientWs.sent).toContainEqual({
      type: "error",
      message: "Remote Docker host access has been revoked",
    });
    expect(deniedClientWs.closed).toBe(true);
    expect(mockGatewaySockets).toHaveLength(1);
  });

  it("closes the relay without exposing authorization-store failures", async () => {
    jest.useFakeTimers();
    const agent = {
      ...remoteAgent(),
      status: "running",
      gateway_token: "legacy-gateway-token",
    };
    mockDbQuery.mockResolvedValue({ rows: [agent] });
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: agent.user_id,
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });

    const server = { on: jest.fn() };
    const wss = attachGatewayWS(server);
    const clientWs = createClientWebSocket();
    await wss.handlers.connection(clientWs, {}, agent.id, { id: agent.user_id });

    const internalError = new Error("postgres connection string leaked here");
    mockAssertRemoteHostAgentUse.mockRejectedValue(internalError);
    await jest.advanceTimersByTimeAsync(250);

    expect(clientWs.sent).toContainEqual({
      type: "error",
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    expect(JSON.stringify(clientWs.sent)).not.toContain(internalError.message);
    expect(clientWs.closed).toBe(true);
  });
});

describe("hermes dashboard embed-proxy allowlist (SSRF)", () => {
  it("allows a local Hermes agent's RFC1918 dashboard host", async () => {
    const agent = {
      id: "hermes-1",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "docker",
      execution_target_id: "docker",
      runtime_host: "10.0.0.7",
    };
    const target = await resolveSafeHermesDashboardTarget(agent);
    expect(target).toEqual({ host: "10.0.0.7", port: 9119 });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("rejects a Hermes agent whose runtime_host is a public address (SSRF guard)", async () => {
    const agent = {
      id: "hermes-2",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "docker",
      execution_target_id: "docker",
      runtime_host: PUBLIC_IP,
    };
    await expect(resolveSafeHermesDashboardTarget(agent)).rejects.toThrow(
      /not an allowed gateway address/i,
    );
  });

  it("allows a remote Hermes agent's own registered host (owner-scoped)", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const agent = {
      id: "hermes-3",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "remote-docker",
      execution_target_id: "remote:my-vps",
      runtime_host: PUBLIC_IP,
      // B2c-2: the remote dashboard is published on its own host port (in the
      // gateway range) and persisted in dashboard_port. The embed proxy resolves
      // {runtime_host, dashboard_port} and the owner-scoped registered host is
      // trusted by the allowlist.
      dashboard_port: 19044,
    };
    const target = await resolveSafeHermesDashboardTarget(agent);
    expect(target).toEqual({ host: PUBLIC_IP, port: 19044 });
  });

  it("does not trust a remote Hermes host registered by another operator", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const agent = {
      id: "hermes-4",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "remote-docker",
      execution_target_id: "remote:my-vps",
      runtime_host: PUBLIC_IP,
      runtime_port: 19042,
    };
    await expect(resolveSafeHermesDashboardTarget(agent)).rejects.toMatchObject({
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
  });

  it("trusts a k8s Hermes agent's provisioned (public LoadBalancer/NodePort) dashboard", async () => {
    // k8s exposure addresses are operator-provisioned, so the dashboard must be
    // reachable even on a public IP — without a remote-host registry lookup. This
    // relies on gateway_host/gateway_port being loaded by the embed lookup.
    const agent = {
      id: "hermes-k8s",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "k8s",
      execution_target_id: "k8s:prod",
      gateway_host: "203.0.113.20",
      gateway_port: 30119, // NodePort range
      runtime_host: "10.42.0.3",
    };
    const target = await resolveSafeHermesDashboardTarget(agent);
    expect(target).toEqual({ host: "203.0.113.20", port: 30119 });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});

describe("external runtime adoption (BYOC Phase C)", () => {
  describe("assertExternalEndpointReachable (registration gate)", () => {
    it("allows a public endpoint on the gateway port (selfhosted)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: PUBLIC_IP, port: 18789 }, { paas: false }),
      ).resolves.toEqual({ host: PUBLIC_IP, port: 18789 });
    });

    it("allows a private endpoint in selfhosted mode (operator's own network)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: "10.0.0.7", port: 18789 }, { paas: false }),
      ).resolves.toEqual({ host: "10.0.0.7", port: 18789 });
    });

    it("rejects a private endpoint in hosted (PaaS) mode (no internal pivot)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: "10.0.0.7", port: 18789 }, { paas: true }),
      ).rejects.toThrow(/public address in hosted mode/i);
    });

    it("rejects a blocked (metadata/link-local) endpoint regardless of mode (floor)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: "169.254.169.254", port: 18789 }, { paas: false }),
      ).rejects.toThrow(/not an allowed gateway address/i);
    });

    it("rejects a non-allowed port", async () => {
      await expect(
        assertExternalEndpointReachable({ host: PUBLIC_IP, port: 80 }, { paas: false }),
      ).rejects.toThrow(/port is not allowed/i);
    });

    it("allows the Hermes dashboard port (9119)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: PUBLIC_IP, port: 9119 }, { paas: false }),
      ).resolves.toEqual({ host: PUBLIC_IP, port: 9119 });
    });
  });

  it("the proxy trusts an adopted external agent's own declared endpoint", async () => {
    // deploy_target='external' ⇒ allowedGatewayHostsForAgent trusts the agent's own
    // gateway_host (owner-scoped via the row); the public endpoint is reachable.
    const agent = {
      id: "agent-ext",
      user_id: "user-1",
      deploy_target: "external",
      execution_target_id: "external",
      gateway_host: PUBLIC_IP,
      gateway_port: 18789,
    };
    const target = await resolveSafeGatewayHttpTarget(agent, "status");
    expect(target.url).toBe(`http://${PUBLIC_IP}:18789/status`);
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});
