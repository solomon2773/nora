// @ts-nocheck
// backend-api/logStream.ts — WebSocket-based agent log streaming
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("./db");
const containerManager = require("./containerManager");
const { resolveAgentBackendType } = require("./agentRuntimeFields");
const { extractSessionTokenFromUpgrade } = require("./authCookie");
const { findAccessibleAgentForActor } = require("./middleware/ownership");
const { assertRemoteHostAgentUse, isRemoteHostAccessRevokedError } = require("./remoteHosts");

const ACCESS_RECHECK_MS = Math.max(
  250,
  Number.parseInt(process.env.REMOTE_HOST_AUTH_RECHECK_MS || "1000", 10) || 1000,
);

function authorizationFailure(message, code, cause) {
  const error = new Error(message);
  if (code) error.code = code;
  if (cause) error.cause = cause;
  error.authorizationCheckFailed = true;
  return error;
}

function isAuthorizationFailure(error) {
  return (
    error?.authorizationCheckFailed ||
    isRemoteHostAccessRevokedError(error) ||
    error?.code === "REMOTE_HOST_AUTH_CHECK_FAILED"
  );
}

function publicAuthorizationError(error) {
  if (isRemoteHostAccessRevokedError(error)) {
    return { message: error.message, code: error.code };
  }
  if (error?.code === "REMOTE_HOST_AUTH_CHECK_FAILED") {
    return {
      message: "Unable to verify Remote Docker host access",
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    };
  }
  return {
    message: error?.authorizationCheckFailed ? error.message : "Unable to verify agent access",
    ...(error?.code ? { code: error.code } : {}),
  };
}

/**
 * Attach a viewer-authorized live-log WebSocket endpoint to an HTTP server.
 * Clients connect to  ws://<host>/ws/logs/<agentId> (cookie-authenticated)
 * or the legacy  ws://<host>/ws/logs/<agentId>?token=<jwt>  form.
 *
 * Uses containerManager for multi-backend support (Docker, K8s, Proxmox).
 * Reconciles live container status before deciding to stream.
 *
 * @param {Object} server - HTTP server receiving the upgrade handler.
 * @returns {Object} Attached WebSocket server.
 */
function attachLogStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/logs\/(.+)$/);
    if (!match) {
      return; // not ours — let other upgrade handlers (exec, etc.) handle it
    }

    const token = extractSessionTokenFromUpgrade(request, url.searchParams);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
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
      const findAuthorizedAgent = async () => {
        let currentAgent;
        try {
          currentAgent = await findAccessibleAgentForActor(agentId, user, "viewer");
        } catch (error) {
          throw authorizationFailure(
            "Unable to verify agent access",
            "AGENT_ACCESS_CHECK_FAILED",
            error,
          );
        }
        if (!currentAgent) throw authorizationFailure("Agent not found");

        try {
          await assertRemoteHostAgentUse(currentAgent, { includeProfile: false });
        } catch (error) {
          if (isRemoteHostAccessRevokedError(error)) {
            error.authorizationCheckFailed = true;
            throw error;
          }
          throw authorizationFailure(
            "Unable to verify Remote Docker host access",
            "REMOTE_HOST_AUTH_CHECK_FAILED",
            error,
          );
        }
        return currentAgent;
      };

      const agent = await findAuthorizedAgent();

      // Keep actor membership and the durable-owner Remote Docker grant live
      // for the entire socket lifetime, including while status/log attachment
      // is blocked and while a no-container connection waits idle.
      let logStream = null;
      let accessTimer = null;
      let accessCheckPromise = null;
      let clientClosed = ws.readyState !== 1;
      const clearAccessTimer = () => {
        if (accessTimer) {
          clearInterval(accessTimer);
          accessTimer = null;
        }
      };
      const cleanupLogStream = () => {
        clientClosed = true;
        clearAccessTimer();
        if (logStream && typeof logStream.destroy === "function") logStream.destroy();
      };
      const closeForAuthorizationFailure = (error) => {
        clearAccessTimer();
        const publicError = publicAuthorizationError(error);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", ...publicError }));
          ws.close();
        } else {
          cleanupLogStream();
        }
      };
      const runAccessCheck = () => {
        if (clientClosed || ws.readyState !== 1) return Promise.resolve();
        if (accessCheckPromise) return accessCheckPromise;
        accessCheckPromise = (async () => {
          try {
            await findAuthorizedAgent();
          } catch (error) {
            closeForAuthorizationFailure(error);
          } finally {
            accessCheckPromise = null;
          }
        })();
        return accessCheckPromise;
      };
      ws.on("close", cleanupLogStream);
      ws.on("error", cleanupLogStream);
      accessTimer = setInterval(() => {
        void runAccessCheck();
      }, ACCESS_RECHECK_MS);
      accessTimer.unref?.();

      const backendType = resolveAgentBackendType(agent);
      ws.send(
        JSON.stringify({
          type: "system",
          timestamp: new Date().toISOString(),
          message: `Connected to log stream for ${agent.name}`,
        }),
      );

      if (!agent.container_id) {
        ws.send(
          JSON.stringify({
            type: "system",
            timestamp: new Date().toISOString(),
            message: "No container assigned — agent may still be provisioning",
          }),
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
      if (clientClosed || ws.readyState !== 1) return;

      if (!isRunning) {
        ws.send(
          JSON.stringify({
            type: "system",
            timestamp: new Date().toISOString(),
            message: `Agent is ${agent.status} — logs will appear when the agent is running`,
          }),
        );
        return; // keep connection open; client can wait
      }

      // ── Stream real container logs via containerManager ─────
      try {
        logStream = await containerManager.logs(agent, { follow: true, tail: 100 });
        if (clientClosed || ws.readyState !== 1) {
          cleanupLogStream();
          return;
        }

        if (!logStream) {
          ws.send(
            JSON.stringify({
              type: "system",
              timestamp: new Date().toISOString(),
              message: "Log streaming not available for this backend",
            }),
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "system",
            timestamp: new Date().toISOString(),
            message: `Streaming logs from ${backendType} container...`,
          }),
        );

        // Parse log lines (handles Docker multiplexed stream + raw streams)
        logStream.on("data", (chunk) => {
          if (ws.readyState !== 1) return;
          // Docker multiplexed stream: 8-byte header per frame
          // Skip the 8-byte docker header if present (stream_type byte > 2 means no header)
          let payload = chunk;
          if (
            chunk.length > 8 &&
            chunk[0] <= 2 &&
            chunk[1] === 0 &&
            chunk[2] === 0 &&
            chunk[3] === 0
          ) {
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

            ws.send(JSON.stringify({ type: "log", timestamp, level, message }));
          }
        });

        logStream.on("end", () => {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: "system",
                timestamp: new Date().toISOString(),
                message: "Container log stream ended",
              }),
            );
          }
        });

        logStream.on("error", (err) => {
          clearAccessTimer();
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: "error",
                timestamp: new Date().toISOString(),
                message: `Log stream error: ${err.message}`,
              }),
            );
            ws.close();
          }
        });
      } catch (err) {
        cleanupLogStream();
        const publicError = isAuthorizationFailure(err)
          ? publicAuthorizationError(err)
          : { message: `Failed to attach to container: ${err.message}` };
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: "error",
              timestamp: new Date().toISOString(),
              ...publicError,
            }),
          );
          ws.close();
        }
        return;
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "error",
            ...(isAuthorizationFailure(err)
              ? publicAuthorizationError(err)
              : { message: "Internal error" }),
          }),
        );
        ws.close();
      }
    }
  });

  return wss;
}

module.exports = { attachLogStream };
