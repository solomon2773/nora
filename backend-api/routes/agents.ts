// @ts-nocheck
const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const {
  clampDeploymentDefaults,
  getDeploymentDefaults,
  normalizeDeploymentDefaults,
} = require("../platformSettings");
const scheduler = require("../scheduler");
const containerManager = require("../containerManager");
const monitoring = require("../monitoring");
const {
  CLONE_MODES,
  buildTemplatePayloadFromAgent,
  createEmptyTemplatePayload,
  ensureCoreTemplateFiles,
  materializeTemplateWiring,
  resolveContainerName,
  sanitizeAgentName,
  serializeAgent,
} = require("../agentPayloads");
const {
  attachDraftToAgent,
  getOwnedMigrationDraft,
  materializeManagedMigrationState,
} = require("../agentMigrations");
const { isGatewayAvailableStatus, reconcileAgentStatus } = require("../agentStatus");
const { OPENCLAW_GATEWAY_PORT } = require("../../agent-runtime/lib/contracts");
const {
  resolveGatewayAddress,
  resolveHermesDashboardAddress,
  resolveRuntimeAddress,
  dashboardUrlForAgent,
  runtimeUrlForAgent,
} = require("../../agent-runtime/lib/agentEndpoints");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");
const {
  DEFAULT_RUNTIME_FAMILY,
  KNOWN_RUNTIME_FAMILIES,
  buildBackendEnablementMessage,
  getBackendStatus,
  isKnownRuntimeFamily,
  normalizeRuntimeFamilyName,
} = require("../../agent-runtime/lib/backendCatalog");
const { asyncHandler } = require("../middleware/errorHandler");
const { buildAgentHistoryResponse, buildAgentStatsResponse } = require("../agentTelemetry");
const {
  buildAgentRuntimeFields,
  isSameRuntimePath,
  resolveAgentBackendType,
  resolveRequestedRuntimeFields,
} = require("../agentRuntimeFields");
const {
  buildAgentContext,
  buildAuditMetadata,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");
const {
  deleteHermesChannel,
  listHermesChannels,
  readHermesRuntimeSnapshot,
  saveHermesChannel,
  testHermesChannel,
} = require("../hermesUi");
const { runContainerCommand, syncAuthToUserAgents } = require("../authSync");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("agent"));

function resolveRequestedImage({
  requestedImage,
  runtimeFields = null,
  fallbackImage = null,
  fallbackRuntimeFields = null,
} = {}) {
  const explicitRequestedImage = typeof requestedImage === "string" ? requestedImage.trim() : "";
  if (explicitRequestedImage) return explicitRequestedImage;

  if (
    fallbackImage &&
    fallbackRuntimeFields &&
    isSameRuntimePath(runtimeFields, fallbackRuntimeFields)
  ) {
    return fallbackImage;
  }

  return getDefaultAgentImage({
    backend: runtimeFields?.backend_type,
    deploy_target: runtimeFields?.deploy_target,
    sandbox_profile: runtimeFields?.sandbox_profile,
  });
}

function normalizeRequestedRuntimeFamily(value) {
  if (!isKnownRuntimeFamily(value)) return null;
  return normalizeRuntimeFamilyName(value);
}

function assertSupportedRuntimeSelection(runtimeFields) {
  if (runtimeFields?.runtime_family === "hermes") {
    if (runtimeFields.deploy_target !== "docker") {
      const error = new Error("Hermes runtime is only supported on the Docker execution target.");
      error.statusCode = 400;
      throw error;
    }
    if (runtimeFields.sandbox_profile !== "standard") {
      const error = new Error(
        "Hermes runtime currently supports only the Standard sandbox profile.",
      );
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  if (runtimeFields?.sandbox_profile !== "nemoclaw") return;

  if (runtimeFields.deploy_target !== "docker") {
    const error = new Error("NemoClaw sandbox is only supported on the Docker execution target.");
    error.statusCode = 400;
    throw error;
  }
}

function normalizeGatewayHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`http://${raw}`);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function resolvePublishedGatewayHost(req) {
  const configuredHost = normalizeGatewayHost(process.env.GATEWAY_HOST);
  if (configuredHost) return configuredHost;

  const nextAuthHost = normalizeGatewayHost(process.env.NEXTAUTH_URL);
  if (nextAuthHost) return nextAuthHost;

  const forwardedHostHeader = req.headers["x-forwarded-host"];
  const forwardedHost = Array.isArray(forwardedHostHeader)
    ? forwardedHostHeader[0]
    : String(forwardedHostHeader || "").split(",")[0];
  const normalizedForwardedHost = normalizeGatewayHost(forwardedHost);
  if (normalizedForwardedHost) return normalizedForwardedHost;

  return normalizeGatewayHost(req.get("host")) || "localhost";
}

function resolvePublishedGatewayProtocol(req) {
  const nextAuthUrl = String(process.env.NEXTAUTH_URL || "").trim();
  if (nextAuthUrl) {
    try {
      const parsed = new URL(nextAuthUrl);
      return parsed.protocol === "https:" ? "https" : "http";
    } catch {
      // Fall through to request headers.
    }
  }

  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : String(forwardedProtoHeader || "").split(",")[0];
  if (forwardedProto && forwardedProto.trim()) {
    return forwardedProto.trim() === "https" ? "https" : "http";
  }

  return req.protocol === "https" ? "https" : "http";
}

function assertBackendAvailable(backend) {
  const status = getBackendStatus(backend);
  if (!status.enabled) {
    const error = new Error(buildBackendEnablementMessage(status));
    error.statusCode = 400;
    throw error;
  }
  if (!status.configured) {
    const error = new Error(
      status.issue || `${status.label} is not configured for this Nora control plane.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return status;
}

function normalizeClawhubSkillEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const installSlug =
    typeof entry.installSlug === "string"
      ? entry.installSlug.trim()
      : typeof entry.slug === "string"
        ? entry.slug.trim()
        : "";
  if (!installSlug) return null;

  const author = typeof entry.author === "string" ? entry.author.trim() : "";
  const pagePath =
    typeof entry.pagePath === "string" && entry.pagePath.trim()
      ? entry.pagePath.trim()
      : author
        ? `${author}/${installSlug}`
        : installSlug;

  const installedAtRaw = typeof entry.installedAt === "string" ? entry.installedAt.trim() : "";
  const installedAt =
    installedAtRaw && !Number.isNaN(new Date(installedAtRaw).getTime())
      ? new Date(installedAtRaw).toISOString()
      : new Date().toISOString();

  return {
    source: "clawhub",
    installSlug,
    author,
    pagePath,
    installedAt,
  };
}

function normalizeClawhubSkills(entries) {
  if (!Array.isArray(entries)) return [];

  const seen = new Set();
  const normalized = [];

  for (const entry of entries) {
    const skill = normalizeClawhubSkillEntry(entry);
    if (!skill) continue;
    const dedupeKey = `${skill.author}::${skill.installSlug}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(skill);
  }

  return normalized;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await db.query(
      "SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id],
    );
    res.json(result.rows.map(serializeAgent));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: "Agent not found" });

    const agent = result.rows[0];

    // Live status reconciliation — check actual container state while preserving
    // warning as a first-class degraded state until the container actually stops.
    if (agent.container_id && ["running", "warning", "error", "stopped"].includes(agent.status)) {
      try {
        const live = await containerManager.status(agent);
        const reconciledStatus = reconcileAgentStatus(agent.status, Boolean(live.running));
        if (reconciledStatus !== agent.status) {
          await db.query("UPDATE agents SET status = $1 WHERE id = $2", [
            reconciledStatus,
            agent.id,
          ]);
          agent.status = reconciledStatus;
        }
      } catch {
        // Can't reach container runtime — leave DB status as-is
      }
    }

    res.json(serializeAgent(agent));
  }),
);

