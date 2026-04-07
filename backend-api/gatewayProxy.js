// backend-api/gatewayProxy.js — WebSocket-RPC proxy between platform and OpenClaw Gateway
// The Gateway exposes a WebSocket-RPC protocol (not HTTP REST).
// This module maintains a connection pool, translates HTTP routes to WS-RPC calls,
// and relays WebSocket connections for streaming chat.
const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("./db");

const metrics = require("./metrics");
const { OPENCLAW_GATEWAY_PORT } = require("../agent-runtime/lib/contracts");
const {
  resolveGatewayAddress,
  hasGatewayEndpoint,
} = require("../agent-runtime/lib/agentEndpoints");
const GATEWAY_PORT = OPENCLAW_GATEWAY_PORT;
const CONNECT_TIMEOUT = 8000;
const CALL_TIMEOUT = 30000;
const CHAT_TIMEOUT = 120000;

// ─── Device Identity (Ed25519 keypair for Gateway auth) ──────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function deriveDeviceIdentity(gatewayToken) {
  const seed = crypto.createHash("sha256").update("openclaw-device:" + gatewayToken).digest();
  const privateDer = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length);
  const deviceId = crypto.createHash("sha256").update(raw).digest("hex");
  const publicKeyB64 = base64UrlEncode(raw);
  return { deviceId, privateKeyPem, publicKeyB64 };
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function buildConnectDevice(identity, role, scopes, nonce) {
  const signedAtMs = Date.now();
  const payload = [
    "v3", identity.deviceId, "gateway-client", "backend",
    role, scopes.join(","), String(signedAtMs),
    "", nonce, process.platform, ""
  ].join("|");
  const signature = signDevicePayload(identity.privateKeyPem, payload);
  return {
    device: { id: identity.deviceId, publicKey: identity.publicKeyB64, signature, signedAt: signedAtMs, nonce },
    scopes
  };
}

// ─── WS-RPC Connection Pool ─────────────────────────────────────

class GatewayConnection {
  constructor(host, token, port) {
    this.host = host;
    this.token = token;
    this.port = port || GATEWAY_PORT;
    this.ws = null;
    this.connected = false;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.eventListeners = new Map(); // event -> Set<callback>
    this._reqId = 0;
    this._connectPromise = null;
    this._identity = deriveDeviceIdentity(token);

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 8;
    this._baseDelay = 1000; // 1s base, doubles each attempt (max ~2 min)

    // Circuit breaker state
    this._circuitState = 'closed'; // closed | open | half-open
    this._circuitOpenedAt = 0;
    this._circuitCooldown = 30000; // 30s before half-open probe
    this._consecutiveFailures = 0;
    this._circuitThreshold = 3; // failures before opening circuit
  }

