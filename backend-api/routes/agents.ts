// @ts-nocheck
const express = require("express");
const db = require("../db");
const { encrypt, decrypt } = require("../crypto");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const {
  clampDeploymentDefaults,
  getDeploymentDefaults,
  normalizeDeploymentDefaults,
} = require("../platformSettings");
const scheduler = require("../scheduler");
const containerManager = require("../containerManager");
const agentBudgets = require("../agentBudgets");
const agentSchedules = require("../agentSchedules");
const monitoring = require("../monitoring");
const metrics = require("../metrics");
const workspaces = require("../workspaces");
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
const { assertExternalEndpointReachable } = require("../gatewayProxy");
const {
  HERMES_DASHBOARD_PORT,
  OPENCLAW_GATEWAY_PORT,
} = require("../../agent-runtime/lib/contracts");
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
  getRuntimeSelectionStatus,
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
const { findAccessibleAgent } = require("../middleware/ownership");
const { scopeByMethod } = require("../middleware/auth");
const agentVersions = require("../agentVersions");
const { assertKubernetesExecutionTargetAvailable } = require("../kubernetesClusters");
const { assertRemoteHostExecutionTargetAvailable } = require("../remoteHosts");
const { releaseGatewayPort } = require("../portAllocations");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("agent"));
// API-key requests need agents:read for GET/HEAD, agents:write for everything
// else. Session-authenticated requests skip this check (req.apiKey is unset).
router.use(scopeByMethod("agents:read", "agents:write"));

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
    runtime_family: runtimeFields?.runtime_family,
    backend: runtimeFields?.backend_type,
    deploy_target: runtimeFields?.deploy_target,
    sandbox_profile: runtimeFields?.sandbox_profile,
  });
}

function normalizeRequestedRuntimeFamily(value) {
  if (!isKnownRuntimeFamily(value)) return null;
  return normalizeRuntimeFamilyName(value);
}

function assertRuntimeSelectionAvailable(runtimeFields) {
  const status = getRuntimeSelectionStatus(runtimeFields);
  if (!status.enabled) {
    if (status.issue && /does not support/i.test(status.issue)) {
      const error = new Error(status.issue);
      error.statusCode = 400;
      throw error;
    }
    const error = new Error(
      `Runtime selection is not enabled. Enable runtime_family=${status.runtimeFamily}, deploy_target=${status.deployTarget}, and sandbox_profile=${status.sandboxProfile} for this Nora control plane.`,
    );
    error.statusCode = 400;
    throw error;
  }
  if (!status.configured) {
    const error = new Error(
      status.issue || "Runtime selection is not configured for this Nora control plane.",
    );
    error.statusCode = 400;
    throw error;
  }
  return status;
}

function isIgnorableStopError(error) {
  const message = String(error?.message || "");
  return message.includes("already stopped") || message.includes("not running");
}

async function assertRuntimeTargetAvailable(runtimeFields, ownerUserId) {
  const status = assertRuntimeSelectionAvailable(runtimeFields);
  await assertKubernetesExecutionTargetAvailable(runtimeFields);
  await assertRemoteHostExecutionTargetAvailable(runtimeFields, { ownerUserId });
  return status;
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
  const configuredProtocol = String(
    process.env.GATEWAY_PROTOCOL || process.env.GATEWAY_SCHEME || "",
  )
    .trim()
    .replace(/:$/, "")
    .toLowerCase();
  if (configuredProtocol === "https") return "https";
  if (configuredProtocol === "http") return "http";

  // The OpenClaw gateway's published Docker/Kubernetes ports serve plain HTTP.
  // The control plane itself may be behind HTTPS, but inheriting that scheme
  // produces browser TLS errors on direct gateway ports like :19618.
  return "http";
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
    const scope = req.query.scope === "owned" ? "owned" : "accessible";
    const agents = await workspaces.listAccessibleAgents(req.user.id, { scope });
    res.json(agents.map(serializeAgent));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    let runtimeStatus = null;

    // Live status reconciliation — check actual container state while preserving
    // warning as a first-class degraded state until the container actually stops.
    if (
      containerManager.canMutate(agent) &&
      ["running", "warning", "error", "stopped"].includes(agent.status)
    ) {
      try {
        const live = await containerManager.status(agent);
        runtimeStatus = live;
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

    if (runtimeStatus) {
      agent.runtime_status = runtimeStatus;
    }

    res.json(serializeAgent(agent));
  }),
);