// Historical container stats with time range
// Query params: ?range=5m|15m|30m|1h|6h|24h|3d|7d (default 15m) or ?from=ISO&to=ISO
router.get(
  "/:id/stats/history",
  asyncHandler(async (req, res) => {
    const agentCheck = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = agentCheck.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const rangeMap = {
      "5m": "5 minutes",
      "15m": "15 minutes",
      "30m": "30 minutes",
      "1h": "1 hour",
      "6h": "6 hours",
      "24h": "24 hours",
      "3d": "3 days",
      "7d": "7 days",
    };
    let fromTime, toTime;

    if (req.query.from && req.query.to) {
      fromTime = new Date(req.query.from);
      toTime = new Date(req.query.to);
    } else {
      const range = rangeMap[req.query.range || "15m"] || "15 minutes";
      toTime = new Date();
      fromTime = new Date(Date.now() - parseInterval(range));
    }

    res.json(await buildAgentHistoryResponse(agent, fromTime, toTime));
  }),
);

function parseInterval(pg) {
  const m = pg.match(/(\d+)\s*(day|minute|hour|second)/);
  if (!m) return 15 * 60 * 1000;
  const n = parseInt(m[1]);
  if (m[2] === "day") return n * 86400000;
  if (m[2] === "hour") return n * 3600000;
  if (m[2] === "minute") return n * 60000;
  return n * 1000;
}

function agentAuditMetadata(req, agent, extra = {}) {
  return buildAuditMetadata(
    req,
    buildAgentContext(agent, {
      ownerEmail: req?.user?.email || null,
      ...extra,
    }),
  );
}

// Get the gateway control UI URL (published host port for direct browser access)
router.get(
  "/:id/gateway-url",
  asyncHandler(async (req, res) => {
    const result = await db.query(
      `SELECT id, host, container_id, backend_type, runtime_family, deploy_target,
            sandbox_profile, gateway_token, gateway_host_port,
            gateway_host, gateway_port, user_id, status
       FROM agents
      WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    const runtimeFields = buildAgentRuntimeFields(agent);
    if (!isGatewayAvailableStatus(agent.status)) {
      return res.status(409).json({ error: "Agent gateway is only available while running" });
    }
    if (runtimeFields.runtime_family !== "openclaw") {
      return res.status(409).json({
        error: "This runtime family does not expose an OpenClaw gateway",
      });
    }
    if (!agent.container_id) return res.status(409).json({ error: "No container" });

    // Prefer the stored published port when present. This keeps browser access on
    // the control-plane host for Docker and local kind NodePort verification.
    let hostPort = agent.gateway_host_port;
    const backendType = runtimeFields.backend_type;
    if (!hostPort && agent.container_id && ["docker", "nemoclaw"].includes(backendType)) {
      try {
        const Docker = require("dockerode");
        const docker = new Docker({ socketPath: "/var/run/docker.sock" });
        const info = await docker.getContainer(agent.container_id).inspect();
        const portBindings = info.NetworkSettings?.Ports?.[`${OPENCLAW_GATEWAY_PORT}/tcp`];
        hostPort = portBindings?.[0]?.HostPort || null;
      } catch (e) {
        return res.status(502).json({ error: "Could not inspect container", details: e.message });
      }
    }

    const publishedGatewayHost = resolvePublishedGatewayHost(req);
    const publishedGatewayProtocol = resolvePublishedGatewayProtocol(req);

    if (hostPort) {
      return res.json({
        url: `${publishedGatewayProtocol}://${publishedGatewayHost}:${hostPort}`,
        port: parseInt(hostPort, 10),
      });
    }

    const directAddress = resolveGatewayAddress(agent, {
      publishedHost: publishedGatewayHost,
    });
    if (!directAddress) return res.status(409).json({ error: "Gateway address not available" });

    res.json({
      url: `${publishedGatewayProtocol}://${directAddress.host}:${directAddress.port}`,
      port: parseInt(directAddress.port, 10),
    });
  }),
);