  /** Open WS, complete challenge-response handshake, resolve when ready. */
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error("Gateway connect timeout"));
      }, CONNECT_TIMEOUT);

      this.ws = new WebSocket(`ws://${this.host}:${this.port}`);

      this.ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Phase 1: Challenge → send connect frame with password + device identity.
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const nonce = msg.payload?.nonce || "";
          const role = "operator";
          const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
          const { device } = buildConnectDevice(this._identity, role, scopes, nonce);
          this.ws.send(JSON.stringify({
            type: "req", id: "__connect__", method: "connect",
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
              role, scopes,
              caps: ["thinking-events"], commands: [],
              auth: this.token ? { password: this.token } : {},
              device
            }
          }));
          return;
        }

        // Phase 2: Connect response
        if (msg.id === "__connect__") {
          clearTimeout(timer);
          if (msg.ok) {
            this.connected = true;
            resolve(this);
          } else {
            reject(new Error(`Gateway handshake failed: ${msg.error?.message || "unknown"}`));
          }
          return;
        }

        // Dispatch pending RPC responses
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, timer: t } = this.pending.get(msg.id);
          clearTimeout(t);
          this.pending.delete(msg.id);
          res(msg);
          return;
        }

        // Dispatch events
        if (msg.type === "event" && msg.event) {
          const cbs = this.eventListeners.get(msg.event);
          if (cbs) cbs.forEach(cb => cb(msg));
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timer);
        this.connected = false;
        this._connectPromise = null;
        reject(err);
      });

      this.ws.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._connectPromise = null;
        // Reject all pending
        for (const [id, { reject: rej, timer: t }] of this.pending) {
          clearTimeout(t);
          rej(new Error("Gateway connection closed"));
        }
        this.pending.clear();
        // Attempt background reconnect if we were previously connected
        if (wasConnected) {
          this._scheduleBackgroundReconnect();
        }
      });
    });
    return this._connectPromise;
  }

  /** Send an RPC call and await the response. */
  call(method, params = {}, timeout = CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
        return reject(new Error("Not connected"));
      }
      const id = `r${++this._reqId}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** Subscribe to gateway events. */
  on(event, callback) {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event).add(callback);
  }

  off(event, callback) {
    this.eventListeners.get(event)?.delete(callback);
  }

  /** Attempt reconnection with exponential backoff, respecting circuit breaker. */
  async reconnect() {
    if (this._circuitState === 'open') {
      if (Date.now() - this._circuitOpenedAt < this._circuitCooldown) {
        throw new Error('Circuit breaker open — gateway temporarily unavailable');
      }
      this._circuitState = 'half-open';
    }

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._openCircuit();
      throw new Error(`Max reconnect attempts (${this._maxReconnectAttempts}) exceeded`);
    }

    this.close();
    const delay = Math.min(this._baseDelay * Math.pow(2, this._reconnectAttempts), 120000);
    console.log(`[gatewayProxy] Reconnecting to ${this.host}:${this.port} in ${delay}ms (attempt ${this._reconnectAttempts + 1}/${this._maxReconnectAttempts})`);
    await new Promise(r => setTimeout(r, delay));
    this._reconnectAttempts++;

    try {
      await this.connect();
      this._reconnectAttempts = 0;
      this._consecutiveFailures = 0;
      this._circuitState = 'closed';
    } catch (err) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= this._circuitThreshold) {
        this._openCircuit();
      }
      throw err;
    }
  }

  _openCircuit() {
    this._circuitState = 'open';
    this._circuitOpenedAt = Date.now();
    console.warn(`[gatewayProxy] Circuit breaker OPEN for ${this.host} — cooling down ${this._circuitCooldown / 1000}s`);
  }

  /** Schedule a background reconnect attempt (non-blocking). */
  _scheduleBackgroundReconnect() {
    if (this._backgroundReconnecting) return;
    this._backgroundReconnecting = true;
    this.reconnect()
      .then(() => console.log(`[gatewayProxy] Background reconnect succeeded for ${this.host}`))
      .catch(() => {}) // silently fail — next getConnection() call will retry
      .finally(() => { this._backgroundReconnecting = false; });
  }

  close() {
    this.connected = false;
    this._connectPromise = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  get isAlive() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  get circuitState() {
    return this._circuitState;
  }
}

// Simple connection pool: one connection per resolved gateway address
const pool = new Map(); // host:port -> GatewayConnection

async function getConnection(agent) {
  const addr = resolveGatewayAddress(agent);
  if (!addr) throw new Error("Agent gateway not yet provisioned");
  const key = `${addr.host}:${addr.port}`;
  let conn = pool.get(key);
  if (conn?.isAlive) return conn;

  // Check circuit breaker — if cooldown elapsed, reset fully and retry
  if (conn?.circuitState === 'open') {
    if (Date.now() - conn._circuitOpenedAt < conn._circuitCooldown) {
      throw new Error('Circuit breaker open — gateway temporarily unavailable');
    }
    // Cooldown expired — clean up and start fresh
    conn.close();
    pool.delete(key);
    conn = null;
  }

  // Clean up dead connection
  if (conn) { conn.close(); pool.delete(key); }

  conn = new GatewayConnection(addr.host, agent.gateway_token, addr.port);
  pool.set(key, conn);
  try {
    await conn.connect();
  } catch (err) {
    // First connect failed — try one reconnect with backoff
    try {
      await conn.reconnect();
    } catch {
      pool.delete(key);
      throw err;
    }
  }
  return conn;
}

// ─── Helpers ─────────────────────────────────────────────────────

async function resolveAgent(agentId, userId) {
  const result = await db.query(
    `SELECT id, name, status, container_id, host, backend_type, gateway_token,
            gateway_host_port, gateway_host, gateway_port, runtime_host,
            runtime_port, user_id
       FROM agents WHERE id = $1`,
    [agentId]
  );
  const agent = result.rows[0];
  if (!agent || agent.user_id !== userId) return null;
  return agent;
}

/** Make an RPC call to an agent's gateway, return the result or throw. */
async function rpcCall(agent, method, params = {}, timeout) {
  const conn = await getConnection(agent);
  const msg = await conn.call(method, params, timeout);
  if (msg.ok === false) {
    const err = new Error(msg.error?.message || "RPC error");
    err.code = msg.error?.code || "GATEWAY_ERROR";
    throw err;
  }
  return msg.result !== undefined ? msg.result : msg.payload || {};
}

// ─── HTTP Routes ─────────────────────────────────────────────────

function createGatewayRouter() {
  const router = require("express").Router();

  // Middleware: resolve agent + verify ownership
  // Allow both 'running' and 'warning' statuses — 'warning' means the post-deploy
  // health check was inconclusive (e.g. npm install was slow), but the gateway may
  // still be reachable. Blocking 'warning' agents would break all tabs even when the
  // gateway eventually starts successfully.
  router.use("/agents/:agentId/gateway", async (req, res, next) => {
    try {
      const agent = await resolveAgent(req.params.agentId, req.user.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      if (agent.status !== "running" && agent.status !== "warning") {
        return res.status(409).json({ error: `Agent is ${agent.status}, not running` });
      }
      if (!hasGatewayEndpoint(agent)) {
        return res.status(409).json({ error: "Agent gateway not yet provisioned" });
      }
      req.agent = agent;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Gateway Status (combines health + status) ──
  router.get("/agents/:agentId/gateway/status", async (req, res) => {
    try {
      const [health, status] = await Promise.all([
        rpcCall(req.agent, "health").catch(() => null),
        rpcCall(req.agent, "status").catch(() => null),
      ]);
      // If we got a successful health response and the agent is in 'warning' state,
      // auto-promote to 'running' — the gateway proved itself healthy.
      if (health && req.agent.status === "warning") {
        db.query("UPDATE agents SET status = 'running' WHERE id = $1", [req.agent.id]).catch(() => {});
      }
      res.json({ health, status });
    } catch (err) {
      res.status(502).json({ error: "Gateway unreachable", details: err.message });
    }
  });

  // ── Chat (send message via WebSocket RPC) ──
  router.post("/agents/:agentId/gateway/chat", async (req, res) => {
    try {
      const conn = await getConnection(req.agent);
      const { message, messages, session_id, stream } = req.body;
      const idempotencyKey = crypto.randomUUID();

      // Build the text payload: accept either a single `message` string
      // or an array of `messages` (OpenAI-style) and extract the last user turn.
      let text = "";
      if (message) {
        text = message;
      } else if (Array.isArray(messages) && messages.length > 0) {
        const last = messages[messages.length - 1];
        text = typeof last === "string" ? last : last.content || "";
      }

      const params = {
        sessionKey: session_id || "main",
        idempotencyKey,
        message: text,
      };

      if (stream) {
        // SSE streaming: listen for chat events, forward as SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // chat.send is NON-BLOCKING — it returns immediately with { runId, status: "started" }.
        // The actual response streams via "chat" events (state: "delta", "final", "error").
        // We must keep listening for events AFTER the RPC resolves.

        let streamDone = false;
        let sawAssistantContent = false;
        const streamHandler = (evt) => {
          const payload = evt.payload || evt;
          const state = payload.state;
          const role = payload.message?.role;

          // Forward every event to the client as SSE
          res.write(`data: ${JSON.stringify(payload)}\n\n`);

          // Track when assistant content starts streaming
          if (role === "assistant" || (!role && state === "delta" && sawAssistantContent)) {
            sawAssistantContent = true;
          }

          // Only mark done on the ASSISTANT's final/error — not the user message echo.
          // The gateway sends a "final" for the user message before the assistant starts.
          if (state === "final" || state === "error" || state === "aborted") {
            if (role !== "user" && role !== "human" && sawAssistantContent) {
              streamDone = true;
            }
          }
        };

        conn.on("chat", streamHandler);
        conn.on("agent", streamHandler);

        // Send the message — resolves immediately with { runId, status: "started" }
        let runId = null;
        try {
          const result = await conn.call("chat.send", params, CALL_TIMEOUT);
          runId = result.result?.runId || result.payload?.runId;
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
          conn.off("chat", streamHandler);
          conn.off("agent", streamHandler);
          res.write("data: [DONE]\n\n");
          res.end();
          metrics.recordMetric(req.agent.id, req.user.id, 'error', 1, { error: err.message }).catch(() => {});
          return;
        }

        // Wait for the stream to complete (chat:final / chat:error / timeout)
        const streamTimeout = CHAT_TIMEOUT;
        const startTime = Date.now();
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (streamDone || Date.now() - startTime > streamTimeout) {
              clearInterval(check);
              resolve();
            }
          }, 200);
          // Also resolve if the client disconnects
          req.on("close", () => { clearInterval(check); resolve(); });
        });

        conn.off("chat", streamHandler);
        conn.off("agent", streamHandler);

        // Record metrics
        metrics.recordMetric(req.agent.id, req.user.id, 'messages_sent', 1).catch(() => {});

        res.write(`data: ${JSON.stringify({ type: "done", runId })}\n\n`);
        res.write("data: [DONE]\n\n");
        if (!res.writableEnded) res.end();
      } else {
        // Non-streaming: wait for final response
        const result = await rpcCall(req.agent, "chat.send", params, CHAT_TIMEOUT);
        // Record metrics
        metrics.recordMetric(req.agent.id, req.user.id, 'messages_sent', 1).catch(() => {});
        const tokens = result?.usage?.total_tokens;
        if (tokens) metrics.recordMetric(req.agent.id, req.user.id, 'tokens_used', tokens).catch(() => {});
        res.json(result);
      }
    } catch (err) {
      if (!res.headersSent) {
        if (req.agent?.id && req.user?.id) {
          metrics.recordMetric(req.agent.id, req.user.id, 'error', 1, { error: err.message }).catch(() => {});
        }
        res.status(502).json({ error: "Chat failed", details: err.message });
      }
    }
  });

  // ── Sessions ──
  router.get("/agents/:agentId/gateway/sessions", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "sessions.list");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/agents/:agentId/gateway/sessions/:sessionKey", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "sessions.get", { key: req.params.sessionKey });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.delete("/agents/:agentId/gateway/sessions/:sessionKey", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "sessions.delete", { key: req.params.sessionKey });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Sessions are created implicitly by sending a chat.send with a new sessionKey.
  // This endpoint generates a key and returns it so the UI can start using it.
  router.post("/agents/:agentId/gateway/sessions", async (req, res) => {
    try {
      const { name } = req.body;
      const key = name || `session-${crypto.randomUUID().slice(0, 8)}`;
      res.json({ key, created: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Cron ──
  router.get("/agents/:agentId/gateway/cron", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "cron.list");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/agents/:agentId/gateway/cron/status", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "cron.status");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.post("/agents/:agentId/gateway/cron", async (req, res) => {
    try {
      const { name, schedule, message, agentId: targetAgent } = req.body;
      // The cron.add RPC expects schedule as an object, not a plain string.
      // The anyOf schema accepts { cron: "expression" } or { interval: seconds }.
      const scheduleObj = typeof schedule === "string"
        ? { cron: schedule }
        : schedule;
      const result = await rpcCall(req.agent, "cron.add", {
        name,
        schedule: scheduleObj,
        sessionTarget: "new",
        payload: { message: message || "" },
        agentId: targetAgent || "main",
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.delete("/agents/:agentId/gateway/cron/:cronId", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "cron.remove", { id: req.params.cronId });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Tools ──
  router.get("/agents/:agentId/gateway/tools", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "tools.catalog");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Models ──
  router.get("/agents/:agentId/gateway/models", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "models.list");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Config ──
  router.get("/agents/:agentId/gateway/config", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "config.get");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Generic RPC call (for advanced use) ──
  router.post("/agents/:agentId/gateway/rpc", async (req, res) => {
    try {
      const { method, params } = req.body;
      if (!method) return res.status(400).json({ error: "method required" });
      const result = await rpcCall(req.agent, method, params || {});
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Gateway UI Proxy ──
  // Proxies the OpenClaw gateway's built-in control UI for iframe embedding.
  // The UI HTML uses relative paths (./assets/*, ./favicon.*), so we proxy:
  //   /agents/:id/gateway/ui       → gateway root (HTML)
  //   /agents/:id/gateway/assets/* → gateway /assets/* (JS, CSS)
  //   /agents/:id/gateway/favicon* → gateway /favicon* (icons)
  //   /agents/:id/gateway/__openclaw__/* → gateway internal paths
  router.get("/agents/:agentId/gateway/ui", proxyGatewayPath(""));
  router.get("/agents/:agentId/gateway/ui/*", proxyGatewayPath("ui/"));
  router.get("/agents/:agentId/gateway/assets/*", proxyGatewayPath("assets/"));
  router.get("/agents/:agentId/gateway/favicon*", proxyGatewayFavicon);
  router.get("/agents/:agentId/gateway/__openclaw__/*", proxyGatewayPath("__openclaw__/"));
  router.post("/agents/:agentId/gateway/__openclaw__/*", proxyGatewayPath("__openclaw__/"));

  function proxyGatewayPath(prefix) {
    return async (req, res) => {
      try {
        const subPath = req.params[0] || "";
        const gatewayPath = prefix + subPath;
        const addr = resolveGatewayAddress(req.agent);
        const targetUrl = `http://${addr.host}:${addr.port}/${gatewayPath}${req._parsedUrl?.search || ""}`;

        const resp = await fetch(targetUrl, {
          method: req.method,
          headers: { "Accept": req.headers.accept || "*/*", "Accept-Encoding": "identity" },
          signal: AbortSignal.timeout(15000),
        });

        res.status(resp.status);
        const ct = resp.headers.get("content-type");
        if (ct) res.setHeader("Content-Type", ct);
        const cc = resp.headers.get("cache-control");
        if (cc) res.setHeader("Cache-Control", cc);

        const body = await resp.arrayBuffer();
        res.send(Buffer.from(body));
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: "Gateway UI unreachable", details: err.message });
        }
      }
    };
  }

  async function proxyGatewayFavicon(req, res) {
    try {
      const fullPath = req.path.split("/gateway/")[1] || "favicon.svg";
      const addr = resolveGatewayAddress(req.agent);
      const targetUrl = `http://${addr.host}:${addr.port}/${fullPath}`;
      const resp = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
      res.status(resp.status);
      const ct = resp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const body = await resp.arrayBuffer();
      res.send(Buffer.from(body));
    } catch {
      res.status(404).end();
    }
  }

  return router;
}

