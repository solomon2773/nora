/**
 * OpenClaw Agent Runtime — HTTP API Server
 *
 * Runs on port 9090 inside every agent container.
 * Provides health checks, exec, log tailing, and integration/channel forwarding.
 */
const http = require("http");
const os = require("os");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const { AGENT_RUNTIME_PORT, OPENCLAW_GATEWAY_PORT } = require("./contracts");

const PORT = parseInt(process.env.AGENT_HTTP_PORT || String(AGENT_RUNTIME_PORT));
const LOG_FILE = "/var/log/openclaw-agent.log";

// Simple JSON body parser
function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const startTime = Date.now();

const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || String(OPENCLAW_GATEWAY_PORT));
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

/**
 * Forward an inbound channel message to the local OpenClaw gateway,
 * collect the full response, and send it back through the channel.
 */
async function forwardToGatewayAndReply(body) {
  const { channelId, channelType, content, sender } = body;
  if (!content || !channelId) return;

  // Send chat message to the OpenClaw gateway's HTTP chat endpoint
  const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat`;
  let responseText = "";

  try {
    const chatRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GATEWAY_TOKEN ? { "Authorization": `Bearer ${GATEWAY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        messages: [{ role: "user", content }],
        stream: false,
      }),
      signal: AbortSignal.timeout(120000), // 2 minute timeout for LLM response
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text();
      throw new Error(`Gateway returned ${chatRes.status}: ${errText}`);
    }

    const chatData = await chatRes.json();
    // OpenAI-compatible response format
    responseText = chatData.choices?.[0]?.message?.content
      || chatData.content
      || chatData.response
      || JSON.stringify(chatData);
  } catch (e) {
    // If gateway HTTP endpoint isn't available, try the exec-based fallback
    try {
      const result = execSync(
        `openclaw chat --message ${JSON.stringify(content)} --no-interactive 2>/dev/null`,
        { encoding: "utf8", timeout: 120000 }
      );
      responseText = result.trim();
    } catch {
      responseText = `[OpenClaw] Unable to process message: ${e.message}`;
    }
  }

  if (!responseText) return;

  // Log the response
  const logLine = `${new Date().toISOString()} [CHANNEL] Response to ${channelType}: ${responseText.slice(0, 200)}`;
  try { fs.appendFileSync(LOG_FILE, logLine + "\n"); } catch { /* ignore */ }

  // Send response back through the channel via backend API
  const apiUrl = process.env.BACKEND_API_URL || "http://backend-api:4000";
  try {
    await fetch(`${apiUrl}/agents/${process.env.AGENT_ID}/channels/${channelId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: responseText,
        metadata: { inReplyTo: sender, channelType },
      }),
    });
  } catch (e) {
    const errLine = `${new Date().toISOString()} [CHANNEL] Failed to send reply: ${e.message}`;
    try { fs.appendFileSync(LOG_FILE, errLine + "\n"); } catch { /* ignore */ }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ── GET /health ───────────────────────────────────────
  if (req.method === "GET" && path === "/health") {
    return json(res, 200, {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pid: process.pid,
      node: process.version,
    });
  }

  // ── GET /info ─────────────────────────────────────────
  if (req.method === "GET" && path === "/info") {
    return json(res, 200, {
      agentId: process.env.AGENT_ID || "unknown",
      agentName: process.env.AGENT_NAME || "unnamed",
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      nodeVersion: process.version,
    });
  }

  // ── GET /logs ─────────────────────────────────────────
  if (req.method === "GET" && path === "/logs") {
    const tail = parseInt(url.searchParams.get("tail") || "100");
    try {
      const output = execSync(`tail -n ${tail} ${LOG_FILE} 2>/dev/null || echo "No logs yet"`, {
        encoding: "utf8",
        timeout: 5000,
      });
      return json(res, 200, { lines: output.trim().split("\n") });
    } catch {
      return json(res, 200, { lines: ["No logs available"] });
    }
  }

  // ── POST /exec ────────────────────────────────────────
  if (req.method === "POST" && path === "/exec") {
    const body = await parseBody(req);
    const cmd = body.command || body.cmd || "echo 'no command'";
    const timeout = body.timeout || 30000;
    try {
      const output = execSync(cmd, {
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
        shell: "/bin/sh",
      });
      return json(res, 200, { exitCode: 0, stdout: output, stderr: "" });
    } catch (e) {
      return json(res, 200, {
        exitCode: e.status || 1,
        stdout: e.stdout || "",
        stderr: e.stderr || e.message,
      });
    }
  }

  // ── GET /integrations ─────────────────────────────────
  if (req.method === "GET" && path === "/integrations") {
    // The runtime stores active integrations in a local config file
    try {
      const data = fs.readFileSync("/opt/openclaw/integrations.json", "utf8");
      return json(res, 200, JSON.parse(data));
    } catch {
      return json(res, 200, []);
    }
  }

  // ── POST /channels/send ───────────────────────────────
  if (req.method === "POST" && path === "/channels/send") {
    const body = await parseBody(req);
    // Forward to the backend API for actual delivery
    const apiUrl = process.env.BACKEND_API_URL || "http://backend-api:4000";
    try {
      const response = await fetch(`${apiUrl}/agents/${process.env.AGENT_ID}/channels/${body.channelId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: body.content, metadata: body.metadata }),
      });
      const result = await response.json();
      return json(res, response.status, result);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /channels/receive ────────────────────────────
  if (req.method === "POST" && path === "/channels/receive") {
    const body = await parseBody(req);
    const line = `${new Date().toISOString()} [CHANNEL] Inbound from ${body.channelType}: ${body.content}`;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }

    // Respond immediately so the webhook caller isn't blocked
    json(res, 200, { received: true });

    // Asynchronously forward to the local OpenClaw gateway and send the response back
    forwardToGatewayAndReply(body).catch((e) => {
      const errLine = `${new Date().toISOString()} [CHANNEL] Gateway forward error: ${e.message}`;
      try { fs.appendFileSync(LOG_FILE, errLine + "\n"); } catch { /* ignore */ }
    });
    return;
  }

  // ── POST /integrations/sync ───────────────────────────
  if (req.method === "POST" && path === "/integrations/sync") {
    const body = await parseBody(req);
    try {
      fs.mkdirSync("/opt/openclaw", { recursive: true });
      fs.writeFileSync("/opt/openclaw/integrations.json", JSON.stringify(body.integrations || [], null, 2));
      return json(res, 200, { synced: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── NemoClaw Sandbox Endpoints ────────────────────────

  // GET /nemoclaw/status — sandbox health, model, policy state
  if (req.method === "GET" && path === "/nemoclaw/status") {
    try {
      const policyPath = "/opt/openclaw/policy.yaml";
      let policy = null;
      try { policy = JSON.parse(fs.readFileSync(policyPath, "utf-8")); } catch { /* no policy file */ }

      const model = process.env.NEMOCLAW_MODEL || "unknown";
      const hasNvidia = !!process.env.NVIDIA_API_KEY;

      return json(res, 200, {
        sandbox: "nemoclaw",
        model,
        inferenceConfigured: hasNvidia,
        policyActive: !!policy,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        pid: process.pid,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /nemoclaw/policy — current network/filesystem/inference policy
  if (req.method === "GET" && path === "/nemoclaw/policy") {
    try {
      const policyPath = "/opt/openclaw/policy.yaml";
      const raw = fs.readFileSync(policyPath, "utf-8");
      return json(res, 200, JSON.parse(raw));
    } catch (e) {
      return json(res, 404, { error: "No policy file found", detail: e.message });
    }
  }

  // POST /nemoclaw/policy — update policy (hot-reload)
  if (req.method === "POST" && path === "/nemoclaw/policy") {
    const body = await parseBody(req);
    try {
      fs.mkdirSync("/opt/openclaw", { recursive: true });
      fs.writeFileSync("/opt/openclaw/policy.yaml", JSON.stringify(body, null, 2));

      // Attempt hot-reload via openshell CLI if available
      try {
        execSync("openshell policy set /opt/openclaw/policy.yaml", { timeout: 5000, stdio: "ignore" });
      } catch {
        // openshell CLI may not be present in all sandbox images — policy file is still updated
      }

      return json(res, 200, { updated: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /nemoclaw/approvals — pending network egress approval requests
  if (req.method === "GET" && path === "/nemoclaw/approvals") {
    try {
      const approvalsPath = "/opt/openclaw/pending-approvals.json";
      let approvals = [];
      try { approvals = JSON.parse(fs.readFileSync(approvalsPath, "utf-8")); } catch { /* no pending */ }
      return json(res, 200, { approvals });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // POST /nemoclaw/approvals/:rid — approve or deny a pending request
  if (req.method === "POST" && path.startsWith("/nemoclaw/approvals/")) {
    const rid = path.split("/").pop();
    const body = await parseBody(req);
    try {
      const approvalsPath = "/opt/openclaw/pending-approvals.json";
      let approvals = [];
      try { approvals = JSON.parse(fs.readFileSync(approvalsPath, "utf-8")); } catch { /* empty */ }

      const idx = approvals.findIndex((a) => a.id === rid);
      if (idx === -1) return json(res, 404, { error: "Approval request not found" });

      const decision = body.action === "approve" ? "approved" : "denied";
      approvals[idx].status = decision;
      approvals[idx].decidedAt = new Date().toISOString();

      // If approved, add endpoint to live policy
      if (decision === "approved") {
        try {
          const policyPath = "/opt/openclaw/policy.yaml";
          const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
          const endpoint = approvals[idx].endpoint;
          if (endpoint && policy.network?.rules) {
            policy.network.rules.push({
              name: `approved_${rid.slice(0, 8)}`,
              endpoints: [endpoint],
              methods: ["*"],
              approved: true,
            });
            fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
            try { execSync("openshell policy set /opt/openclaw/policy.yaml", { timeout: 5000, stdio: "ignore" }); } catch { /* best effort */ }
          }
        } catch { /* policy update best-effort */ }
      }

      // Remove decided entries, keep only pending
      const remaining = approvals.filter((a) => !a.status || a.status === "pending");
      fs.writeFileSync(approvalsPath, JSON.stringify(remaining, null, 2));

      return json(res, 200, { rid, decision });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── 404 ───────────────────────────────────────────────
  json(res, 404, { error: "Not found" });
});

function startServer() {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[openclaw-runtime] HTTP server listening on port ${PORT}`);
  });
}

module.exports = { startServer, server };
