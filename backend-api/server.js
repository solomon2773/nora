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
const { runMigrations } = require("./lib/migrations");

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

app.get("/health", (req, res) => res.json({ status: "ok" }));

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

// ─── Startup ──────────────────────────────────────────────────────
if (require.main === module) {
  const { attachLogStream } = require("./logStream");
  const { attachExecStream } = require("./execStream");

  const PORT = parseInt(process.env.PORT || "4000");
  const server = app.listen(PORT, async () => {
    console.log(`api running on ${PORT}`);

    try { await runMigrations(); } catch (e) { console.error("Migration error:", e.message); }

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
  });

  attachLogStream(server);
  attachExecStream(server);
  attachGatewayWS(server);
}

module.exports = app;