// Historical container stats with time range
// Query params: ?range=5m|15m|30m|1h|6h|24h|3d|7d (default 15m) or ?from=ISO&to=ISO
router.get(
  "/:id/stats/history",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
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
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
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
    // Only inspect once the agent has fully settled — the worker's early
    // container_id write means the id is in the DB before the container's port
    // bindings are ready. Trying to inspect during 'queued'/'deploying' can
    // transiently 404 or return empty bindings; callers treat an absent URL as
    // "still starting up" rather than as a fatal error.
    const READY_STATUSES = new Set(["running", "warning"]);
    if (
      !hostPort &&
      typeof agent.container_id === "string" &&
      agent.container_id.length > 0 &&
      READY_STATUSES.has(agent.status) &&
      backendType === "docker"
    ) {
      try {
        const Docker = require("dockerode");
        const docker = new Docker({ socketPath: "/var/run/docker.sock" });
        const info = await docker.getContainer(agent.container_id).inspect();
        const portBindings = info.NetworkSettings?.Ports?.[`${OPENCLAW_GATEWAY_PORT}/tcp`];
        hostPort = portBindings?.[0]?.HostPort || null;
      } catch (e) {
        // Don't bubble raw Docker error strings — they can contain the literal
        // word "null" on id-coercion paths which is confusing in the UI. Log
        // for operators, respond with a generic message for the user.
        console.warn(
          `[agents.ui-info] inspect failed for agent ${agent.id} (container_id=${agent.container_id}): ${e.message}`,
        );
        return res.status(502).json({ error: "Could not inspect container" });
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

async function loadHermesUiAgent(req, { requiredRole = "viewer" } = {}) {
  const agent = await findAccessibleAgent(req.params.id, req.user.id, requiredRole);
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

  // Belt-and-braces: gateway-available status should imply container_id is set
  // (the worker writes both atomically in the final UPDATE). If they've drifted
  // — e.g. the row was touched directly, a failed redeploy left it half-cleared,
  // or a legacy migration — every downstream Hermes call (exec/inspect/restart)
  // would otherwise trip the NoContainerError guard with an opaque message.
  // Fail early with an actionable redeploy hint.
  if (typeof agent.container_id !== "string" || agent.container_id.length === 0) {
    throw createStatusCodeError(
      "Hermes runtime is marked running but has no container assigned. Redeploy the agent to recover.",
      409,
    );
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
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || true)"',
    'if [ -z "$HERMES_BIN" ]; then echo "STATUS=missing-cli"; exit 0; fi',
    'VERSION="$("$HERMES_BIN" version 2>/dev/null | head -n 1 || true)"',
    'if ! "$HERMES_BIN" --help 2>/dev/null | grep -q "dashboard"; then echo "STATUS=missing-dashboard"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi',
    `if python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);rc=s.connect_ex(("127.0.0.1",${HERMES_DASHBOARD_PORT}));s.close();sys.exit(0 if rc==0 else 1)'; then echo "STATUS=already-running"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi`,
    'if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1; then setsid gosu hermes "$HERMES_BIN" dashboard --host 0.0.0.0 --insecure --no-open < /dev/null & else setsid "$HERMES_BIN" dashboard --host 0.0.0.0 --insecure --no-open < /dev/null & fi',
    "started=0",
    `for _attempt in 1 2 3 4 5; do if python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);rc=s.connect_ex(("127.0.0.1",${HERMES_DASHBOARD_PORT}));s.close();sys.exit(0 if rc==0 else 1)'; then started=1; break; fi; sleep 1; done`,
    'if [ "$started" = "1" ]; then echo "STATUS=started"; else echo "STATUS=start-failed"; fi',
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
  // gateway_token is encrypted at rest; decrypt() is transparent to legacy
  // plaintext. A rotated/corrupted key would throw — fall through to the
  // container-env inspection below rather than failing the whole call.
  let storedToken = "";
  if (agent?.gateway_token) {
    try {
      storedToken = String(decrypt(agent.gateway_token) || "").trim();
    } catch (err) {
      // Surface the root cause (e.g. ENCRYPTION_KEY rotation) before falling
      // back to container inspection, so a "token unavailable" downstream error
      // is traceable. err.message carries no secret material.
      console.warn(
        `[hermes-token] Could not decrypt stored gateway_token for agent ${agent.id} — falling back to runtime inspection: ${err.message}`,
      );
      storedToken = "";
    }
  }
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
        encrypt(resolvedToken),
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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

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
    // Wall-clock start for the OpenTelemetry chat span duration.
    const chatStartedAtMs = Date.now();
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
    const responseSessionId = chatResponse.headers.get("x-hermes-session-id") || sessionId || null;
    Promise.resolve(
      metrics.recordMetric?.(agent.id, req.user.id, "messages_sent", 1, {
        runtime_family: "hermes",
        source: "hermes-ui",
        ...(responseSessionId ? { session_id: responseSessionId } : {}),
      }),
    ).catch(() => {});
    Promise.resolve(
      metrics.recordTokenUsage?.(agent, req.user.id, chatResponse.data, {
        runtimeFamily: "hermes",
        source: "hermes-ui",
        model: chatResponse.data?.model || requestedModel || null,
        sessionId: responseSessionId,
        startedAtMs: chatStartedAtMs,
      }),
    ).catch(() => {});

    res.json({
      message: assistantMessage,
      usage: chatResponse.data?.usage || null,
      model: chatResponse.data?.model || requestedModel || null,
      sessionId: responseSessionId,
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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

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

router.put(
  "/:id/hermes-ui/cron/:jobId",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

    try {
      const cronResponse = await fetchHermesApi(
        agent,
        `/api/jobs/${encodeURIComponent(req.params.jobId)}`,
        {
          method: "PUT",
          timeoutMs: 15000,
          body: normalizeHermesCronPayload(req.body),
        },
      );
      if (!cronResponse.ok) {
        return res.status(cronResponse.status >= 500 ? 502 : cronResponse.status).json({
          error: extractHermesApiError(
            cronResponse.data,
            `Hermes cron update returned ${cronResponse.status}`,
          ),
        });
      }

      res.json(
        cronResponse.data && typeof cronResponse.data === "object"
          ? cronResponse.data
          : { success: true },
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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

    try {
      const integrations = require("../integrations");
      const linkedIntegration =
        typeof integrations.findActiveIntegrationByCronJobId === "function"
          ? await integrations.findActiveIntegrationByCronJobId(req.params.id, req.params.jobId)
          : null;

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

      if (linkedIntegration) {
        if (typeof integrations.updateEmailCronJobId === "function") {
          await integrations.updateEmailCronJobId(linkedIntegration.id, req.params.id, null);
        }
        if (
          linkedIntegration.provider === "email" &&
          typeof integrations.updateIntegration === "function"
        ) {
          await integrations.updateIntegration(linkedIntegration.id, req.params.id, null, {
            "cron.enabled": false,
          });
        }
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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });
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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

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
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });

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
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
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
    const runtimeSelectionStatus = await assertRuntimeTargetAvailable(runtimeFields, req.user.id);
    if (migrationDraft && runtimeFields.runtime_family !== migrationDraft.manifest.runtimeFamily) {
      return res.status(400).json({
        error: `Migration draft targets the ${migrationDraft.manifest.runtimeFamily} runtime family and cannot be deployed as ${runtimeFields.runtime_family}.`,
      });
    }
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
         execution_target_id, sandbox_profile
       ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16) RETURNING *`,
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
        runtimeFields.execution_target_id,
        runtimeFields.sandbox_profile,
      ],
    );
    const agent = result.rows[0];

    // Capture v1 of the agent's configuration so the version timeline starts
    // from deploy. Best-effort — never blocks the deploy on a snapshot failure.
    agentVersions.recordVersionBestEffort(agent.id, templatePayload, {
      createdBy: req.user.id,
      message: `Initial deploy: ${name}`,
      source: "deploy",
    });

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
      execution_target_id: runtimeFields.execution_target_id,
      sandbox: runtimeFields.sandbox_profile,
      specs,
      container_name: containerName,
      image,
      model: runtimeFields.sandbox_profile === "nemoclaw" ? req.body.model || null : null,
      migration_draft_id: migrationDraft?.id || null,
      clawhub_skills: clawhubSkills,
    });

    const deployType = `${runtimeSelectionStatus.runtimeFamily}/${runtimeSelectionStatus.deployTarget}/${runtimeSelectionStatus.sandboxProfile}`;
    await monitoring.logEvent(
      "agent_deployed",
      `Agent "${name}" (${deployType}) queued for deployment`,
      agentAuditMetadata(req, agent, {
        deploy: {
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          executionTargetId: runtimeFields.execution_target_id,
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

// Adopt an already-running OpenClaw/Hermes runtime that Nora did NOT provision,
// by its reachable URL + gateway token (BYOC Phase C). Creates an agent row with
// deploy_target='external' and status='running' — NO provisioning job, no
// container. Nora monitors + proxies access; lifecycle mutations are blocked (no
// container_id ⇒ canMutate() is false) and delete is effectively a deregister.
router.post("/adopt", async (req, res) => {
  try {
    const body = req.body || {};
    // An adopted runtime still occupies an agent slot, so it counts against the
    // operator's quota even though Nora doesn't provision its compute.
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed) {
      return res.status(402).json({ error: limits.error, subscription: limits.subscription });
    }
    const runtimeFamily = normalizeRequestedRuntimeFamily(body.runtime_family);
    if (runtimeFamily == null) {
      return res.status(400).json({
        error: `Unsupported runtime_family. Nora currently supports: ${KNOWN_RUNTIME_FAMILIES.map((v) => `"${v}"`).join(", ")}.`,
      });
    }
    const name = sanitizeAgentName(
      body.name,
      runtimeFamily === "hermes" ? "Hermes-Agent" : "OpenClaw-Agent",
    );
    if (name.length > 100) {
      return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    }

    const token = String(body.gateway_token || body.token || "").trim();
    if (!token) {
      return res
        .status(400)
        .json({ error: "gateway_token is required to adopt an external runtime" });
    }

    // Accept either a full URL or an explicit host (+ optional port). Default the
    // port to the runtime family's contract port (OpenClaw gateway / Hermes dashboard).
    const defaultPort = runtimeFamily === "hermes" ? HERMES_DASHBOARD_PORT : OPENCLAW_GATEWAY_PORT;
    let host;
    let port;
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (rawUrl) {
      let parsed;
      try {
        parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      } catch {
        return res.status(400).json({ error: "Invalid runtime URL" });
      }
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : defaultPort;
    } else if (body.host) {
      host = String(body.host).trim();
      port = body.port != null && body.port !== "" ? Number(body.port) : defaultPort;
    } else {
      return res.status(400).json({ error: "Provide the runtime URL (or host) to adopt" });
    }
    if (!host || !Number.isInteger(port)) {
      return res.status(400).json({ error: "Provide a valid runtime host and port to adopt" });
    }

    // Registration-time SSRF gate — the same hard floor + port allowlist the proxy
    // enforces at reach time, plus public-only in hosted (PaaS) mode.
    let endpoint;
    try {
      endpoint = await assertExternalEndpointReachable({ host, port }, { paas: billing.IS_PAAS });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // gateway_host/gateway_port are the first fields read by BOTH
    // resolveGatewayAddress (OpenClaw) and resolveHermesDashboardAddress (Hermes),
    // so one mapping covers chat + dashboard reach for either family. status starts
    // 'running' (optimistic); the external health-poll (Phase C2) reconciles it.
    // dashboard_port mirrors the published port so resolveHermesDashboardAddress is
    // correct even via its runtime_host fallback (not just the gateway_host branch).
    const result = await db.query(
      `INSERT INTO agents(
         user_id, name, status, runtime_family, deploy_target, execution_target_id,
         sandbox_profile, sandbox_type, backend_type, gateway_host, gateway_port,
         runtime_host, dashboard_port, gateway_token
       ) VALUES($1, $2, 'running', $3, 'external', 'external', 'standard', 'standard',
                'external', $4, $5, $4, $5, $6) RETURNING *`,
      // gateway_token is encrypted at rest (no-op when ENCRYPTION_KEY is unset).
      [req.user.id, name, runtimeFamily, endpoint.host, endpoint.port, encrypt(token)],
    );
    const agent = result.rows[0];

    await monitoring.logEvent(
      "agent_adopted",
      `Adopted external ${runtimeFamily} runtime "${name}" at ${endpoint.host}:${endpoint.port}`,
      agentAuditMetadata(req, agent, {
        adopt: {
          runtimeFamily,
          deployTarget: "external",
          endpoint: `${endpoint.host}:${endpoint.port}`,
        },
      }),
    );

    res.status(201).json(serializeAgent(agent));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
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

    const sourceAgent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
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
    await assertRuntimeTargetAvailable(runtimeFields, req.user.id);
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
       execution_target_id, sandbox_profile
     ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
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
        runtimeFields.execution_target_id,
        runtimeFields.sandbox_profile,
      ],
    );
    const agent = inserted.rows[0];

    agentVersions.recordVersionBestEffort(agent.id, templatePayload, {
      createdBy: req.user.id,
      message: `Duplicated from "${sourceAgent.name}"`,
      source: "duplicate",
    });

    await materializeTemplateWiring(agent.id, templatePayload);
    await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);
    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      plan: limits.subscription.plan,
      backend: runtimeFields.backend_type,
      execution_target_id: runtimeFields.execution_target_id,
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
          executionTargetId: runtimeFields.execution_target_id,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
    );

    res.json(serializeAgent(agent));
  }),
);

router.post("/:id/start", async (req, res, next) => {
  try {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!containerManager.canMutate(agent))
      return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.start(agent);

    // Manual start is an explicit operator override of a budget pause; the
    // budget sweep re-pauses on its next cycle if the agent is still over cap.
    const updated = await db.query(
      "UPDATE agents SET status = 'running', paused_reason = NULL WHERE id = $1 RETURNING *",
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
    next(e);
  }
});

router.post("/:id/stop", async (req, res, next) => {
  try {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });

    if (containerManager.canMutate(agent)) {
      try {
        await containerManager.stop(agent);
      } catch (e) {
        if (!isIgnorableStopError(e)) {
          console.error("Container stop error:", e.message);
          if (containerManager.isKubernetesAgent(agent)) {
            return res.status(e.statusCode || 500).json({ error: e.message });
          }
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
    next(e);
  }
});

async function destroyAgent(agentId, userId, req, res) {
  const agent = await findAccessibleAgent(agentId, userId, "viewer");
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (agent.user_id !== userId) {
    return res.status(403).json({
      error:
        "Only the direct agent owner can delete this agent. Remove the workspace assignment instead.",
    });
  }
  res.locals.auditContext = buildAgentContext(agent, {
    ownerEmail: req.user.email || null,
  });

  if (containerManager.canDestroy(agent)) {
    try {
      await containerManager.destroy(agent);
    } catch (e) {
      console.error("Container cleanup error:", e.message);
      if (containerManager.isKubernetesAgent(agent)) {
        return res.status(e.statusCode || 500).json({
          error:
            e.message ||
            "Failed to delete Kubernetes runtime resources; agent record was kept for retry.",
        });
      }
    }
  }

  // Free the agent's reserved gateway port. The FK is ON DELETE CASCADE so the
  // hard delete below already releases it, but release explicitly so the
  // allocation can't leak if agent deletion ever becomes a soft-delete.
  await releaseGatewayPort(agent.id).catch(() => {});
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

router.post("/:id/delete", async (req, res, next) => {
  try {
    await destroyAgent(req.params.id, req.user.id, req, res);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await destroyAgent(req.params.id, req.user.id, req, res);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/restart", async (req, res, next) => {
  try {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!containerManager.canMutate(agent))
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
    next(e);
  }
});

router.post("/:id/redeploy", async (req, res) => {
  try {
    const requestBody = req.body || {};
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
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
    await assertRuntimeTargetAvailable(runtimeFields, req.user.id);
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
              execution_target_id = $6,
              sandbox_profile = $7,
              container_name = $8,
              image = $9
        WHERE id = $1`,
      [
        agent.id,
        runtimeFields.backend_type,
        runtimeFields.sandbox_type,
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.execution_target_id,
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
      execution_target_id: runtimeFields.execution_target_id,
      sandbox: runtimeFields.sandbox_profile,
      specs: { vcpu: agent.vcpu || 2, ram_mb: agent.ram_mb || 2048, disk_gb: agent.disk_gb || 20 },
      container_name: containerName,
      previous_container_id: agent.container_id || null,
      previous_container_name: agent.container_name || null,
      previous_host: agent.host || null,
      previous_backend: currentRuntimeFields.backend_type,
      previous_runtime_family: currentRuntimeFields.runtime_family,
      previous_deploy_target: currentRuntimeFields.deploy_target,
      previous_execution_target_id: currentRuntimeFields.execution_target_id,
      previous_sandbox_profile: currentRuntimeFields.sandbox_profile,
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
          executionTargetId: runtimeFields.execution_target_id,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
    );

    res.json({ success: true, status: "queued" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── Per-agent budget caps ────────────────────────────────────────────────────
// Budgets pause the runtime when spend crosses 100% of a period's limit; the
// list endpoint attaches current spend so the UI renders cap-vs-spend directly.

router.get(
  "/:id/budget",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json({
      budgets: await agentBudgets.listBudgetsWithSpend(agent.id),
      pausedReason: agent.paused_reason || null,
    });
  }),
);

router.put(
  "/:id/budget",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    const budget = await agentBudgets.upsertBudget(agent.id, req.body || {});
    await monitoring.logEvent(
      "agent.budget_updated",
      `Budget set on agent "${agent.name}": $${budget.limitUsd.toFixed(2)}/${budget.period} (warn at ${budget.softThresholdPct}%)`,
      agentAuditMetadata(req, agent, {
        result: {
          budgetId: budget.id,
          period: budget.period,
          limitUsd: budget.limitUsd,
          softThresholdPct: budget.softThresholdPct,
        },
      }),
    );
    res.json(budget);
  }),
);

router.delete(
  "/:id/budget/:budgetId",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    const deleted = await agentBudgets.deleteBudget(req.params.budgetId, agent.id);
    if (!deleted) return res.status(404).json({ error: "Budget not found" });
    await monitoring.logEvent(
      "agent.budget_removed",
      `Budget removed from agent "${agent.name}"`,
      agentAuditMetadata(req, agent, { result: { budgetId: req.params.budgetId } }),
    );
    res.json({ success: true });
  }),
);

// ── Scheduled runs (recurring cron triggers) ─────────────────────────────────

router.get(
  "/:id/schedules",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(await agentSchedules.listSchedules(agent.id));
  }),
);