function extractHermesApiError(payload, fallbackMessage) {
  if (payload && typeof payload === "object") {
    const nestedMessage = payload.error?.message;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
    if (typeof payload.raw === "string" && payload.raw.trim()) {
      return payload.raw.trim();
    }
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  return fallbackMessage;
}

function createStatusCodeError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function loadHermesUiAgent(req) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    req.params.id,
    req.user.id,
  ]);
  const agent = result.rows[0];
  if (!agent) {
    throw createStatusCodeError("Agent not found", 404);
  }

  const runtimeFields = buildAgentRuntimeFields(agent);
  if (runtimeFields.runtime_family !== "hermes") {
    throw createStatusCodeError(
      "This runtime family does not expose the Hermes WebUI surface",
      409,
    );
  }

  if (!isGatewayAvailableStatus(agent.status)) {
    throw createStatusCodeError("Hermes WebUI is only available while the agent is running", 409);
  }

  return agent;
}

function buildHermesGatewaySummary(snapshot = {}) {
  const directoryPlatforms = snapshot?.directory?.platforms || {};
  const configuredPlatforms = Object.values(snapshot?.platformDetails || {}).filter(
    (entry) => entry?.connected || entry?.enabled,
  );
  const discoveredTargetsCount = Object.values(directoryPlatforms).reduce(
    (count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
    0,
  );

  return {
    state: snapshot?.runtimeStatus?.gateway_state || null,
    exitReason: snapshot?.runtimeStatus?.exit_reason || null,
    restartRequested: Boolean(snapshot?.runtimeStatus?.restart_requested),
    activeAgents: snapshot?.runtimeStatus?.active_agents || 0,
    updatedAt: snapshot?.runtimeStatus?.updated_at || null,
    configuredPlatformsCount: configuredPlatforms.length,
    discoveredTargetsCount,
    jobsCount: typeof snapshot?.jobsCount === "number" ? snapshot.jobsCount : null,
    platformStates: snapshot?.runtimeStatus?.platforms || {},
  };
}

function buildHermesDashboardSummary(payload = {}) {
  return {
    version:
      typeof payload?.version === "string" && payload.version.trim()
        ? payload.version.trim()
        : null,
    gatewayRunning: Boolean(payload?.gateway_running),
    gatewayState:
      typeof payload?.gateway_state === "string" && payload.gateway_state.trim()
        ? payload.gateway_state.trim()
        : null,
    activeSessions: typeof payload?.active_sessions === "number" ? payload.active_sessions : null,
  };
}

function buildHermesDashboardUnsupportedMessage(versionLine = "") {
  const versionSuffix =
    typeof versionLine === "string" && versionLine.trim() ? ` (${versionLine.trim()})` : "";
  return (
    `This Hermes image${versionSuffix} does not include the official dashboard yet. ` +
    "Pull a current Hermes image and redeploy this agent."
  );
}

function buildHermesDashboardEnsureCommand() {
  return [
    'HERMES_BIN="/opt/hermes/.venv/bin/hermes"',
    'LOG_DIR="/opt/data/logs"',
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || true)"',
    'if [ -z "$HERMES_BIN" ]; then echo "STATUS=missing-cli"; exit 0; fi',
    'VERSION="$("$HERMES_BIN" version 2>/dev/null | head -n 1 || true)"',
    'if ! "$HERMES_BIN" --help 2>/dev/null | grep -q "dashboard"; then echo "STATUS=missing-dashboard"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi',
    'if ! python3 -c \'import importlib.util,sys;sys.exit(0 if importlib.util.find_spec("hermes_cli.web_server") else 1)\'; then echo "STATUS=missing-web-server"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi',
    'if python3 -c \'import socket,sys;s=socket.socket();s.settimeout(1);rc=s.connect_ex(("127.0.0.1",9119));s.close();sys.exit(0 if rc==0 else 1)\'; then echo "STATUS=already-running"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi',
    'if [ -d "$LOG_DIR" ]; then chown -R hermes:hermes "$LOG_DIR" 2>/dev/null || true; else mkdir -p "$LOG_DIR"; chown hermes:hermes "$LOG_DIR" 2>/dev/null || true; fi',
    "nohup /opt/hermes/docker/entrypoint.sh dashboard --host 0.0.0.0 --insecure --no-open >> /proc/1/fd/1 2>> /proc/1/fd/2 &",
    "sleep 2",
    'if python3 -c \'import socket,sys;s=socket.socket();s.settimeout(1);rc=s.connect_ex(("127.0.0.1",9119));s.close();sys.exit(0 if rc==0 else 1)\'; then echo "STATUS=started"; else echo "STATUS=start-failed"; fi',
    'printf "VERSION=%s\\n" "$VERSION"',
  ].join("; ");
}

async function ensureHermesDashboardProcess(agent) {
  try {
    const { output } = await runContainerCommand(agent, buildHermesDashboardEnsureCommand(), {
      timeout: 15000,
    });
    const lines = String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const statusLine = lines.find((line) => line.startsWith("STATUS=")) || "";
    const versionLine = lines.find((line) => line.startsWith("VERSION=")) || "";
    return {
      status: statusLine ? statusLine.slice("STATUS=".length) : "unknown",
      version: versionLine ? versionLine.slice("VERSION=".length).trim() : "",
    };
  } catch (error) {
    return {
      status: "probe-failed",
      version: "",
      error: error.message || "Dashboard probe failed",
    };
  }
}

function normalizeHermesCronPayload(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const payload = { ...body };
  if (!payload.prompt && typeof payload.message === "string") {
    payload.prompt = payload.message;
  }
  delete payload.message;

  for (const key of ["name", "schedule", "prompt", "deliver", "timezone"]) {
    if (typeof payload[key] === "string") {
      payload[key] = payload[key].trim();
    }
  }

  return payload;
}

function normalizeHermesCronListPayload(payload) {
  if (Array.isArray(payload)) {
    return { jobs: payload };
  }

  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.jobs)) {
      return payload;
    }
    if (Array.isArray(payload.items)) {
      return {
        ...payload,
        jobs: payload.items,
      };
    }
  }

  return { jobs: [] };
}

function resolveHermesChannelConfig(body = {}) {
  if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
    return body.config;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const { type, config, ...rest } = body;
  return rest;
}

