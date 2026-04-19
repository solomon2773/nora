// @ts-nocheck
const { EventEmitter } = require("events");
const jwt = require("jsonwebtoken");

const mockDb = { query: jest.fn() };
const mockContainerManager = {
  status: jest.fn(),
  logs: jest.fn(),
};
const wsConnections = [];

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

describe("log stream websocket auth", () => {
  let attachLogStream;
  let server;

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "secret";
    mockDb.query.mockReset();
    mockContainerManager.status.mockReset();
    mockContainerManager.logs.mockReset();
    wsConnections.length = 0;

    ({ attachLogStream } = require("../logStream"));
    server = new EventEmitter();
    attachLogStream(server);
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
      Buffer.alloc(0)
    );

    return wsConnections[0];
  }

  it("rejects non-admin users from another owner's agent logs", async () => {
    mockDb.query.mockResolvedValueOnce({
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
    });

    const ws = openLogStream("agent-1", { id: "user-2", role: "user" });
    await flushAsyncWork();

    expect(ws.sent).toContainEqual({
      type: "error",
      message: "Unauthorized",
    });
    expect(ws.closed).toBe(true);
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
      })
    );
    expect(ws.sent[1]).toEqual(
      expect.objectContaining({
        type: "system",
        message: "No container assigned — agent may still be provisioning",
      })
    );
    expect(ws.closed).toBe(false);
  });
});