// ─── WebSocket Relay ─────────────────────────────────────────────
// Clients connect to: ws://<host>/ws/gateway/<agentId>?token=<jwt>
// The server performs the Gateway handshake, then relays bidirectionally.

function attachGatewayWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/gateway\/([a-zA-Z0-9_-]+)$/);
    if (!match) return; // not ours — let other handlers process

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
      const agent = await resolveAgent(agentId, user.id);
      if (!agent) {
        ws.send(JSON.stringify({ type: "error", message: "Agent not found" }));
        ws.close(); return;
      }
      if ((agent.status !== "running" && agent.status !== "warning") || !hasGatewayEndpoint(agent)) {
        ws.send(JSON.stringify({ type: "error", message: `Agent is ${agent.status}` }));
        ws.close(); return;
      }

      const identity = deriveDeviceIdentity(agent.gateway_token);
      let handshakeComplete = false;
      let connectResult = null; // stored relay handshake result
      let pendingClientConnect = null; // client's connect msg awaiting relay handshake
      const clientQueue = []; // buffer client messages until handshake is done

      const addr = resolveGatewayAddress(agent);
      const gwWs = new WebSocket(`ws://${addr.host}:${addr.port}`, {
        headers: { "Origin": `http://localhost:${addr.port}` }
      });

      gwWs.on("message", (raw) => {
        const str = raw.toString();
        if (!handshakeComplete) {
          let msg;
          try { msg = JSON.parse(str); } catch { return; }

          if (msg.type === "event" && msg.event === "connect.challenge") {
            // Forward challenge to client so its UI can go through the normal auth flow
            if (ws.readyState === WebSocket.OPEN) ws.send(str);
            // Complete handshake on relay side with password + device identity
            const nonce = msg.payload?.nonce || "";
            const role = "operator";
            const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
            const { device } = buildConnectDevice(identity, role, scopes, nonce);
            gwWs.send(JSON.stringify({
              type: "req", id: "__relay_connect__", method: "connect",
              params: {
                minProtocol: 3, maxProtocol: 3,
                client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
                role, scopes,
                caps: ["thinking-events"], commands: [],
                auth: agent.gateway_token ? { password: agent.gateway_token } : {},
                device
              }
            }));
            return;
          }

          if (msg.id === "__relay_connect__") {
            if (msg.ok) {
              handshakeComplete = true;
              connectResult = msg.result || {};
              // If client already sent connect while we were handshaking, respond now
              if (pendingClientConnect) {
                ws.send(JSON.stringify({ id: pendingClientConnect.id, ok: true, result: connectResult }));
                pendingClientConnect = null;
              }
              // Flush any buffered non-connect client messages
              for (const queued of clientQueue) {
                if (gwWs.readyState === WebSocket.OPEN) gwWs.send(queued);
              }
              clientQueue.length = 0;
            } else {
              console.error(`[gatewayProxy] WS relay handshake failed for ${agentId}:`, msg.error);
              ws.send(JSON.stringify({ type: "error", message: `Gateway handshake failed: ${msg.error?.message || "unknown"}` }));
              ws.close();
              gwWs.close();
            }
            return;
          }
        }
        // Post-handshake: relay gateway → client
        if (ws.readyState === WebSocket.OPEN) ws.send(str);
      });

      ws.on("message", (data) => {
        const str = data.toString();
        try {
          const msg = JSON.parse(str);
          if (msg.method === "connect") {
            // Relay already authenticated (or is authenticating) — don't forward to gateway.
            // Respond with the relay's stored result so the client UI completes its auth flow.
            if (handshakeComplete && connectResult) {
              ws.send(JSON.stringify({ id: msg.id, ok: true, result: connectResult }));
            } else {
              // Relay still handshaking — respond when ready
              pendingClientConnect = msg;
            }
            return;
          }
        } catch { /* not JSON */ }
        if (!handshakeComplete) {
          clientQueue.push(str);
          return;
        }
        if (gwWs.readyState === WebSocket.OPEN) gwWs.send(str);
      });

      gwWs.on("close", (code, reason) => {
        const reasonStr = reason ? reason.toString() : "";
        console.error(`[gatewayProxy] WS relay gateway closed for ${agentId}: code=${code} reason=${reasonStr}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "system", message: `Gateway closed (${code}${reasonStr ? ": " + reasonStr : ""})` }));
          ws.close();
        }
      });
      gwWs.on("error", (err) => {
        console.error(`[gatewayProxy] WS relay error for agent ${agentId}:`, err.message);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      ws.on("close", () => {
        if (gwWs.readyState === WebSocket.OPEN || gwWs.readyState === WebSocket.CONNECTING) gwWs.close();
      });

    } catch (err) {
      console.error(`[gatewayProxy] WS error:`, err.message);
      ws.send(JSON.stringify({ type: "error", message: err.message }));
      ws.close();
    }
  });

  return wss;
}

/** Evict a cached gateway connection so the next request creates a fresh one.
 *  Called after authSync restarts an agent container. */
function evictConnection(target) {
  const address = typeof target === "string" ? { host: target } : resolveGatewayAddress(target || {});
  if (!address?.host) return;

  const keyPrefix = `${address.host}:`;
  for (const [key, conn] of pool) {
    if (key === address.host || key === `${address.host}:${address.port}` || key.startsWith(keyPrefix)) {
      conn.close();
      pool.delete(key);
      console.log(`[gatewayProxy] Evicted connection for ${key}`);
    }
  }
}

module.exports = { createGatewayRouter, attachGatewayWS, rpcCall, resolveAgent, evictConnection };
