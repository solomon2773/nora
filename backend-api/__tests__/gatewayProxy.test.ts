// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const mockDb = { query: jest.fn() };
const mockRecordMetric = jest.fn().mockResolvedValue();
const mockGetIntegrationsForSync = jest.fn();
const mockBuildIntegrationToolCatalogEntries = jest.fn();

class mockFakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = mockFakeWebSocket.OPEN;
    setImmediate(() => {
      if (this.readyState !== mockFakeWebSocket.OPEN) return;
      this.emit("message", Buffer.from(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1" },
      })));
    });
  }

  send(payload) {
    const msg = JSON.parse(payload);
    if (msg.method === "connect") {
      return setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: "__connect__",
          ok: true,
          result: { connected: true },
        })));
      });
    }

    if (msg.method === "health") {
      if (mockFakeWebSocket.healthMode === "error") {
        return setImmediate(() => {
          this.emit("message", Buffer.from(JSON.stringify({
            id: msg.id,
            ok: false,
            error: { message: "health failed" },
          })));
        });
      }
      return setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: msg.id,
          ok: true,
          result: { status: "ok" },
        })));
      });
    }

    if (msg.method === "status") {
      if (mockFakeWebSocket.statusMode === "error") {
        return setImmediate(() => {
          this.emit("message", Buffer.from(JSON.stringify({
            id: msg.id,
            ok: false,
            error: { message: "status failed" },
          })));
        });
      }
      return setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: msg.id,
          ok: true,
          result: { state: "idle" },
        })));
      });
    }

    if (msg.method === "chat.send") {
      return setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: msg.id,
          ok: true,
          result: {
            content: "pong",
            usage: { total_tokens: 42 },
          },
        })));
      });
    }

    if (msg.method === "tools.catalog") {
      return setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: msg.id,
          ok: true,
          result: mockFakeWebSocket.toolsCatalogResult || { tools: [] },
        })));
      });
    }
  }

  close() {
    if (this.readyState === mockFakeWebSocket.CLOSED) return;
    this.readyState = mockFakeWebSocket.CLOSED;
    this.emit("close");
  }
}
mockFakeWebSocket.CONNECTING = 0;
mockFakeWebSocket.OPEN = 1;
mockFakeWebSocket.CLOSING = 2;
mockFakeWebSocket.CLOSED = 3;
mockFakeWebSocket.healthMode = "success";
mockFakeWebSocket.statusMode = "success";
mockFakeWebSocket.toolsCatalogResult = { tools: [] };

class mockFakeWebSocketServer {
  on() {}
  handleUpgrade(req, socket, head, callback) {
    if (callback) callback(new EventEmitter());
  }
}

jest.mock("../db", () => mockDb);
jest.mock("../metrics", () => ({ recordMetric: mockRecordMetric }));
jest.mock("../integrations", () => ({
  getIntegrationsForSync: mockGetIntegrationsForSync,
  buildIntegrationToolCatalogEntries: mockBuildIntegrationToolCatalogEntries,
}));
jest.mock("ws", () => ({
  WebSocket: mockFakeWebSocket,
  WebSocketServer: mockFakeWebSocketServer,
}));

describe("gateway proxy control-plane routes", () => {
  let createGatewayRouter;
  let evictConnection;
  let app;

  beforeEach(() => {
    jest.resetModules();
    mockDb.query.mockReset();
    mockRecordMetric.mockClear();
    mockFakeWebSocket.healthMode = "success";
    mockFakeWebSocket.statusMode = "success";
    mockFakeWebSocket.toolsCatalogResult = { tools: [] };
    mockGetIntegrationsForSync.mockReset();
    mockBuildIntegrationToolCatalogEntries.mockReset();

    ({ createGatewayRouter, evictConnection } = require("../gatewayProxy"));

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: "user-1" };
      next();
    });
    app.use(createGatewayRouter());
  });

  afterEach(() => {
    evictConnection("10.0.0.10");
    evictConnection("10.0.0.20");
    evictConnection("10.0.0.30");
  });

  it("sends non-streaming chat through the gateway and records usage metrics", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "agent-1",
        user_id: "user-1",
        status: "running",
        host: "10.0.0.10",
        gateway_token: "gateway-token",
        gateway_host_port: null,
      }],
    });

    const res = await request(app)
      .post("/agents/agent-1/gateway/chat")
      .send({ message: "ping" });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("pong");
    expect(mockRecordMetric).toHaveBeenCalledWith("agent-1", "user-1", "messages_sent", 1);
    expect(mockRecordMetric).toHaveBeenCalledWith("agent-1", "user-1", "tokens_used", 42);
  });

  it("returns 502 when gateway health and status both fail", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "agent-1",
        user_id: "user-1",
        status: "running",
        host: "10.0.0.10",
        gateway_token: "gateway-token",
        gateway_host_port: null,
      }],
    });
    mockFakeWebSocket.healthMode = "error";
    mockFakeWebSocket.statusMode = "error";

    const res = await request(app).get("/agents/agent-1/gateway/status");

    expect(res.status).toBe(502);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "Gateway unreachable",
      })
    );
  });

  it("returns 409 for Hermes runtimes", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "agent-hermes-1",
        user_id: "user-1",
        status: "running",
        host: "10.0.0.30",
        backend_type: "hermes",
        runtime_family: "hermes",
        gateway_token: null,
        gateway_host_port: null,
      }],
    });

    const res = await request(app).get("/agents/agent-hermes-1/gateway/status");

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "This runtime family does not expose an OpenClaw gateway",
      })
    );
  });

  it("merges gateway-native tools with integration manifest tools", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "agent-2",
        user_id: "user-1",
        status: "running",
        host: "10.0.0.20",
        gateway_token: "gateway-token",
        gateway_host_port: null,
      }],
    });
    mockFakeWebSocket.toolsCatalogResult = {
      tools: [
        {
          type: "function",
          function: {
            name: "gateway_native_tool",
            description: "Native gateway tool.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    mockGetIntegrationsForSync.mockResolvedValue([
      { id: "int-gh", provider: "github", toolSpecs: [{ name: "github_list_repositories" }] },
    ]);
    mockBuildIntegrationToolCatalogEntries.mockReturnValue([
      {
        type: "function",
        function: {
          name: "github_list_repositories",
          description: "List repositories.",
          parameters: { type: "object", properties: {} },
        },
        nora: { source: "integration-manifest" },
      },
    ]);

    const res = await request(app).get("/agents/agent-2/gateway/tools");

    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(2);
    expect(res.body.tools[0].function.name).toBe("gateway_native_tool");
    expect(res.body.tools[1].function.name).toBe("github_list_repositories");
    expect(mockGetIntegrationsForSync).toHaveBeenCalledWith("agent-2");
    expect(mockBuildIntegrationToolCatalogEntries).toHaveBeenCalledWith(
      [{ id: "int-gh", provider: "github", toolSpecs: [{ name: "github_list_repositories" }] }],
      { reservedNames: new Set(["gateway_native_tool"]) }
    );
  });
});
