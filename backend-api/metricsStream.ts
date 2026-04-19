// @ts-nocheck
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { buildAgentStatsResponse } = require("./agentTelemetry");

const STREAM_INTERVAL_MS = 5000;

function attachMetricsStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/metrics\/(.+)$/);
    if (!match) {
      return;
    }

    const token = url.searchParams.get("token");
    let payload;

    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, { agentId: match[1], userId: payload.id });
    });
  });

  wss.on("connection", async (ws, { agentId, userId }) => {
    let closed = false;

    const sendSnapshot = async () => {
      const result = await db.query(
        "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
        [agentId, userId]
      );
      const agent = result.rows[0];

      if (!agent) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", message: "Agent not found" }));
        }
        ws.close();
        return;
      }

      const payload = await buildAgentStatsResponse(agent);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "snapshot", payload }));
      }
    };

    try {
      await sendSnapshot();
    } catch (error) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "error", message: error.message }));
      }
    }

    const interval = setInterval(() => {
      sendSnapshot().catch((error) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", message: error.message }));
        }
      });
    }, STREAM_INTERVAL_MS);

    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
    };

    ws.on("close", teardown);
    ws.on("error", teardown);
  });

  return wss;
}

module.exports = { attachMetricsStream };
