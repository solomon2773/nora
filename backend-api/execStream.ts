// @ts-nocheck
// backend-api/execStream.ts — WebSocket-based interactive terminal for agent containers
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

// Direct Docker access needed for exec sessions (containerManager.exec returns
// the raw exec object, but we need the Docker container object for full TTY support)
let docker = null;
try {
  const Docker = require("dockerode");
  docker = new Docker({ socketPath: "/var/run/docker.sock" });
} catch {
  console.warn("dockerode not available — interactive terminal will be unavailable");
}

// The JSON wire protocol accepts input/resize messages and emits
// output/system/error messages.

/**
 * Attach an editor-authorized terminal WebSocket endpoint, selecting full
 * Docker TTY support or the limited exec stream exposed by another backend.
 *
 * @param {Object} server - HTTP server receiving the upgrade handler.
 * @returns {Object} Attached WebSocket server.
 */
function attachExecStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/exec\/(.+)$/);
    if (!match) return; // not ours — let logStream or others handle it

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
          currentAgent = await findAccessibleAgentForActor(agentId, user, "editor");
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

      if (!agent.container_id) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "No container ID — agent may still be provisioning",
          }),
        );
        ws.close();
        return;
      }

      // Start actor + Remote Docker grant checks before status or terminal
      // attachment. Either operation may block, but workspace removal,
      // demotion, or host-grant revocation must still close the socket.
      let accessTimer = null;
      let accessCheckPromise = null;
      const clearAccessTimer = () => {
        if (accessTimer) {
          clearInterval(accessTimer);
          accessTimer = null;
        }
      };
      const runAccessCheck = () => {
        if (ws.readyState !== 1) return Promise.resolve();
        if (accessCheckPromise) return accessCheckPromise;
        accessCheckPromise = (async () => {
          try {
            await findAuthorizedAgent();
          } catch (error) {
            clearAccessTimer();
            const publicError = publicAuthorizationError(error);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "error", ...publicError }));
              ws.close();
            }
          } finally {
            accessCheckPromise = null;
          }
        })();
        return accessCheckPromise;
      };
      accessTimer = setInterval(() => {
        void runAccessCheck();
      }, ACCESS_RECHECK_MS);
      accessTimer.unref?.();
      ws.on("close", clearAccessTimer);
      ws.on("error", clearAccessTimer);

      // Live status reconciliation — check if container is actually running
      let isRunning = agent.status === "running";
      try {
        const live = await containerManager.status(agent);
        isRunning = live.running;
        if (isRunning && agent.status !== "running") {
          // Never clobber a mid-deployment agent. The provisioner's readiness
          // writes are guarded on status='deploying'; stealing that status makes
          // finalization match zero rows, which the worker reads as "agent
          // deleted" and acts on by destroying the runtime it just built.
          const promoted = await db.query(
            "UPDATE agents SET status = 'running' WHERE id = $1 AND status <> 'deploying' RETURNING id",
            [agent.id],
          );
          // Only mirror the write in memory when a row actually changed, so the
          // in-memory agent cannot diverge from the database.
          if (promoted?.rows?.length) {
            agent.status = "running";
          }
        }
      } catch {
        // trust DB status
      }
      if (ws.readyState !== 1) return;

      if (!isRunning) {
        ws.send(
          JSON.stringify({
            type: "system",
            message: `Agent is ${agent.status} — terminal available when agent is running`,
          }),
        );
        ws.close();
        return;
      }

      // For Docker-backed backends, use direct dockerode for full TTY exec support
      const backendType = resolveAgentBackendType(agent);
      if (backendType === "docker") {
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
        if (ws.readyState !== 1) return;

        const stream = await exec.start({
          hijack: true,
          stdin: true,
          Tty: true,
        });

        const cleanupDockerExec = () => {
          if (typeof stream.end === "function") stream.end();
          if (typeof stream.destroy === "function") stream.destroy();
        };
        ws.on("close", cleanupDockerExec);
        ws.on("error", cleanupDockerExec);
        if (ws.readyState !== 1) {
          cleanupDockerExec();
          return;
        }

        ws.send(
          JSON.stringify({
            type: "system",
            message: `Connected to ${agent.name} (${agent.container_id.slice(0, 12)})`,
          }),
        );

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
      } else {
        // Non-Docker backends — basic shell via containerManager.exec
        ws.send(
          JSON.stringify({
            type: "system",
            message: `Terminal for ${backendType} backend — limited TTY support`,
          }),
        );

        let backendStream = null;
        let backendStdin = null;
        const cleanupBackendExec = () => {
          if (backendStdin && typeof backendStdin.end === "function") {
            backendStdin.end();
          }
          if (backendStream && typeof backendStream.destroy === "function") {
            backendStream.destroy();
          }
        };
        // Register cleanup before awaiting the remote attach. Authorization can
        // be revoked while containerManager.exec() is still establishing SSH;
        // when that late result arrives, the closed socket must not orphan it.
        ws.on("close", cleanupBackendExec);
        ws.on("error", cleanupBackendExec);

        try {
          const execResult = await containerManager.exec(agent);
          backendStream = execResult?.stream || null;
          backendStdin = execResult?.stdin || null;
          if (ws.readyState !== 1) {
            cleanupBackendExec();
            return;
          }
          if (!execResult) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: `Exec not supported for ${backendType} backend`,
              }),
            );
            ws.close();
            return;
          }
          if (!backendStream || typeof backendStream.on !== "function") {
            ws.send(
              JSON.stringify({
                type: "error",
                message: `Exec stream not available for ${backendType} backend`,
              }),
            );
            ws.close();
            return;
          }
          ws.send(
            JSON.stringify({
              type: "system",
              message: `Connected to ${agent.name} via ${backendType}`,
            }),
          );

          let inputUnsupportedNotified = false;

          if (backendStream && typeof backendStream.on === "function") {
            backendStream.on("data", (chunk) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
              }
            });

            backendStream.on("end", () => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "system", message: "Shell session ended" }));
                ws.close();
              }
            });

            backendStream.on("error", (err) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    message: `Terminal stream error: ${err.message}`,
                  }),
                );
                ws.close();
              }
            });
          }

          ws.on("message", (raw) => {
            let msg = null;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              msg = { type: "input", data: raw.toString() };
            }

            if (msg.type === "input" && msg.data) {
              if (backendStdin && typeof backendStdin.write === "function") {
                backendStdin.write(msg.data);
              } else if (!inputUnsupportedNotified && ws.readyState === 1) {
                inputUnsupportedNotified = true;
                ws.send(
                  JSON.stringify({
                    type: "system",
                    message: `Interactive input is not supported for ${backendType} terminal sessions`,
                  }),
                );
              }
            } else if (msg.type === "resize" && msg.cols && msg.rows) {
              const resize = execResult.exec?.resize || execResult.resize;
              if (typeof resize === "function") {
                Promise.resolve(resize({ h: msg.rows, w: msg.cols })).catch(() => {});
              }
            }
          });
        } catch (err) {
          cleanupBackendExec();
          if (ws.readyState === 1) {
            const publicError = isAuthorizationFailure(err)
              ? publicAuthorizationError(err)
              : { message: `Exec failed: ${err.message}` };
            ws.send(JSON.stringify({ type: "error", ...publicError }));
            ws.close();
          }
        }
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "error",
            ...(isAuthorizationFailure(err)
              ? publicAuthorizationError(err)
              : { message: "Terminal error" }),
          }),
        );
        ws.close();
      }
    }
  });

  return wss;
}

module.exports = { attachExecStream };