async function resolveHermesApiToken(agent) {
  const storedToken = String(agent?.gateway_token || "").trim();
  if (storedToken) return storedToken;
  if (!agent?.container_id) return null;

  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const info = await docker.getContainer(agent.container_id).inspect();
    const envVars = Array.isArray(info?.Config?.Env) ? info.Config.Env : [];
    const keyEntry = envVars.find(
      (entry) => typeof entry === "string" && entry.startsWith("API_SERVER_KEY="),
    );
    const resolvedToken = keyEntry ? keyEntry.slice("API_SERVER_KEY=".length).trim() : "";

    if (!resolvedToken) return null;

    agent.gateway_token = resolvedToken;
    try {
      await db.query("UPDATE agents SET gateway_token = $2 WHERE id = $1", [
        agent.id,
        resolvedToken,
      ]);
    } catch {
      // Best-effort cache only.
    }

    return resolvedToken;
  } catch {
    return null;
  }
}

async function fetchHermesApi(agent, path, options = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, path);
  if (!runtimeUrl) {
    const error = new Error("Hermes runtime endpoint not available");
    error.statusCode = 409;
    throw error;
  }

  const apiToken = await resolveHermesApiToken(agent);
  if (!apiToken) {
    const error = new Error(
      "Hermes API auth token unavailable. Redeploy the agent to refresh runtime auth.",
    );
    error.statusCode = 409;
    throw error;
  }

  const requestHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${apiToken}`,
    ...(options.headers || {}),
  };

  let body;
  if (options.body != null) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!requestHeaders["Content-Type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }
  }

  const response = await fetch(runtimeUrl, {
    method: options.method || "GET",
    headers: requestHeaders,
    body,
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });

  const raw = await response.text().catch(() => "");
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    data,
  };
}

async function fetchHermesDashboard(agent, path, options = {}) {
  const dashboardUrl = dashboardUrlForAgent(agent, path);
  if (!dashboardUrl) {
    const error = new Error("Hermes dashboard endpoint not available");
    error.statusCode = 409;
    throw error;
  }

  const response = await fetch(dashboardUrl, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });

  const raw = await response.text().catch(() => "");
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    data,
  };
}

// Hermes runtime status and model metadata for the agent-details WebUI tab.
router.get(
  "/:id/hermes-ui",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    const runtimeAddress = resolveRuntimeAddress(agent);
    const dashboardAddress = resolveHermesDashboardAddress(agent);
    if (!runtimeAddress) {
      return res.status(409).json({ error: "Hermes runtime address not available" });
    }

    let health = { ok: false, error: "Hermes runtime not ready yet" };
    let models = [];
    let modelsError = null;
    let gateway = null;
    let gatewayError = null;
    let directoryUpdatedAt = null;
    let configuredModel = null;
    let configuredProvider = null;
    let configuredBaseUrl = null;
    const dashboardBaseUrl = dashboardAddress ? dashboardUrlForAgent(agent, "") : null;
    let dashboard = {
      ready: false,
      url: dashboardBaseUrl,
      port: dashboardAddress?.port || null,
      health: null,
      retryable: true,
      error: dashboardAddress
        ? "Hermes dashboard not ready yet"
        : "Hermes dashboard endpoint not available",
    };

    try {
      const healthResponse = await fetchHermesApi(agent, "/health", {
        timeoutMs: 5000,
      });
      if (healthResponse.ok && healthResponse.data?.status === "ok") {
        health = {
          ok: true,
          ...healthResponse.data,
        };
        const modelsResponse = await fetchHermesApi(agent, "/v1/models", {
          timeoutMs: 5000,
        });
        if (modelsResponse.ok && Array.isArray(modelsResponse.data?.data)) {
          models = modelsResponse.data.data;
        } else {
          modelsError = extractHermesApiError(
            modelsResponse.data,
            `Hermes model listing returned ${modelsResponse.status}`,
          );
        }
      } else {
        health = {
          ok: false,
          error: extractHermesApiError(
            healthResponse.data,
            `Hermes runtime returned ${healthResponse.status}`,
          ),
        };
      }
    } catch (error) {
      health = {
        ok: false,
        error: error.message || "Hermes runtime not reachable",
      };
    }

    try {
      const dashboardResponse = await fetchHermesDashboard(agent, "/api/status", {
        timeoutMs: 5000,
      });
      if (dashboardResponse.ok) {
        dashboard = {
          ready: true,
          url: dashboardBaseUrl,
          port: dashboardAddress?.port || null,
          health: buildHermesDashboardSummary(dashboardResponse.data),
          retryable: false,
          error: null,
        };
      } else {
        dashboard = {
          ready: false,
          url: dashboardBaseUrl,
          port: dashboardAddress?.port || null,
          health: null,
          retryable: true,
          error: extractHermesApiError(
            dashboardResponse.data,
            `Hermes dashboard returned ${dashboardResponse.status}`,
          ),
        };
      }
    } catch (error) {
      const ensuredDashboard = await ensureHermesDashboardProcess(agent);

      if (ensuredDashboard.status === "started" || ensuredDashboard.status === "already-running") {
        try {
          const dashboardResponse = await fetchHermesDashboard(agent, "/api/status", {
            timeoutMs: 5000,
          });
          if (dashboardResponse.ok) {
            dashboard = {
              ready: true,
              url: dashboardBaseUrl,
              port: dashboardAddress?.port || null,
              health: buildHermesDashboardSummary(dashboardResponse.data),
              retryable: false,
              error: null,
            };
          } else {
            dashboard = {
              ready: false,
              url: dashboardBaseUrl,
              port: dashboardAddress?.port || null,
              health: null,
              retryable: true,
              error: extractHermesApiError(
                dashboardResponse.data,
                `Hermes dashboard returned ${dashboardResponse.status}`,
              ),
            };
          }
        } catch (retryError) {
          dashboard = {
            ready: false,
            url: dashboardBaseUrl,
            port: dashboardAddress?.port || null,
            health: null,
            retryable: true,
            error: retryError.message || "Hermes dashboard not reachable",
          };
        }
      } else if (
        ensuredDashboard.status === "missing-dashboard" ||
        ensuredDashboard.status === "missing-web-server" ||
        ensuredDashboard.status === "missing-cli"
      ) {
        dashboard = {
          ready: false,
          url: dashboardBaseUrl,
          port: dashboardAddress?.port || null,
          health: null,
          retryable: false,
          error: buildHermesDashboardUnsupportedMessage(ensuredDashboard.version),
        };
      } else if (ensuredDashboard.status === "start-failed") {
        dashboard = {
          ready: false,
          url: dashboardBaseUrl,
          port: dashboardAddress?.port || null,
          health: null,
          retryable: true,
          error:
            "Hermes dashboard failed to start inside the running agent. Check the container logs or redeploy the agent.",
        };
      } else {
        dashboard = {
          ready: false,
          url: dashboardBaseUrl,
          port: dashboardAddress?.port || null,
          health: null,
          retryable: true,
          error: error.message || "Hermes dashboard not reachable",
        };
      }
    }

    try {
      const snapshot = await readHermesRuntimeSnapshot(agent);
      gateway = buildHermesGatewaySummary(snapshot);
      directoryUpdatedAt = snapshot?.directory?.updated_at || null;
      configuredModel =
        typeof snapshot?.modelConfig?.defaultModel === "string" &&
        snapshot.modelConfig.defaultModel.trim()
          ? snapshot.modelConfig.defaultModel.trim()
          : null;
      configuredProvider =
        typeof snapshot?.modelConfig?.provider === "string" && snapshot.modelConfig.provider.trim()
          ? snapshot.modelConfig.provider.trim()
          : null;
      configuredBaseUrl =
        typeof snapshot?.modelConfig?.baseUrl === "string" && snapshot.modelConfig.baseUrl.trim()
          ? snapshot.modelConfig.baseUrl.trim()
          : null;
    } catch (error) {
      gatewayError = error.message || "Failed to read Hermes gateway state";
    }

    res.json({
      url: runtimeUrlForAgent(agent, "/v1"),
      runtime: runtimeAddress,
      health,
      dashboard,
      models,
      defaultModel: configuredModel || models[0]?.id || null,
      configuredModel,
      configuredProvider,
      configuredBaseUrl,
      directoryUpdatedAt,
      ...(gateway ? { gateway } : {}),
      ...(modelsError ? { modelsError } : {}),
      ...(gatewayError ? { gatewayError } : {}),
    });
  }),
);

router.post(
  "/:id/hermes-ui/chat",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [])
      .map((entry) => ({
        role: String(entry?.role || "").trim(),
        content: String(entry?.content || ""),
      }))
      .filter(
        (entry) => ["system", "user", "assistant"].includes(entry.role) && entry.content.trim(),
      );

    if (!messages.length) {
      return res.status(400).json({ error: "At least one chat message is required" });
    }

    if (messages[messages.length - 1]?.role !== "user") {
      return res.status(400).json({
        error: "Hermes chat requests must end with a user message",
      });
    }

    const requestedModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";

    let chatResponse;
    try {
      chatResponse = await fetchHermesApi(agent, "/v1/chat/completions", {
        method: "POST",
        timeoutMs: 240000,
        headers: sessionId
          ? {
              "X-Hermes-Session-Id": sessionId,
            }
          : undefined,
        body: {
          ...(requestedModel ? { model: requestedModel } : {}),
          stream: false,
          messages,
        },
      });
    } catch (error) {
      return res
        .status(error.statusCode || 502)
        .json({ error: error.message || "Hermes runtime unreachable" });
    }

    if (!chatResponse.ok) {
      const upstreamStatus = chatResponse.status >= 500 ? 502 : chatResponse.status;
      return res.status(upstreamStatus).json({
        error: extractHermesApiError(
          chatResponse.data,
          `Hermes chat returned ${chatResponse.status}`,
        ),
      });
    }

    const assistantMessage = chatResponse.data?.choices?.[0]?.message?.content || "";
    if (!assistantMessage) {
      return res.status(502).json({
        error: "Hermes chat returned an empty assistant message",
      });
    }

    res.json({
      message: assistantMessage,
      usage: chatResponse.data?.usage || null,
      model: chatResponse.data?.model || requestedModel || null,
      sessionId: chatResponse.headers.get("x-hermes-session-id") || sessionId || null,
    });
  }),
);

router.get(
  "/:id/hermes-ui/cron",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      const cronResponse = await fetchHermesApi(agent, "/api/jobs?include_disabled=true", {
        timeoutMs: 10000,
      });
      if (!cronResponse.ok) {
        return res.status(cronResponse.status >= 500 ? 502 : cronResponse.status).json({
          error: extractHermesApiError(
            cronResponse.data,
            `Hermes cron listing returned ${cronResponse.status}`,
          ),
        });
      }

      res.json(normalizeHermesCronListPayload(cronResponse.data));
    } catch (error) {
      res.status(error.statusCode || 502).json({
        error: error.message || "Hermes cron endpoint unreachable",
      });
    }
  }),
);

router.post(
  "/:id/hermes-ui/cron",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      const cronResponse = await fetchHermesApi(agent, "/api/jobs", {
        method: "POST",
        timeoutMs: 15000,
        body: normalizeHermesCronPayload(req.body),
      });
      if (!cronResponse.ok) {
        return res.status(cronResponse.status >= 500 ? 502 : cronResponse.status).json({
          error: extractHermesApiError(
            cronResponse.data,
            `Hermes cron creation returned ${cronResponse.status}`,
          ),
        });
      }

      res.json(
        cronResponse.data && typeof cronResponse.data === "object"
          ? cronResponse.data
          : { job: null },
      );
    } catch (error) {
      res.status(error.statusCode || 502).json({
        error: error.message || "Hermes cron endpoint unreachable",
      });
    }
  }),
);

router.delete(
  "/:id/hermes-ui/cron/:jobId",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      const cronResponse = await fetchHermesApi(
        agent,
        `/api/jobs/${encodeURIComponent(req.params.jobId)}`,
        {
          method: "DELETE",
          timeoutMs: 15000,
        },
      );
      if (!cronResponse.ok) {
        return res.status(cronResponse.status >= 500 ? 502 : cronResponse.status).json({
          error: extractHermesApiError(
            cronResponse.data,
            `Hermes cron deletion returned ${cronResponse.status}`,
          ),
        });
      }

      res.json({
        success: true,
        ...(cronResponse.data && typeof cronResponse.data === "object" ? cronResponse.data : {}),
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({
        error: error.message || "Hermes cron endpoint unreachable",
      });
    }
  }),
);

router.get(
  "/:id/hermes-ui/channels",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      res.json(await listHermesChannels(agent));
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || "Failed to load Hermes channels",
      });
    }
  }),
);

router.post(
  "/:id/hermes-ui/channels",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);
    const type = typeof req.body?.type === "string" ? req.body.type.trim().toLowerCase() : "";

    if (!type) {
      return res.status(400).json({ error: "Channel type is required" });
    }

    try {
      res.json(
        await saveHermesChannel(agent, type, resolveHermesChannelConfig(req.body), {
          create: true,
        }),
      );
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || "Failed to save Hermes channel",
      });
    }
  }),
);

router.patch(
  "/:id/hermes-ui/channels/:channelId",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      res.json(
        await saveHermesChannel(agent, req.params.channelId, resolveHermesChannelConfig(req.body)),
      );
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || "Failed to update Hermes channel",
      });
    }
  }),
);

router.delete(
  "/:id/hermes-ui/channels/:channelId",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      res.json(await deleteHermesChannel(agent, req.params.channelId));
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || "Failed to delete Hermes channel",
      });
    }
  }),
);

router.post(
  "/:id/hermes-ui/channels/:channelId/test",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);

    try {
      res.json(await testHermesChannel(agent, req.params.channelId));
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || "Failed to test Hermes channel",
      });
    }
  }),
);

// Live container resource stats (CPU, memory, network, PIDs)
router.get(
  "/:id/stats",
  asyncHandler(async (req, res) => {
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(await buildAgentStatsResponse(agent));
  }),
);

router.post("/deploy", async (req, res) => {
  try {
    const requestBody = req.body || {};
    const clawhubSkills = normalizeClawhubSkills(requestBody.clawhub_skills);
    // Enforce billing limits
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed)
      return res.status(402).json({ error: limits.error, subscription: limits.subscription });

    const sub = limits.subscription;
    let migrationDraft = null;
    if (requestBody.migration_draft_id) {
      migrationDraft = await getOwnedMigrationDraft(requestBody.migration_draft_id, req.user.id);
      if (!migrationDraft) {
        return res.status(404).json({ error: "Migration draft not found" });
      }
    }

    const requestedRuntimeFamily =
      requestBody.runtime_family != null
        ? requestBody.runtime_family
        : migrationDraft?.manifest?.runtimeFamily;
    const runtimeFamily = normalizeRequestedRuntimeFamily(requestedRuntimeFamily);
    if (requestBody.runtime_family != null && runtimeFamily == null) {
      return res.status(400).json({
        error: `Unsupported runtime_family. Nora currently supports: ${KNOWN_RUNTIME_FAMILIES.map((value) => `"${value}"`).join(", ")}.`,
      });
    }
    const name = sanitizeAgentName(
      requestBody.name,
      migrationDraft?.manifest?.name ||
        (migrationDraft?.manifest?.runtimeFamily === "hermes" ? "Hermes-Agent" : "OpenClaw-Agent"),
    );
    if (name.length > 100)
      return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    const runtimeFields = resolveRequestedRuntimeFields({
      request: {
        ...requestBody,
        runtime_family: runtimeFamily || DEFAULT_RUNTIME_FAMILY,
      },
    });
    const containerName = resolveContainerName({
      requestedName: requestBody.container_name,
      agentName: name,
      runtimeSelection: runtimeFields,
    });
    assertSupportedRuntimeSelection(runtimeFields);
    if (migrationDraft && runtimeFields.runtime_family !== migrationDraft.manifest.runtimeFamily) {
      return res.status(400).json({
        error: `Migration draft targets the ${migrationDraft.manifest.runtimeFamily} runtime family and cannot be deployed as ${runtimeFields.runtime_family}.`,
      });
    }
    const backendStatus = assertBackendAvailable(runtimeFields.backend_type);
    const node = await scheduler.selectNode({ fallback: runtimeFields.deploy_target });
    const nodeName = node ? node.name : runtimeFields.deploy_target;

    const deploymentDefaults = await getDeploymentDefaults();

    // Resolve resource specs based on platform mode
    let specs;
    if (!billing.IS_PAAS) {
      // Self-hosted: accept user-chosen values clamped to operator limits
      specs = clampDeploymentDefaults(
        normalizeDeploymentDefaults(requestBody, deploymentDefaults),
        billing.SELFHOSTED_LIMITS,
      );
    } else {
      // PaaS: resources are controlled by the operator-managed deployment defaults.
      specs = deploymentDefaults;
    }
    const image = resolveRequestedImage({
      requestedImage: requestBody.image,
      runtimeFields,
    });
    const templatePayload = migrationDraft
      ? migrationDraft.manifest.runtimeFamily === "openclaw"
        ? migrationDraft.manifest.templatePayload ||
          ensureCoreTemplateFiles(
            createEmptyTemplatePayload({
              source: "migration-draft",
            }),
            {
              name,
              sourceType: "platform",
              includeBootstrap: true,
            },
          )
        : createEmptyTemplatePayload({
            source: "migration-draft",
            migrationDraftId: migrationDraft.id,
          })
      : runtimeFields.runtime_family === "openclaw"
        ? ensureCoreTemplateFiles(
            createEmptyTemplatePayload({
              source: "blank-deploy",
            }),
            {
              name,
              sourceType: "platform",
              includeBootstrap: true,
            },
          )
        : createEmptyTemplatePayload({
            source: "blank-deploy",
          });

    const result = await db.query(
      `INSERT INTO agents(
         user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
         container_name, image, template_payload, clawhub_skills, runtime_family, deploy_target,
         sandbox_profile
       ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING *`,
      [
        req.user.id,
        name,
        nodeName,
        runtimeFields.backend_type,
        runtimeFields.sandbox_type,
        specs.vcpu,
        specs.ram_mb,
        specs.disk_gb,
        containerName,
        image,
        JSON.stringify(templatePayload),
        JSON.stringify(clawhubSkills),
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.sandbox_profile,
      ],
    );
    const agent = result.rows[0];

    if (migrationDraft) {
      await materializeManagedMigrationState(req.user.id, agent.id, migrationDraft.manifest);

      const hasTemplateWiring =
        migrationDraft.manifest.runtimeFamily === "openclaw" &&
        ((migrationDraft.manifest.templatePayload?.wiring?.channels || []).length > 0 ||
          (migrationDraft.manifest.templatePayload?.wiring?.integrations || []).length > 0);
      const hasManagedWiring =
        (migrationDraft.manifest.managed?.channels || []).length > 0 ||
        (migrationDraft.manifest.managed?.integrations || []).length > 0;

      if (hasTemplateWiring && !hasManagedWiring) {
        await materializeTemplateWiring(agent.id, migrationDraft.manifest.templatePayload);
      }

      await attachDraftToAgent(migrationDraft.id, agent.id);
    }

    await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);

    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      plan: sub.plan,
      backend: runtimeFields.backend_type,
      sandbox: runtimeFields.sandbox_profile,
      specs,
      container_name: containerName,
      image,
      model: runtimeFields.sandbox_profile === "nemoclaw" ? req.body.model || null : null,
      migration_draft_id: migrationDraft?.id || null,
      clawhub_skills: clawhubSkills,
    });

    const deployType = backendStatus.label;
    await monitoring.logEvent(
      "agent_deployed",
      `Agent "${name}" (${deployType}) queued for deployment`,
      agentAuditMetadata(req, agent, {
        deploy: {
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          sandboxProfile: runtimeFields.sandbox_profile,
          backend: runtimeFields.backend_type,
          type: deployType,
          specs,
          image,
          containerName,
          migrationDraftId: migrationDraft?.id || null,
        },
      }),
    );

    res.json(serializeAgent(agent));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const name = sanitizeAgentName(req.body.name, agent.name || "OpenClaw-Agent");
    if (name.length > 100) {
      return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    }

    const updated = await db.query("UPDATE agents SET name = $1 WHERE id = $2 RETURNING *", [
      name,
      agent.id,
    ]);
    await monitoring.logEvent(
      "agent_renamed",
      `Agent renamed to "${name}"`,
      agentAuditMetadata(req, updated.rows[0], {
        result: {
          previousName: agent.name,
          nextName: name,
        },
      }),
    );
    res.json(serializeAgent(updated.rows[0]));
  }),
);

router.post(
  "/:id/duplicate",
  asyncHandler(async (req, res) => {
    const requestBody = req.body || {};
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed) {
      return res.status(402).json({ error: limits.error, subscription: limits.subscription });
    }

    const sourceResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const sourceAgent = sourceResult.rows[0];
    if (!sourceAgent) return res.status(404).json({ error: "Agent not found" });
    const sourceRuntime = buildAgentRuntimeFields(sourceAgent);
    res.locals.auditContext = buildAgentContext(sourceAgent, {
      ownerEmail: req.user.email || null,
    });

    const cloneMode = CLONE_MODES.has(requestBody.clone_mode)
      ? requestBody.clone_mode
      : "files_only";
    const runtimeFamily = normalizeRequestedRuntimeFamily(requestBody.runtime_family);
    if (requestBody.runtime_family != null && runtimeFamily == null) {
      return res.status(400).json({
        error: `Unsupported runtime_family. Nora currently supports: ${KNOWN_RUNTIME_FAMILIES.map((value) => `"${value}"`).join(", ")}.`,
      });
    }
    const name = sanitizeAgentName(
      requestBody.name,
      `${sourceAgent.name || "OpenClaw-Agent"} Copy`,
    );
    if (name.length > 100) {
      return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    }

    const runtimeFields = resolveRequestedRuntimeFields({
      request: {
        ...requestBody,
        runtime_family: runtimeFamily || sourceRuntime.runtime_family,
      },
      fallback: sourceRuntime,
    });
    assertSupportedRuntimeSelection(runtimeFields);
    assertBackendAvailable(runtimeFields.backend_type);
    const node = await scheduler.selectNode({
      fallback: runtimeFields.deploy_target,
    });
    const specs = {
      vcpu: sourceAgent.vcpu || 2,
      ram_mb: sourceAgent.ram_mb || 2048,
      disk_gb: sourceAgent.disk_gb || 20,
    };
    const image = resolveRequestedImage({
      requestedImage: requestBody.image,
      runtimeFields,
      fallbackImage: sourceAgent.image || null,
      fallbackRuntimeFields: sourceRuntime,
    });
    const containerName = resolveContainerName({
      requestedName: requestBody.container_name,
      agentName: name,
      runtimeSelection: runtimeFields,
    });

    let templatePayload;
    try {
      templatePayload = await buildTemplatePayloadFromAgent(sourceAgent, cloneMode);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }

    const inserted = await db.query(
      `INSERT INTO agents(
       user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
       container_name, image, template_payload, runtime_family, deploy_target,
       sandbox_profile
     ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        req.user.id,
        name,
        node?.name || runtimeFields.deploy_target,
        runtimeFields.backend_type,
        runtimeFields.sandbox_type,
        specs.vcpu,
        specs.ram_mb,
        specs.disk_gb,
        containerName,
        image,
        JSON.stringify(templatePayload),
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.sandbox_profile,
      ],
    );
    const agent = inserted.rows[0];

    await materializeTemplateWiring(agent.id, templatePayload);
    await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);
    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      plan: limits.subscription.plan,
      backend: runtimeFields.backend_type,
      sandbox: runtimeFields.sandbox_profile,
      specs,
      container_name: containerName,
      image,
    });
    await monitoring.logEvent(
      "agent_duplicated",
      `Agent "${sourceAgent.name}" duplicated as "${agent.name}"`,
      agentAuditMetadata(req, agent, {
        sourceAgent: {
          id: sourceAgent.id,
          name: sourceAgent.name,
        },
        clone: {
          mode: cloneMode,
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
    );

    res.json(serializeAgent(agent));
  }),
);