router.post(
  "/:id/schedules",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, { ownerEmail: req.user.email || null });
    let schedule;
    try {
      schedule = await agentSchedules.createSchedule(agent.id, req.user.id, req.body || {});
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
    await monitoring.logEvent(
      "agent.schedule_created",
      `Schedule "${schedule.name}" (${schedule.action_type}, ${schedule.cron} ${schedule.timezone}) created on agent "${agent.name}"`,
      agentAuditMetadata(req, agent, {
        result: { scheduleId: schedule.id, actionType: schedule.action_type, cron: schedule.cron },
      }),
    );
    res.status(201).json(schedule);
  }),
);

router.put(
  "/:id/schedules/:scheduleId",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, { ownerEmail: req.user.email || null });
    let schedule;
    try {
      schedule = await agentSchedules.updateSchedule(
        agent.id,
        req.params.scheduleId,
        req.body || {},
      );
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
    if (!schedule) return res.status(404).json({ error: "Schedule not found" });
    await monitoring.logEvent(
      "agent.schedule_updated",
      `Schedule "${schedule.name}" updated on agent "${agent.name}"`,
      agentAuditMetadata(req, agent, {
        result: { scheduleId: schedule.id, enabled: schedule.enabled },
      }),
    );
    res.json(schedule);
  }),
);

