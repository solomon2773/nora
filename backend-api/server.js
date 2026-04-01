const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const db = require("./db");
const billing = require("./billing");
const channels = require("./channels");
const marketplace = require("./marketplace");
const integrations = require("./integrations");
const snapshots = require("./snapshots");
const { authenticateToken } = require("./middleware/auth");
const { correlationId, errorHandler } = require("./middleware/errorHandler");
const { createGatewayRouter, attachGatewayWS } = require("./gatewayProxy");

// ─── JWT Secret ───────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: JWT_SECRET must be set in production. Refusing to start with an ephemeral secret.");
    process.exit(1);
  }
  console.warn("SECURITY WARNING: JWT_SECRET not configured. Using ephemeral secret — all tokens will invalidate on restart. Set JWT_SECRET in .env.");
}
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

// ─── App Setup ────────────────────────────────────────────────────
const app = express();

app.set("trust proxy", 1);
app.use(helmet());

const corsOrigins = (process.env.CORS_ORIGINS || "http://localhost:8080").split(",").map(s => s.trim());
app.use(cors({ origin: corsOrigins }));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

// Stripe webhook needs raw body — must come before express.json()
if (billing.BILLING_ENABLED) {
  app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(500).json({ error: "Webhook secret not configured" });
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      await billing.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (e) {
      console.error("Webhook error:", e.message);
      res.status(400).json({ error: e.message });
    }
  });
}

app.use(express.json());
app.use(correlationId);
app.use(require("./middleware/requestMetrics"));

// ─── Public Routes ────────────────────────────────────────────────

let _startupComplete = false;
app.get("/health", (req, res) => {
  if (!_startupComplete) return res.status(503).json({ status: "starting" });
  res.json({ status: "ok" });
});

app.get("/config/platform", (req, res) => {
  res.json({
    mode: billing.PLATFORM_MODE,
    selfhosted: billing.PLATFORM_MODE !== "paas" ? billing.SELFHOSTED_LIMITS : null,
    billingEnabled: billing.BILLING_ENABLED,
  });
});

app.get("/config/nemoclaw", (req, res) => {
  res.json({
    enabled: process.env.NEMOCLAW_ENABLED === "true",
    defaultModel: process.env.NEMOCLAW_DEFAULT_MODEL || "nvidia/nemotron-3-super-120b-a12b",
    sandboxImage: process.env.NEMOCLAW_SANDBOX_IMAGE || "ghcr.io/nvidia/openshell-community/sandboxes/openclaw",
    models: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/nemotron-3-nano-30b-a3b",
    ],
  });
});