router.post("/:id/start", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!agent.container_id)
      return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.start(agent);

    const updated = await db.query(
      "UPDATE agents SET status = 'running' WHERE id = $1 RETURNING *",
      [agent.id],
    );
    try {
      const authSyncResults = await syncAuthToUserAgents(req.user.id, agent.id, {
        onlyIfAuthPresent: true,
      });
      const failedSync = authSyncResults.find((result) => result.status === "failed");
      if (failedSync) {
        console.warn(
          `[agents.start] Auth sync failed for agent ${agent.id}: ${failedSync.error || "unknown error"}`,
        );
      }
    } catch (syncError) {
      console.warn(`[agents.start] Auth sync errored for agent ${agent.id}: ${syncError.message}`);
    }

    await monitoring.logEvent(
      "agent_started",
      `Agent "${agent.name}" started`,
      agentAuditMetadata(req, updated.rows[0], {
        result: { status: "running" },
      }),
    );
    res.json(serializeAgent(updated.rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/stop", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });

    if (agent.container_id) {
      try {
        await containerManager.stop(agent);
      } catch (e) {
        if (!e.message.includes("already stopped") && !e.message.includes("not running")) {
          console.error("Container stop error:", e.message);
        }
      }
    }

    const updated = await db.query(
      "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *",
      [agent.id],
    );
    await monitoring.logEvent(
      "agent_stopped",
      `Agent "${agent.name}" stopped`,
      agentAuditMetadata(req, updated.rows[0], {
        result: { status: "stopped" },
      }),
    );
    res.json(serializeAgent(updated.rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function destroyAgent(agentId, userId, req, res) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    agentId,
    userId,
  ]);
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.locals.auditContext = buildAgentContext(agent, {
    ownerEmail: req.user.email || null,
  });

  if (agent.container_id) {
    try {
      await containerManager.destroy(agent);
    } catch (e) {
      console.error("Container cleanup error:", e.message);
    }
  }

  await db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
  await monitoring.logEvent(
    "agent_deleted",
    `Agent "${agent.name}" deleted`,
    agentAuditMetadata(req, agent, {
      result: { deleted: true },
    }),
  );
  res.json({ success: true });
}

router.post("/:id/delete", async (req, res) => {
  try {
    await destroyAgent(req.params.id, req.user.id, req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await destroyAgent(req.params.id, req.user.id, req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/restart", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!agent.container_id)
      return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.restart(agent);

    await db.query("UPDATE agents SET status = 'running' WHERE id = $1", [agent.id]);
    await monitoring.logEvent(
      "agent_restarted",
      `Agent "${agent.name}" restarted`,
      agentAuditMetadata(req, agent, {
        result: { status: "running" },
      }),
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/redeploy", async (req, res) => {
  try {
    const requestBody = req.body || {};
    const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!["warning", "error", "stopped"].includes(agent.status)) {
      return res
        .status(400)
        .json({ error: "Agent must be in warning, error, or stopped state to redeploy" });
    }

    const runtimeFamily = normalizeRequestedRuntimeFamily(requestBody.runtime_family);
    if (requestBody.runtime_family != null && runtimeFamily == null) {
      return res.status(400).json({
        error: `Unsupported runtime_family. Nora currently supports: ${KNOWN_RUNTIME_FAMILIES.map((value) => `"${value}"`).join(", ")}.`,
      });
    }

    const currentRuntimeFields = buildAgentRuntimeFields(agent);
    const runtimeFields = resolveRequestedRuntimeFields({
      request: {
        ...requestBody,
        runtime_family: runtimeFamily || currentRuntimeFields.runtime_family,
      },
      fallback: currentRuntimeFields,
    });
    assertSupportedRuntimeSelection(runtimeFields);
    assertBackendAvailable(runtimeFields.backend_type);
    const containerName = resolveContainerName({
      requestedName: requestBody.container_name,
      currentName: agent.container_name,
      agentName: agent.name,
      runtimeSelection: runtimeFields,
    });
    const image = resolveRequestedImage({
      requestedImage: requestBody.image,
      runtimeFields,
      fallbackImage: agent.image || null,
      fallbackRuntimeFields: currentRuntimeFields,
    });

    await db.query(
      `UPDATE agents
          SET status = 'queued',
              container_id = NULL,
              host = NULL,
              runtime_host = NULL,
              runtime_port = NULL,
              gateway_host = NULL,
              gateway_port = NULL,
              gateway_host_port = NULL,
              gateway_token = NULL,
              backend_type = $2,
              sandbox_type = $3,
              runtime_family = $4,
              deploy_target = $5,
              sandbox_profile = $6,
              container_name = $7,
              image = $8
        WHERE id = $1`,
      [
        agent.id,
        runtimeFields.backend_type,
        runtimeFields.sandbox_type,
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.sandbox_profile,
        containerName,
        image,
      ],
    );

    await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);

    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      backend: runtimeFields.backend_type,
      sandbox: runtimeFields.sandbox_profile,
      specs: { vcpu: agent.vcpu || 2, ram_mb: agent.ram_mb || 2048, disk_gb: agent.disk_gb || 20 },
      container_name: containerName,
      image,
    });

    await monitoring.logEvent(
      "agent_redeployed",
      `Agent "${agent.name}" re-queued for deployment`,
      agentAuditMetadata(req, agent, {
        result: {
          previousStatus: agent.status,
          nextStatus: "queued",
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
    );

    res.json({ success: true, status: "queued" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