router.delete(
  "/:id/schedules/:scheduleId",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, { ownerEmail: req.user.email || null });
    const deleted = await agentSchedules.deleteSchedule(agent.id, req.params.scheduleId);
    if (!deleted) return res.status(404).json({ error: "Schedule not found" });
    await monitoring.logEvent(
      "agent.schedule_removed",
      `Schedule removed from agent "${agent.name}"`,
      agentAuditMetadata(req, agent, { result: { scheduleId: req.params.scheduleId } }),
    );
    res.json({ success: true });
  }),
);

router.get(
  "/:id/schedules/:scheduleId/runs",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    // Runs are recorded as agent.schedule.run events (audit-integrated).
    const result = await db.query(
      `SELECT type, message, metadata, created_at
         FROM events
        WHERE type = 'agent.schedule.run'
          AND metadata #>> '{result,scheduleId}' = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.params.scheduleId, limit],
    );
    res.json(result.rows);
  }),
);

// ── Agent versions + rollback ────────────────────────────────────────────────

router.get(
  "/:id/versions",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json(await agentVersions.listVersions(agent.id, { limit }));
  }),
);

router.get(
  "/:id/versions/:versionId",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const version = await agentVersions.getVersion(agent.id, req.params.versionId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    res.json(version);
  }),
);

// Rollback restores the prior config to the agent's current row and triggers
// a redeploy so the running container picks up the change. The current
// configuration is captured as a new version first so the rollback itself is
// reversible. requires editor role on the agent.
router.post(
  "/:id/rollback/:versionId",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgent(req.params.id, req.user.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const target = await agentVersions.getVersion(agent.id, req.params.versionId);
    if (!target) return res.status(404).json({ error: "Version not found" });

    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });

    // Snapshot the current state first so rollback is itself reversible.
    const currentResult = await db.query("SELECT template_payload FROM agents WHERE id = $1", [
      agent.id,
    ]);
    const currentPayload = currentResult.rows[0]?.template_payload || {};
    await agentVersions.recordVersionBestEffort(agent.id, currentPayload, {
      createdBy: req.user.id,
      message: `Pre-rollback snapshot (rolling back to v${target.versionNumber})`,
      source: "rollback",
    });

    // Replace the agent's template_payload with the target version.
    await db.query("UPDATE agents SET template_payload = $1::jsonb WHERE id = $2", [
      JSON.stringify(target.config),
      agent.id,
    ]);

    // Record the rolled-back state as the new "current" version.
    const restored = await agentVersions.recordVersion(agent.id, target.config, {
      createdBy: req.user.id,
      message: `Rolled back to v${target.versionNumber}`,
      source: "rollback",
    });

    // Re-materialize wiring + queue redeploy if the agent has a container.
    try {
      await materializeTemplateWiring(agent.id, target.config);
    } catch (err) {
      console.warn(`[agents.rollback] wiring materialize failed: ${err.message}`);
    }
    if (agent.container_id) {
      // Validate the agent's execution target is still deployable before
      // queuing the redeploy — a remote host / k8s cluster may have been
      // removed or disconnected since the original deploy. Owner-scoped to the
      // agent's owner (an editor may trigger the rollback). Fail before we
      // clear container_id so a rejected rollback leaves the agent intact.
      await assertRuntimeTargetAvailable(
        buildAgentRuntimeFields(agent),
        agent.user_id || req.user.id,
      );
      await db.query(
        `UPDATE agents
            SET status = 'queued',
                container_id = NULL
          WHERE id = $1`,
        [agent.id],
      );
      await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);
      await addDeploymentJob({
        id: agent.id,
        name: agent.name,
        userId: req.user.id,
        backend: agent.backend_type,
        sandbox: agent.sandbox_profile,
        specs: {
          vcpu: agent.vcpu || 2,
          ram_mb: agent.ram_mb || 2048,
          disk_gb: agent.disk_gb || 20,
        },
        container_name: agent.container_name,
        image: agent.image,
      });
    }

    await monitoring.logEvent(
      "agent_rolled_back",
      `Agent "${agent.name}" rolled back to v${target.versionNumber}`,
      agentAuditMetadata(req, agent, {
        rollback: {
          targetVersionId: target.id,
          targetVersionNumber: target.versionNumber,
          newVersionNumber: restored.versionNumber,
        },
      }),
    );

    res.json({
      success: true,
      restored,
      redeployed: Boolean(agent.container_id),
    });
  }),
);

module.exports = router;
