// backend-api/execStream.js — WebSocket-based interactive terminal for agent containers
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("./db");
const containerManager = require("./containerManager");

// Direct Docker access needed for exec sessions (containerManager.exec returns
// the raw exec object, but we need the Docker container object for full TTY support)
let docker = null;
try {
  const Docker = require("dockerode");
  docker = new Docker({ socketPath: "/var/run/docker.sock" });
} catch {
  console.warn("dockerode not available — interactive terminal will be unavailable");
}

/**
 * Attach interactive terminal WebSocket server to an HTTP server.
 * Clients connect to: ws://<host>/ws/exec/<agentId>?token=<jwt>
 *
 * Protocol (JSON messages from client):
 *   { type: "input",  data: "<keystrokes>" }
 *   { type: "resize", cols: 80, rows: 24 }
 *
 * Protocol (JSON messages to client):
 *   { type: "output", data: "<terminal output>" }
 *   { type: "system", message: "..." }
 *   { type: "error",  message: "..." }
 */
function attachExecStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/exec\/(.+)$/);
    if (!match) return; // not ours — let logStream or others handle it

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
      // Verify the agent belongs to this user
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
      if (agent.user_id !== user.id) {
        ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
        ws.close();
        return;
      }

      if (!agent.container_id) {
        ws.send(JSON.stringify({ type: "error", message: "No container ID — agent may still be provisioning" }));
        ws.close();
        return;
      }

      // Live status reconciliation — check if container is actually running
      let isRunning = agent.status === "running";
      try {
        const live = await containerManager.status(agent);
        isRunning = live.running;
        if (isRunning && agent.status !== "running") {
          await db.query("UPDATE agents SET status = 'running' WHERE id = $1", [agent.id]);
          agent.status = "running";
        }
      } catch {
        // trust DB status
      }

      if (!isRunning) {
        ws.send(JSON.stringify({
          type: "system",
          message: `Agent is ${agent.status} — terminal available when agent is running`,
        }));
        ws.close();
        return;
      }

      // For Docker-backed backends, use direct dockerode for full TTY exec support
      const backendType = agent.backend_type || "docker";
      if (backendType === "docker" || backendType === "nemoclaw") {
        if (!docker) {
          ws.send(JSON.stringify({ type: "error", message: "Docker not available on this host" }));
          ws.close();
          return;
        }

        const container = docker.getContainer(agent.container_id);
        const exec = await container.exec({
          Cmd: ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Env: ["TERM=xterm-256color"],
        });

        const stream = await exec.start({
          hijack: true,
          stdin: true,
          Tty: true,
        });

        ws.send(JSON.stringify({
          type: "system",
          message: `Connected to ${agent.name} (${agent.container_id.slice(0, 12)})`,
        }));

        // Container stdout/stderr → client
        stream.on("data", (chunk) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
          }
        });

        stream.on("end", () => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "system", message: "Shell session ended" }));
            ws.close();
          }
        });

        // Client keystrokes → container stdin
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === "input" && msg.data) {
              stream.write(msg.data);
            } else if (msg.type === "resize" && msg.cols && msg.rows) {
              exec.resize({ h: msg.rows, w: msg.cols }).catch(() => {});
            }
          } catch {
            // raw text fallback
            stream.write(raw);
          }
        });

        ws.on("close", () => {
          stream.end();
        });
      } else {
        // Non-Docker backends — basic shell via containerManager.exec
        ws.send(JSON.stringify({
          type: "system",
          message: `Terminal for ${backendType} backend — limited TTY support`,
        }));

        try {
          const execResult = await containerManager.exec(agent);
          if (!execResult) {
            ws.send(JSON.stringify({ type: "error", message: `Exec not supported for ${backendType} backend` }));
            ws.close();
            return;
          }
          ws.send(JSON.stringify({
            type: "system",
            message: `Connected to ${agent.name} via ${backendType}`,
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: `Exec failed: ${err.message}` }));
          ws.close();
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `Terminal error: ${err.message}` }));
      ws.close();
    }
  });

  return wss;
}

module.exports = { attachExecStream };
