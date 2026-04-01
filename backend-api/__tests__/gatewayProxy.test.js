const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const mockDb = { query: jest.fn() };
const mockRecordMetric = jest.fn().mockResolvedValue();

class mockFakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = mockFakeWebSocket.OPEN;
    setImmediate(() => {
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
      return setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: msg.id,
          ok: true,
          result: { status: "ok" },
        })));
      });
    }

    if (msg.method === "status") {
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
  }

  close() {
    this.readyState = mockFakeWebSocket.CLOSED;
    this.emit("close");
  }
}
mockFakeWebSocket.CONNECTING = 0;
mockFakeWebSocket.OPEN = 1;
mockFakeWebSocket.CLOSING = 2;
mockFakeWebSocket.CLOSED = 3;

class mockFakeWebSocketServer {
  on() {}
  handleUpgrade(req, socket, head, callback) {
    if (callback) callback(new EventEmitter());
  }
}

jest.mock("../db", () => mockDb);
jest.mock("../metrics", () => ({ recordMetric: mockRecordMetric }));
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
});