app.get("/marketplace", async (req, res) => {
  try {
    res.json(await marketplace.listMarketplace());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inbound webhook receiver (public — external services POST here)
app.post("/webhooks/:channelId", async (req, res) => {
  try {
    await channels.handleInboundWebhook(req.params.channelId, req.body, req.headers);
    res.json({ received: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use("/auth", require("./routes/auth"));

// ─── Gateway UI static assets (before auth wall — JS/CSS/icons contain no user data) ──
// These are served pre-auth because iframes can't set Authorization headers on sub-resource loads.
// Only opaque static files (JS bundles, CSS, favicons) are exempted — not HTML or API endpoints.
const gatewayUIAssetProxy = require("express").Router();
gatewayUIAssetProxy.get("/agents/:agentId/gateway/assets/*", proxyGatewayAsset);
gatewayUIAssetProxy.get("/agents/:agentId/gateway/favicon*", proxyGatewayAsset);
gatewayUIAssetProxy.get("/agents/:agentId/gateway/__openclaw__/*", proxyGatewayAsset);

// ─── Gateway UI Embed (pre-auth — authenticates via ?token= query param) ──────────
// Serves the gateway control UI HTML for iframe embedding. Authenticates via JWT in
// the query string (iframes can't set Authorization headers). Injects a WebSocket
// interceptor so the control UI connects through the backend's relay instead of
// directly to the container port (avoids cross-origin / allowedOrigins issues).
gatewayUIAssetProxy.get("/agents/:agentId/gateway/embed", async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const token = req.query.token;
    if (!token) return res.status(401).send("token required");
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).send("invalid token"); }

    const agentId = req.params.agentId;
    const result = await db.query(
      "SELECT host, gateway_token, gateway_host_port FROM agents WHERE id = $1 AND user_id = $2 AND status IN ('running','warning') AND host IS NOT NULL",
      [agentId, payload.id]
    );
    if (!result.rows[0]) return res.status(404).send("agent not found or not running");

    const gwHost = result.rows[0].gateway_host_port ? (process.env.GATEWAY_HOST || "host.docker.internal") : result.rows[0].host;
    const gwPort = result.rows[0].gateway_host_port || 18789;
    const gatewayToken = result.rows[0].gateway_token;

    // Fetch the gateway root HTML
    let resp;
    try {
      resp = await fetch(`http://${gwHost}:${gwPort}/`, {
        headers: { "Accept": "text/html", "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(10000),
      });
    } catch (fetchErr) {
      return res.status(502).send(`gateway unreachable at ${gwHost}:${gwPort} — ${fetchErr.message}`);
    }
    if (!resp.ok) return res.status(502).send(`gateway returned ${resp.status}`);
    let html = await resp.text();

    // Build the WebSocket relay URL. Must include /api/ prefix because nginx
    // routes /api/ws/* → backend /ws/* (strips the /api prefix).
    const wsProto = req.protocol === "https" ? "wss" : "ws";
    const wsRelayUrl = `${wsProto}://${req.headers.host}/api/ws/gateway/${agentId}?token=${encodeURIComponent(token)}`;

    // Inject a WebSocket interceptor + auto-connect config before </head>.
    // The interceptor redirects all WS connections to the backend relay (which
    // sets Origin: http://localhost:18789 server-side, bypassing origin checks).
    // Also inject the gateway password into the URL hash so the control UI auto-fills it.
    const injectScript = `<script>
(function(){
  var R=${JSON.stringify(wsRelayUrl)};
  var P=${JSON.stringify(gatewayToken)};
  var _WS=window.WebSocket;
  window.WebSocket=function(u,p){return p?new _WS(R,p):new _WS(R)};
  window.WebSocket.prototype=_WS.prototype;
  window.WebSocket.CONNECTING=_WS.CONNECTING;
  window.WebSocket.OPEN=_WS.OPEN;
  window.WebSocket.CLOSING=_WS.CLOSING;
  window.WebSocket.CLOSED=_WS.CLOSED;
  // Override stored WebSocket URL so the gateway UI uses our relay
  try{localStorage.setItem('oc-gateway-url',R);localStorage.setItem('openclaw-ws-url',R);}catch(e){}
  // Set token in URL hash for gateway UI auto-login
  window.location.hash='password='+encodeURIComponent(P);
})();
</script>`;
    html = html.replace(/<head[^>]*>/i, (m) => m + injectScript);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    console.error("[gateway-embed] error:", err);
    if (!res.headersSent) res.status(502).send(`embed proxy error: ${err.message}`);
  }
});

async function proxyGatewayAsset(req, res) {
  try {
    const db = require("./db");
    const agentId = req.params.agentId;
    const result = await db.query(
      "SELECT host, gateway_host_port FROM agents WHERE id = $1 AND status IN ('running','warning') AND host IS NOT NULL",
      [agentId]
    );
    if (!result.rows[0]) return res.status(404).end();
    const gwHost = result.rows[0].gateway_host_port ? (process.env.GATEWAY_HOST || "host.docker.internal") : result.rows[0].host;
    const gwPort = result.rows[0].gateway_host_port || 18789;
    const gatewayPath = req.path.split("/gateway/")[1] || "";
    const targetUrl = `http://${gwHost}:${gwPort}/${gatewayPath}`;
    const resp = await fetch(targetUrl, {
      headers: { "Accept": req.headers.accept || "*/*", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(10000),
    });
    res.status(resp.status);
    const ct = resp.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    const cc = resp.headers.get("cache-control");
    if (cc) res.setHeader("Cache-Control", cc);
    else res.setHeader("Cache-Control", "public, max-age=3600");
    const body = await resp.arrayBuffer();
    res.send(Buffer.from(body));
  } catch {
    res.status(502).end();
  }
}
app.use(gatewayUIAssetProxy);

// ─── Auth Wall ────────────────────────────────────────────────────
app.use(authenticateToken);

// ─── Gateway Proxy ────────────────────────────────────────────────
app.use(createGatewayRouter());

// ─── Protected Routes ─────────────────────────────────────────────
app.use("/agents",        require("./routes/agents"));
app.use("/agents",        require("./routes/channels"));
app.use("/agents",        require("./routes/nemoclaw"));
app.use("/",              require("./routes/integrations"));   // handles /agents/:id/integrations + /integrations/catalog
app.use("/",              require("./routes/monitoring"));     // handles /monitoring/* + /agents/:id/metrics
app.use("/llm-providers", require("./routes/llmProviders"));
app.use("/marketplace",   require("./routes/marketplace"));
app.use("/workspaces",    require("./routes/workspaces"));
app.use("/billing",       require("./routes/billing"));
app.use("/admin",         require("./routes/admin"));

// ─── Central Error Handler ────────────────────────────────────────
app.use(errorHandler);

// ─── DB Migration ─────────────────────────────────────────────────
async function migrateDB() {
  const migrations = [
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN backend_type VARCHAR(20) NOT NULL DEFAULT 'docker';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS integration_catalog (
       id VARCHAR(50) PRIMARY KEY,
       name VARCHAR(100) NOT NULL,
       icon VARCHAR(50),
       category VARCHAR(50) NOT NULL,
       description TEXT,
       auth_type VARCHAR(20),
       config_schema JSONB NOT NULL DEFAULT '{}',
       enabled BOOLEAN DEFAULT true
     )`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN catalog_id VARCHAR(50) REFERENCES integration_catalog(id);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN config JSONB DEFAULT '{}';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN status VARCHAR(20) DEFAULT 'active';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS channels (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       type VARCHAR(30) NOT NULL,
       name VARCHAR(100) NOT NULL,
       config JSONB NOT NULL DEFAULT '{}',
       enabled BOOLEAN DEFAULT true,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS channel_messages (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
       direction VARCHAR(10) NOT NULL,
       content TEXT NOT NULL,
       metadata JSONB DEFAULT '{}',
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN gateway_token TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS llm_providers (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       provider VARCHAR(30) NOT NULL,
       api_key TEXT,
       model VARCHAR(100),
       config JSONB DEFAULT '{}',
       is_default BOOLEAN DEFAULT false,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN sandbox_type VARCHAR(20) DEFAULT 'standard';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN vcpu INTEGER DEFAULT 2; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN ram_mb INTEGER DEFAULT 2048; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN disk_gb INTEGER DEFAULT 20; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS usage_metrics (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       metric_type VARCHAR(50) NOT NULL,
       value NUMERIC NOT NULL DEFAULT 0,
       metadata JSONB DEFAULT '{}',
       recorded_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_agent ON usage_metrics(agent_id, recorded_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_user ON usage_metrics(user_id, recorded_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_type ON usage_metrics(metric_type, recorded_at)`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN avatar TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS container_stats (
       id BIGSERIAL PRIMARY KEY,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       cpu_percent NUMERIC NOT NULL DEFAULT 0,
       memory_usage_mb INTEGER NOT NULL DEFAULT 0,
       memory_limit_mb INTEGER NOT NULL DEFAULT 0,
       memory_percent NUMERIC NOT NULL DEFAULT 0,
       network_rx_mb NUMERIC NOT NULL DEFAULT 0,
       network_tx_mb NUMERIC NOT NULL DEFAULT 0,
       disk_read_mb NUMERIC NOT NULL DEFAULT 0,
       disk_write_mb NUMERIC NOT NULL DEFAULT 0,
       pids INTEGER NOT NULL DEFAULT 0,
       recorded_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_container_stats_agent_time ON container_stats(agent_id, recorded_at DESC)`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN gateway_host_port INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
  ];

  for (const sql of migrations) {
    try {
      await db.query(sql);
    } catch (e) {
      console.error("Migration step failed:", e.message);
    }
  }
  console.log("DB migrations applied");
}

// ─── Startup ──────────────────────────────────────────────────────
if (require.main === module) {
  const { attachLogStream } = require("./logStream");
  const { attachExecStream } = require("./execStream");

  const PORT = parseInt(process.env.PORT || "4000");
  const server = app.listen(PORT, async () => {
    console.log(`api running on ${PORT}`);

    try { await migrateDB(); } catch (e) { console.error("DB migration error:", e.message); }

    // Seed default admin account on first boot
    try {
      const { rows } = await db.query("SELECT id FROM users LIMIT 1");
      if (rows.length === 0) {
        const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || "admin@nora.local";
        const adminPass = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
        const bcrypt = require("bcryptjs");
        const hash = await bcrypt.hash(adminPass, 10);
        await db.query(
          "INSERT INTO users(email, password_hash, role, name) VALUES($1, $2, 'admin', 'Admin') ON CONFLICT DO NOTHING",
          [adminEmail, hash]
        );
        console.log(`Default admin account created: ${adminEmail}`);
        if (adminPass === "admin123") {
          console.warn("WARNING: Using default admin password. Change it immediately in Settings or set DEFAULT_ADMIN_PASSWORD in .env");
        }
      }
    } catch (e) { console.error("Failed to seed admin account:", e.message); }

    try { await integrations.seedCatalog(); } catch (e) { console.error("Failed to seed integration catalog:", e.message); }

    try {
      const existing = await marketplace.listMarketplace();
      if (existing.length === 0) {
        const s1 = await snapshots.createSnapshot(null, "OpenClaw Researcher", "Specialized in deep web research and data synthesis.", { type: "research" });
        const s2 = await snapshots.createSnapshot(null, "OpenClaw Auditor", "Real-time auditing and compliance node.", { type: "audit" });
        const s3 = await snapshots.createSnapshot(null, "OpenClaw Support", "Autonomous customer support agent with tool access.", { type: "support" });
        await marketplace.publishSnapshot(s1.id, s1.name, s1.description, "$12/mo", "Research");
        await marketplace.publishSnapshot(s2.id, s2.name, s2.description, "Free", "Finance");
        await marketplace.publishSnapshot(s3.id, s3.name, s3.description, "$29/mo", "Support");
        console.log("Marketplace seeded with 3 default listings");
      }
    } catch (e) { console.error("Failed to seed marketplace:", e.message); }

    _startupComplete = true;
    console.log("Startup complete — health check now returning ok");

    // ── Background stats collector: sample running containers every 10s ──
    const STATS_INTERVAL = 10000;
    setInterval(async () => {
      try {
        const Docker = require("dockerode");
        const docker = new Docker({ socketPath: "/var/run/docker.sock" });
        const agents = await db.query(
          "SELECT id, container_id FROM agents WHERE status IN ('running','warning') AND container_id IS NOT NULL"
        );
        for (const agent of agents.rows) {
          try {
            const container = docker.getContainer(agent.container_id);
            const stats = await container.stats({ stream: false });
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage || 0);
            const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
            const cpuCount = stats.cpu_stats.online_cpus || 1;
            const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
            const memUsage = stats.memory_stats.usage || 0;
            const memLimit = stats.memory_stats.limit || 0;
            const memCache = stats.memory_stats.stats?.cache || 0;
            const memActual = memUsage - memCache;
            let netRx = 0, netTx = 0;
            if (stats.networks) { for (const i of Object.values(stats.networks)) { netRx += i.rx_bytes || 0; netTx += i.tx_bytes || 0; } }
            let diskR = 0, diskW = 0;
            if (stats.blkio_stats?.io_service_bytes_recursive) {
              for (const e of stats.blkio_stats.io_service_bytes_recursive) {
                if (e.op === "read" || e.op === "Read") diskR += e.value || 0;
                if (e.op === "write" || e.op === "Write") diskW += e.value || 0;
              }
            }
            await db.query(
              `INSERT INTO container_stats(agent_id, cpu_percent, memory_usage_mb, memory_limit_mb, memory_percent, network_rx_mb, network_tx_mb, disk_read_mb, disk_write_mb, pids)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [agent.id, Math.round(cpuPercent*100)/100, Math.round(memActual/1048576), Math.round(memLimit/1048576),
               memLimit>0?Math.round(memActual/memLimit*10000)/100:0, Math.round(netRx/1048576*100)/100, Math.round(netTx/1048576*100)/100,
               Math.round(diskR/1048576*100)/100, Math.round(diskW/1048576*100)/100, stats.pids_stats?.current||0]
            );
          } catch { /* container may have stopped */ }
        }
        // Prune old stats (keep 24h)
        await db.query("DELETE FROM container_stats WHERE recorded_at < NOW() - INTERVAL '24 hours'").catch(() => {});
      } catch { /* docker unavailable */ }
    }, STATS_INTERVAL);

    // ── Background status reconciler: sync DB status with real container state every 30s ──
    const RECONCILE_INTERVAL = 30000;
    setInterval(async () => {
      try {
        const Docker = require("dockerode");
        const docker = new Docker({ socketPath: "/var/run/docker.sock" });
        const agents = await db.query(
          "SELECT id, container_id, status FROM agents WHERE container_id IS NOT NULL AND status IN ('running','warning','stopped','error')"
        );
        for (const agent of agents.rows) {
          try {
            const info = await docker.getContainer(agent.container_id).inspect();
            const liveStatus = info.State?.Running ? "running" : "stopped";
            if (liveStatus !== agent.status && agent.status !== "queued" && agent.status !== "deploying") {
              await db.query("UPDATE agents SET status = $1 WHERE id = $2", [liveStatus, agent.id]);
            }
          } catch (e) {
            // Container removed or unreachable — mark as stopped if it was running
            if (agent.status === "running" || agent.status === "warning") {
              await db.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [agent.id]);
            }
          }
        }
      } catch { /* docker unavailable */ }
    }, RECONCILE_INTERVAL);
  });

  attachLogStream(server);
  attachExecStream(server);
  attachGatewayWS(server);
}

module.exports = app;
