// backend-api/logStream.js — WebSocket-based agent log streaming
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("./db");
const containerManager = require("./containerManager");

/**
 * Attach the live-log WebSocket server to an existing HTTP server.
 * Clients connect to  ws://<host>/ws/logs/<agentId>?token=<jwt>
 *
 * Uses containerManager for multi-backend support (Docker, K8s, Proxmox).
 * Reconciles live container status before deciding to stream.
 */
function attachLogStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/logs\/(.+)$/);
    if (!match) {
      return; // not ours — let other upgrade handlers (exec, etc.) handle it
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
      wss.emit("connection", ws, request, match[1], payload);
    });
  });

  wss.on("connection", async (ws, _req, agentId, user) => {
    try {
      const result = await db.query(
        "SELECT id, name, status, container_id, backend_type, user_id FROM agents WHERE id = $1",
        [agentId]
      );
      if (!result.rows[0]) {
        ws.send(JSON.stringify({ type: "error", message: "Agent not found" }));
        ws.close();
        return;
      }

      const agent = result.rows[0];
      const isAdmin = user?.role === "admin";
      if (!isAdmin && agent.user_id !== user?.id) {
        ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
        ws.close();
        return;
      }

      ws.send(
        JSON.stringify({
          type: "system",
          timestamp: new Date().toISOString(),
          message: `Connected to log stream for ${agent.name}`,
        })
      );

      if (!agent.container_id) {
        ws.send(
          JSON.stringify({
            type: "system",
            timestamp: new Date().toISOString(),
            message: "No container assigned — agent may still be provisioning",
          })
        );
        return;
      }

      // Live status check — reconcile DB status with actual container state
      let isRunning = agent.status === "running";
      try {
        const live = await containerManager.status(agent);
        isRunning = live.running;
        if (isRunning && agent.status !== "running") {
          // Fix stale DB status
          await db.query("UPDATE agents SET status = 'running' WHERE id = $1", [agent.id]);
        }
      } catch {
        // Can't reach container runtime — trust DB status
      }

      if (!isRunning) {
        ws.send(
          JSON.stringify({
            type: "system",
            timestamp: new Date().toISOString(),
            message: `Agent is ${agent.status} — logs will appear when the agent is running`,
          })
        );
        return; // keep connection open; client can wait
      }

      // ── Stream real container logs via containerManager ─────
      let logStream = null;
      try {
        logStream = await containerManager.logs(agent, { follow: true, tail: 100 });

        if (!logStream) {
          ws.send(
            JSON.stringify({
              type: "system",
              timestamp: new Date().toISOString(),
              message: "Log streaming not available for this backend",
            })
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "system",
            timestamp: new Date().toISOString(),
            message: `Streaming logs from ${agent.backend_type || "docker"} container...`,
          })
        );

        // Parse log lines (handles Docker multiplexed stream + raw streams)
        logStream.on("data", (chunk) => {
          if (ws.readyState !== 1) return;
          // Docker multiplexed stream: 8-byte header per frame
          // Skip the 8-byte docker header if present (stream_type byte > 2 means no header)
          let payload = chunk;
          if (chunk.length > 8 && chunk[0] <= 2 && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0) {
            payload = chunk.slice(8);
          }
          const text = payload.toString("utf8").trim();
          if (!text) return;

          for (const line of text.split("\n")) {
            if (!line.trim()) continue;

            // Docker timestamps format: 2024-01-15T12:34:56.789Z <message>
            let timestamp = new Date().toISOString();
            let message = line;
            const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)/);
            if (tsMatch) {
              timestamp = tsMatch[1];
              message = tsMatch[2];
            }

            // Infer log level from message content
            let level = "INFO";
            const upper = message.toUpperCase();
            if (upper.includes("ERROR") || upper.includes("ERR ")) level = "ERROR";
            else if (upper.includes("WARN")) level = "WARN";
            else if (upper.includes("DEBUG")) level = "DEBUG";

            ws.send(
              JSON.stringify({ type: "log", timestamp, level, message })
            );
          }
        });

        logStream.on("end", () => {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: "system",
                timestamp: new Date().toISOString(),
                message: "Container log stream ended",
              })
            );
          }
        });

        logStream.on("error", (err) => {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: "error",
                timestamp: new Date().toISOString(),
                message: `Log stream error: ${err.message}`,
              })
            );
          }
        });
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            timestamp: new Date().toISOString(),
            message: `Failed to attach to container: ${err.message}`,
          })
        );
        return;
      }

      ws.on("close", () => {
        if (logStream && typeof logStream.destroy === "function") {
          logStream.destroy();
        }
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
      ws.close();
    }
  });

  return wss;
}

module.exports = { attachLogStream };
