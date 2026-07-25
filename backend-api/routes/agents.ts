// @ts-nocheck
const express = require("express");
const { Client } = require("pg");
const db = require("../db");
const { encrypt, decrypt } = require("../crypto");
const { addDeploymentJob, cancelDeploymentJobsForAgent } = require("../redisQueue");
const billing = require("../billing");
const llmProviders = require("../llmProviders");
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
  stripInternalTemplateMetadata,
} = require("../agentPayloads");
const {
  attachDraftToAgent,
  getOwnedMigrationDraft,
  materializeManagedMigrationState,
} = require("../agentMigrations");
const { isGatewayAvailableStatus, reconcileAgentStatus } = require("../agentStatus");
const {
  assertExternalEndpointReachable,
  assertStrongExternalGatewayToken,
} = require("../gatewayProxy");
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
const { deriveHermesDashboardBasicAuth } = require("../../agent-runtime/lib/hermesDashboardAuth");
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
const {
  isProviderAuthStatusHoldReason,
  runContainerCommand,
  resumeAgentWithProviderAuth,
  syncAuthToUserAgents,
} = require("../authSync");
const {
  apiKeyWorkspaceId,
  findAccessibleAgentForRequest,
  requireApiKeyAgentScope,
} = require("../middleware/ownership");
const { requireSession, scopeByMethod } = require("../middleware/auth");
const agentVersions = require("../agentVersions");
const { assertKubernetesExecutionTargetAvailable } = require("../kubernetesClusters");
const {
  assertRemoteHostAgentUse,
  assertRemoteHostExecutionTargetAvailable,
} = require("../remoteHosts");
const { releaseGatewayPort } = require("../portAllocations");
const { buildPostgresConfig } = require("../lib/connectionConfig");
const {
  acquireAgentProvisionLock,
  buildReplacementDeploymentJob,
  enqueueReplacementDeployment: enqueueReplacementDeploymentWithLock,
} = require("../agentProvisionLock");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("agent"));
const coreAgentScope = scopeByMethod("agents:read", "agents:write");
const ROUTE_SPECIFIC_SCOPE_SEGMENTS = new Set([
  "backups",
  "channels",
  "cost",
  "export",
  "files",
  "integrations",
  "mcp-servers",
  "metrics",
]);

// Core agent routes use agents:read/write. Nested resources with their own
// public scope contract must reach that router without accidentally requiring
// both scopes. Session-only backup, export, and live-filesystem routes likewise
// need to return their explicit session_required result without a scope or DB lookup.
router.use((req, res, next) => {
  if (req.apiKey) {
    const segments = String(req.path || "")
      .split("/")
      .filter(Boolean);
    if (
      segments[0] === "activate-demo" ||
      (segments.length > 1 && ROUTE_SPECIFIC_SCOPE_SEGMENTS.has(segments[1]))
    ) {
      return next();
    }
  }
  return coreAgentScope(req, res, next);
});
router.param("id", requireApiKeyAgentScope("id"));

const DEMO_ACTIVATION_MARKER = "local-docker-demo-v1";

async function enqueueReplacementDeployment(agent, jobData, options = {}) {
  return enqueueReplacementDeploymentWithLock(agent, jobData, {
    queryable: db,
    cancelDeploymentJobsForAgent,
    addDeploymentJob,
    acquireLock: acquireAgentProvisionLock,
    ...options,
  });
}

function createAgentNotFoundError() {
  const error = new Error("Agent not found");
  error.statusCode = 404;
  return error;
}

function createApiKeyWorkspaceBindingError() {
  const error = new Error("API key has no workspace binding");
  error.statusCode = 403;
  error.code = "wrong_workspace";
  return error;
}

async function insertAgentForRequest(req, insertSql, params) {
  if (!req.apiKey) return db.query(insertSql, params);

  const workspaceId = apiKeyWorkspaceId(req);
  if (!workspaceId) throw createApiKeyWorkspaceBindingError();
  const workspaceParam = `$${params.length + 1}`;
  return db.query(
    `WITH created_agent AS (
       ${insertSql}
     ), workspace_assignment AS (
       INSERT INTO workspace_agents(workspace_id, agent_id, role)
       SELECT ${workspaceParam}, id, 'member'
         FROM created_agent
       RETURNING agent_id
     )
     SELECT created_agent.*
       FROM created_agent
       JOIN workspace_assignment ON workspace_assignment.agent_id = created_agent.id`,
    [...params, workspaceId],
  );
}

function assertLifecycleNotProvisioning(agent) {
  if (!["queued", "deploying"].includes(agent?.status)) return;
  const error = new Error(
    "Agent deployment is queued or in progress. Wait for provisioning to finish before changing lifecycle state.",
  );
  error.statusCode = 409;
  error.code = "AGENT_PROVISIONING_IN_PROGRESS";
  throw error;
}

async function withAccessibleAgentLifecycleLock(
  { agentId, req, role = "editor", applicationName },
  callback,
) {
  const visible = await findAccessibleAgentForRequest(req, agentId, role);
  if (!visible) throw createAgentNotFoundError();

  const provisionLock = await acquireAgentProvisionLock(agentId, { applicationName });
  try {
    const agent = await findAccessibleAgentForRequest(req, agentId, role);
    if (!agent) throw createAgentNotFoundError();
    assertLifecycleNotProvisioning(agent);
    return await callback(agent);
  } finally {
    await provisionLock.release();
  }
}

function createDemoActivationLockClient() {
  const {
    max: _max,
    idleTimeoutMillis: _idleTimeoutMillis,
    ...clientConfig
  } = buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: "nora-backend-demo-activation",
  });
  return new Client(clientConfig);
}

function demoActivationJobId(agentId) {
  return `demo-activation-${agentId}`;
}

function buildDemoDeploymentJob(agent, userId, demoProviderId, plan = "selfhosted") {
  return {
    id: agent.id,
    name: agent.name,
    userId,
    plan,
    backend: agent.backend_type || agent.deploy_target || "docker",
    execution_target_id: agent.execution_target_id || "docker",
    sandbox: agent.sandbox_profile || agent.sandbox_type || "standard",
    specs: {
      vcpu: agent.vcpu,
      ram_mb: agent.ram_mb,
      disk_gb: agent.disk_gb,
    },
    container_name: agent.container_name,
    image: agent.image,
    model: null,
    migration_draft_id: null,
    clawhub_skills: [],
    llm_provider_id: demoProviderId,
  };
}

async function ensureDemoDeploymentQueued(agent, userId, demoProviderId, plan, queryable = db) {
  if (!agent) return agent;

  let deploymentAgent = agent;
  if (agent.status === "error") {
    const provisionLock = await acquireAgentProvisionLock(agent.id, {
      applicationName: "nora-backend-demo-activation-retry",
    });
    let resetPerformed = false;
    try {
      const currentResult = await queryable.query("SELECT * FROM agents WHERE id = $1", [agent.id]);
      const currentAgent = currentResult.rows[0];
      if (!currentAgent) throw createAgentNotFoundError();
      if (currentAgent.status !== "error") return currentAgent;
      agent = currentAgent;

      const canceledJobs = await cancelDeploymentJobsForAgent(agent.id);
      if (canceledJobs.active > 0) {
        const error = new Error(
          "The previous demo deployment is still finishing. Try again shortly.",
        );
        error.statusCode = 409;
        throw error;
      }
      const hasRuntimeIdentity = [agent.container_id, agent.container_name].some(
        (value) => value != null && String(value).trim() !== "",
      );
      if (hasRuntimeIdentity && !containerManager.canDestroy(agent)) {
        const error = new Error(
          "The failed demo runtime identity cannot be cleaned up safely. Remove it manually before retrying activation.",
        );
        error.code = "DEMO_RUNTIME_CLEANUP_UNAVAILABLE";
        error.statusCode = 409;
        throw error;
      }
      if (hasRuntimeIdentity) {
        await containerManager.destroy(agent);
      }
      const reset = await queryable.query(
        `UPDATE agents
            SET status = 'queued',
                container_id = NULL,
                container_name = NULL,
                host = NULL,
                runtime_host = NULL,
                runtime_port = NULL,
                gateway_host = NULL,
                gateway_port = NULL,
                gateway_host_port = NULL,
                gateway_token = NULL
          WHERE id = $1
            AND status = 'error'
            AND container_id IS NOT DISTINCT FROM $2
            AND container_name IS NOT DISTINCT FROM $3
            AND host IS NOT DISTINCT FROM $4
          RETURNING *`,
        [agent.id, agent.container_id || null, agent.container_name || null, agent.host || null],
      );
      if (!reset.rows[0]) {
        const error = new Error("The demo runtime changed while activation was being retried");
        error.code = "DEMO_RUNTIME_STATE_CHANGED";
        error.statusCode = 409;
        throw error;
      }
      resetPerformed = true;
      deploymentAgent = reset.rows[0];
      await queryable.query("UPDATE deployments SET status = 'queued' WHERE agent_id = $1", [
        agent.id,
      ]);

      await addDeploymentJob(
        buildDemoDeploymentJob(deploymentAgent, userId, demoProviderId, plan),
        {
          jobId: demoActivationJobId(deploymentAgent.id),
        },
      );
      return deploymentAgent;
    } catch (error) {
      if (resetPerformed) {
        const compensation = await Promise.allSettled([
          queryable.query(
            "UPDATE agents SET status = 'error' WHERE id = $1 AND status = 'queued'",
            [agent.id],
          ),
          queryable.query(
            "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'",
            [agent.id],
          ),
        ]);
        const compensationFailure = compensation.find((result) => result.status === "rejected");
        if (compensationFailure) error.compensationError = compensationFailure.reason;
      }
      throw error;
    } finally {
      await provisionLock.release();
    }
  }

  if (!["queued", "deploying"].includes(deploymentAgent.status)) return deploymentAgent;
  await addDeploymentJob(buildDemoDeploymentJob(deploymentAgent, userId, demoProviderId, plan), {
    jobId: demoActivationJobId(deploymentAgent.id),
  });
  return deploymentAgent;
}

async function reconcileReadyDemoAgent(agent, userId) {
  if (!agent || !["running", "warning", "stopped"].includes(agent.status)) return agent;

  const results = await syncAuthToUserAgents(userId, agent.id, {
    providerLockHeld: true,
  });
  const result = results.find((entry) => entry?.agentId === agent.id);
  if (result?.status !== "synced") {
    const error = new Error(
      "The demo provider was restored, but the existing demo runtime could not be reconciled",
    );
    error.statusCode = 502;
    error.code = "DEMO_PROVIDER_RECONCILIATION_FAILED";
    error.syncResult = result || null;
    throw error;
  }

  return agent;
}

function demoActivationMarkerPayload() {
  return JSON.stringify({ metadata: { activation: DEMO_ACTIVATION_MARKER } });
}

async function findDemoActivationAgent(queryable, userId) {
  const result = await queryable.query(
    `SELECT *
       FROM agents
      WHERE user_id = $1
        AND template_payload @> $2::jsonb
        AND runtime_family = 'openclaw'
        AND deploy_target = 'docker'
        AND execution_target_id = 'docker'
        AND sandbox_profile = 'standard'
        AND backend_type = 'docker'
      ORDER BY created_at, id
      LIMIT 1`,
    [userId, demoActivationMarkerPayload()],
  );
  return result.rows[0] || null;
}

async function assertLocalDockerAvailable() {
  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    if (typeof docker.ping !== "function") {
      throw new Error("Docker client does not expose ping()");
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error("Timed out while checking the local Docker daemon")),
        3000,
      );
      try {
        docker.ping((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  } catch (error) {
    console.warn("[agents.activate-demo] Local Docker is unavailable:", error.message);
    const unavailable = new Error(
      "Local Docker is unavailable. Start Docker and make sure Nora can access /var/run/docker.sock, then try again.",
    );
    unavailable.statusCode = 503;
    unavailable.code = "LOCAL_DOCKER_UNAVAILABLE";
    throw unavailable;
  }
}

async function removeFailedDemoActivation(queryable, agentId, userId) {
  await queryable.query("BEGIN");
  try {
    await queryable.query("DELETE FROM deployments WHERE agent_id = $1", [agentId]);
    await queryable.query("DELETE FROM agents WHERE id = $1 AND user_id = $2", [agentId, userId]);
    await queryable.query("COMMIT");
  } catch (error) {
    await queryable.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Resolve the image Nora should deploy for a requested runtime selection,
 * preferring an explicit override, then the current image when the runtime path
 * is unchanged, and finally the runtime-family default image.
 *
 * @param {Object} [options={}] - Requested and fallback image/runtime inputs.
 * @returns {string|null} Image Nora should persist for the agent.
 */
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

/**
 * Validate that the requested runtime selection is enabled and fully
 * configured on this Nora control plane.
 *
 * @param {Object} runtimeFields - Requested runtime/backend selection fields.
 * @returns {Object} Runtime-selection status when the request is allowed.
 */
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

/**
 * Validate the requested runtime path and ensure any Kubernetes or Remote
 * Docker execution target is available to the owning user.
 *
 * @param {Object} runtimeFields - Requested runtime/backend selection fields.
 * @param {string} ownerUserId - User id used to validate remote-host-backed execution targets.
 * @returns {Promise<Object>} Runtime-selection status for the validated target.
 */
async function assertRuntimeTargetAvailable(runtimeFields, ownerUserId) {
  const status = assertRuntimeSelectionAvailable(runtimeFields);
  await assertKubernetesExecutionTargetAvailable(runtimeFields);
  await assertRemoteHostExecutionTargetAvailable(runtimeFields, { ownerUserId });
  return status;
}

function requireSessionForRemoteDockerPlacement(req, res, ...runtimeSelections) {
  const targetsRemoteDocker = runtimeSelections.some(
    (runtimeFields) => runtimeFields?.deploy_target === "remote-docker",
  );
  if (!req.apiKey || !targetsRemoteDocker) return true;

  res.status(403).json({
    error: "Remote Docker placement requires session authentication",
    code: "session_required",
  });
  return false;
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

/**
 * Determine the externally reachable gateway host Nora should publish for an
 * agent, preferring explicit env configuration before request headers.
 *
 * @param {Object} req - Express request used to inspect forwarded host headers.
 * @returns {string} Hostname Nora should expose in agent gateway URLs.
 */
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

/**
 * Determine the externally reachable gateway protocol Nora should publish for
 * an agent, preferring explicit env configuration before request headers.
 *
 * @param {Object} req - Express request used to inspect forwarded protocol headers.
 * @returns {string} `https` or `http` for published gateway URLs.
 */
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

// Runtime API port inside the Hermes container (Nora's compose network talks
// to this via runtime_host:runtime_port; this constant is only used to look
// up the matching HOST-published port binding below).
const HERMES_RUNTIME_PORT = 8642;

// Externally-reachable connect info for Hermes Desktop / direct clients on a
// LOCAL Docker agent. Nora's own traffic uses the compose-network address
// (runtime_host:runtime_port); this is the host-published address instead:
//   runtime API  -> DOCKER_AGENT_BIND_IP:<published 8642 host port>
//   dashboard    -> DOCKER_AGENT_BIND_IP:<published 9119 host port>
// Both host ports are read by inspecting the live container bindings (never
// persisted — persisting the dashboard host port would corrupt the embed
// proxy's resolveHermesDashboardAddress). The host shown to the operator is
// whatever they browsed Nora on (X-Forwarded-Host / GATEWAY_HOST), matching
// the OpenClaw ui-info pattern.
// A published-port HostIp is usable as the advertised connect host only when it
// is a concrete routable address. Docker's bind-all (0.0.0.0 / ::) and loopback
// addresses tell us nothing about where an external client should connect, so
// those fall back to the browsing-host heuristic.
function isRoutablePublishHostIp(hostIp) {
  const ip = String(hostIp || "").trim();
  if (!ip) return false;
  if (ip === "0.0.0.0" || ip === "::" || ip === "[::]") return false;
  if (ip === "localhost" || ip === "::1" || ip === "[::1]") return false;
  if (/^127\./.test(ip)) return false;
  return true;
}

function formatHostForUrl(host) {
  // Bracket IPv6 literals so their colons don't collide with the port separator.
  return require("net").isIP(host) === 6 ? `[${host}]` : host;
}

async function resolveHermesConnectInfo(agent, req) {
  // The connect block carries the decrypted runtime API key, so it is a
  // management capability rather than ordinary status metadata. Keep the
  // shared Hermes status route intact while omitting durable credentials for
  // non-owner workspace members and control-plane API keys.
  if (req?.apiKey || agent?.effective_role !== "owner") return null;

  const runtimeFields = buildAgentRuntimeFields(agent);
  if (runtimeFields.runtime_family !== "hermes") return null;
  if (runtimeFields.deploy_target !== "docker") return null;
  if (!agent.container_id) return null;

  let runtimeApiHostPort = null;
  let dashboardHostPort = null;
  let runtimeHostIp = null;
  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const info = await docker.getContainer(agent.container_id).inspect();
    const ports = info.NetworkSettings?.Ports || {};
    const runtimeBinding = ports[`${HERMES_RUNTIME_PORT}/tcp`];
    const dashboardBinding = ports[`${HERMES_DASHBOARD_PORT}/tcp`];
    runtimeApiHostPort = runtimeBinding?.[0]?.HostPort
      ? parseInt(runtimeBinding[0].HostPort, 10)
      : null;
    dashboardHostPort = dashboardBinding?.[0]?.HostPort
      ? parseInt(dashboardBinding[0].HostPort, 10)
      : null;
    // The interface the ports are actually bound to (DOCKER_AGENT_BIND_IP).
    runtimeHostIp = runtimeBinding?.[0]?.HostIp || null;
  } catch (err) {
    console.warn(
      `[hermes-connect] Could not inspect published ports for agent ${agent.id}: ${err.message}`,
    );
    return null;
  }

  // No published runtime API port means the operator has not exposed it
  // (DOCKER_AGENT_BIND_IP not set to a routable interface, or ports absent).
  if (!runtimeApiHostPort) return null;

  const proto = resolvePublishedGatewayProtocol(req);
  // Prefer the actual publish interface (source of truth) when it is routable;
  // otherwise fall back to the browsing-host heuristic (loopback default / the
  // remote 0.0.0.0 variant, where the bind IP doesn't identify a reachable host).
  const host = isRoutablePublishHostIp(runtimeHostIp)
    ? formatHostForUrl(runtimeHostIp)
    : resolvePublishedGatewayHost(req);
  const apiKey = await resolveHermesApiToken(agent);

  return {
    runtimeApiUrl: `${proto}://${host}:${runtimeApiHostPort}`,
    dashboardUrl: dashboardHostPort ? `${proto}://${host}:${dashboardHostPort}` : null,
    apiKey: apiKey || null,
  };
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

/**
 * Normalize and deduplicate the ClawHub-installed-skill metadata Nora stores on
 * an agent row.
 *
 * @param {Array} entries - Raw installed-skill entries from the request or DB.
 * @returns {Array} Stable list of normalized ClawHub skill descriptors.
 */
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
    const listOptions = { scope };
    if (req.apiKey) {
      const workspaceId = apiKeyWorkspaceId(req);
      if (!workspaceId) {
        return res
          .status(403)
          .json({ error: "API key has no workspace binding", code: "wrong_workspace" });
      }
      listOptions.workspaceId = workspaceId;
    }
    const agents = await workspaces.listAccessibleAgents(req.user.id, listOptions);
    res.json(agents.map(serializeAgent));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    let runtimeStatus = null;

    // Live status reconciliation — check actual container state while preserving
    // warning as a first-class degraded state until the container actually stops.
    if (
      containerManager.canMutate(agent) &&
      !isProviderAuthStatusHoldReason(agent.paused_reason) &&
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
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

/**
 * Load an agent for Hermes WebUI endpoints and enforce the extra runtime-state
 * invariants those routes rely on.
 *
 * @param {Object} req - Express request carrying the target `:id` and user context.
 * @param {Object} [options={}] - Access requirements for the lookup.
 * @returns {Promise<Object>} Accessible Hermes agent ready for downstream WebUI actions.
 */
async function loadHermesUiAgent(req, { requiredRole = "viewer" } = {}) {
  const agent = await findAccessibleAgentForRequest(req, req.params.id, requiredRole);
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

  // Hermes status, chat, cron, channel, and dashboard routes can use runtime
  // bearer credentials or the remote host directly. Agent ownership alone is
  // not a durable capability after a workspace host share is revoked.
  await assertRemoteHostAgentUse(agent, { includeProfile: false });

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

function buildHermesDashboardEnsureCommand(dashboardAuth = null) {
  const lines = [
    'HERMES_BIN="/opt/hermes/.venv/bin/hermes"',
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || true)"',
    'if [ -z "$HERMES_BIN" ]; then echo "STATUS=missing-cli"; exit 0; fi',
    'VERSION="$("$HERMES_BIN" version 2>/dev/null | head -n 1 || true)"',
    'if ! "$HERMES_BIN" --help 2>/dev/null | grep -q "dashboard"; then echo "STATUS=missing-dashboard"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi',
    `if python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);rc=s.connect_ex(("127.0.0.1",${HERMES_DASHBOARD_PORT}));s.close();sys.exit(0 if rc==0 else 1)'; then echo "STATUS=already-running"; printf "VERSION=%s\\n" "$VERSION"; exit 0; fi`,
    'if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1; then setsid gosu hermes "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open < /dev/null & else setsid "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open < /dev/null & fi',
    "started=0",
    `for _attempt in 1 2 3 4 5; do if python3 -c 'import socket,sys;s=socket.socket();s.settimeout(1);rc=s.connect_ex(("127.0.0.1",${HERMES_DASHBOARD_PORT}));s.close();sys.exit(0 if rc==0 else 1)'; then started=1; break; fi; sleep 1; done`,
    'if [ "$started" = "1" ]; then echo "STATUS=started"; else echo "STATUS=start-failed"; fi',
    'printf "VERSION=%s\\n" "$VERSION"',
  ];
  if (dashboardAuth) {
    // Existing containers created before dashboard-auth support lack the
    // HERMES_DASHBOARD_BASIC_AUTH_* vars in their baked env. Derive them from the
    // agent's gateway_token (control-plane side) and export them here so the
    // relaunched dashboard starts with Hermes's basic-auth provider — letting an
    // existing agent's Web UI work again without a data-losing container recreate.
    lines.unshift(
      `export HERMES_DASHBOARD_BASIC_AUTH_USERNAME='${dashboardAuth.username}'`,
      `export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='${dashboardAuth.password}'`,
      `export HERMES_DASHBOARD_BASIC_AUTH_SECRET='${dashboardAuth.secret}'`,
    );
  }
  return lines.join("; ");
}

async function ensureHermesDashboardProcess(agent) {
  try {
    let dashboardAuth = null;
    try {
      const token = await resolveHermesApiToken(agent);
      if (token) dashboardAuth = deriveHermesDashboardBasicAuth(token);
    } catch (err) {
      console.warn(
        `[hermes-dashboard] could not derive dashboard auth for agent ${agent.id}: ${err.message}`,
      );
    }
    const { output } = await runContainerCommand(
      agent,
      buildHermesDashboardEnsureCommand(dashboardAuth),
      { timeout: 15000 },
    );
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
  // Re-check at the credential-use boundary as defense in depth. This closes
  // the race between the shared route loader and a later runtime request.
  await assertRemoteHostAgentUse(agent, { includeProfile: false });
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
  await assertRemoteHostAgentUse(agent, { includeProfile: false });
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

    const connect = await resolveHermesConnectInfo(agent, req);

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
      ...(connect ? { connect } : {}),
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(await buildAgentStatsResponse(agent));
  }),
);

router.post("/activate-demo", requireSession, async (req, res) => {
  const userId = req.user.id;
  const lockKey = llmProviders.providerMutationLockKey(userId);
  let client;
  let connected = false;
  let lockHeld = false;
  let transactionOpen = false;

  try {
    // The activation lock spans pool-backed capability, billing, scheduler,
    // queue, and audit work. Keep it off the main pool so DB_POOL_MAX=1 does
    // not self-deadlock while the session lock is held.
    client = createDemoActivationLockClient();
    await client.connect();
    connected = true;
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    lockHeld = true;

    // Validate the hard-coded local-Docker demo target before returning or
    // requeueing any durable demo row. This prevents restored demo metadata
    // from bypassing a Kubernetes-only Helm deployment's target policy.
    const runtimeFields = resolveRequestedRuntimeFields({
      request: {
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
      },
    });
    const runtimeSelectionStatus = await assertRuntimeTargetAvailable(runtimeFields, userId);
    await assertLocalDockerAvailable();

    const existingAgent = await findDemoActivationAgent(client, userId);
    if (existingAgent) {
      const demoProvider = await llmProviders.ensureDemoProvider(userId, client);
      const activatedAgent = await ensureDemoDeploymentQueued(
        existingAgent,
        userId,
        demoProvider.id,
        undefined,
        client,
      );
      await reconcileReadyDemoAgent(activatedAgent, userId);
      return res.json(serializeAgent(activatedAgent));
    }

    const limits = await billing.enforceLimits(userId);
    if (!limits.allowed) {
      return res.status(402).json({
        error: limits.error,
        subscription: limits.subscription,
      });
    }

    const name = "Demo Agent";
    const deploymentDefaults = await getDeploymentDefaults();
    const specs = billing.IS_PAAS
      ? deploymentDefaults
      : clampDeploymentDefaults(
          normalizeDeploymentDefaults({}, deploymentDefaults),
          billing.SELFHOSTED_LIMITS,
        );
    const node = await scheduler.selectNode({ fallback: runtimeFields.deploy_target });
    const nodeName = node ? node.name : runtimeFields.deploy_target;
    const containerName = resolveContainerName({
      agentName: name,
      runtimeSelection: runtimeFields,
    });
    const image = resolveRequestedImage({ runtimeFields });
    const templatePayload = ensureCoreTemplateFiles(
      createEmptyTemplatePayload({
        source: "demo-activation",
        activation: DEMO_ACTIVATION_MARKER,
      }),
      {
        name,
        sourceType: "platform",
        includeBootstrap: true,
      },
    );

    await client.query("BEGIN");
    transactionOpen = true;
    const demoProvider = await llmProviders.ensureDemoProvider(userId, client);
    const result = await client.query(
      `INSERT INTO agents(
         user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
         container_name, image, template_payload, clawhub_skills, runtime_family, deploy_target,
         execution_target_id, sandbox_profile
       ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, '[]'::jsonb, $12, $13, $14, $15)
       RETURNING *`,
      [
        userId,
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
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.execution_target_id,
        runtimeFields.sandbox_profile,
      ],
    );
    const agent = result.rows[0];
    await client.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [
      agent.id,
    ]);
    await client.query("COMMIT");
    transactionOpen = false;

    try {
      await ensureDemoDeploymentQueued(
        agent,
        userId,
        demoProvider.id,
        limits.subscription?.plan || "selfhosted",
      );
    } catch (queueError) {
      try {
        await removeFailedDemoActivation(client, agent.id, userId);
      } catch (cleanupError) {
        console.error(
          `[agents.activate-demo] Failed to remove agent ${agent.id} after queue failure:`,
          cleanupError.message,
        );
      }
      throw queueError;
    }

    try {
      const deployType = `${runtimeSelectionStatus.runtimeFamily}/${runtimeSelectionStatus.deployTarget}/${runtimeSelectionStatus.sandboxProfile}`;
      await monitoring.logEvent(
        "agent_deployed",
        `Agent "${name}" (${deployType}) queued for demo deployment`,
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
            llmProviderId: demoProvider.id,
          },
        }),
      );
    } catch (auditError) {
      console.warn("[agents.activate-demo] Failed to record deploy event:", auditError.message);
    }

    return res.json(serializeAgent(agent));
  } catch (error) {
    if (transactionOpen && client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    return res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (connected && client) {
      if (lockHeld) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
          .catch((error) =>
            console.warn("[agents.activate-demo] Advisory unlock failed:", error.message),
          );
      }
      await client
        .end()
        .catch((error) =>
          console.warn("[agents.activate-demo] Lock connection close failed:", error.message),
        );
    }
  }
});

router.post("/deploy", async (req, res) => {
  try {
    const requestBody = req.body || {};
    const clawhubSkills = normalizeClawhubSkills(requestBody.clawhub_skills);
    let migrationDraft = null;
    if (requestBody.migration_draft_id) {
      if (req.apiKey) {
        return res.status(403).json({
          error: "Migration-draft deployment requires session authentication",
          code: "session_required",
        });
      }
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
    if (!requireSessionForRemoteDockerPlacement(req, res, runtimeFields)) return;
    // Enforce billing only after authorization has rejected session-only
    // Remote Docker placement for workspace API keys.
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed)
      return res.status(402).json({ error: limits.error, subscription: limits.subscription });

    const sub = limits.subscription;
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
    const templatePayload = stripInternalTemplateMetadata(
      migrationDraft
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
            }),
    );

    const result = await insertAgentForRequest(
      req,
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

    const rawToken = String(body.gateway_token || body.token || "").trim();
    if (!rawToken) {
      return res
        .status(400)
        .json({ error: "gateway_token is required to adopt an external runtime" });
    }
    const token = assertStrongExternalGatewayToken(rawToken);

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
    const result = await insertAgentForRequest(
      req,
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    const sourceAgent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    if (!requireSessionForRemoteDockerPlacement(req, res, sourceRuntime, runtimeFields)) return;
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed) {
      return res.status(402).json({ error: limits.error, subscription: limits.subscription });
    }
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

    const inserted = await insertAgentForRequest(
      req,
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
    const result = await withAccessibleAgentLifecycleLock(
      {
        agentId: req.params.id,
        req,
        applicationName: "nora-backend-agent-start",
      },
      async (agent) => {
        res.locals.auditContext = buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        });
        if (!containerManager.canMutate(agent)) {
          const error = new Error("No container — redeploy the agent first");
          error.statusCode = 400;
          throw error;
        }

        // The lifecycle lock is already held here. Provider state remains
        // locked from offline staging through readiness and the final status
        // publish, so a concurrent key rotation cannot race this start.
        const resumed = await resumeAgentWithProviderAuth(agent, "start");

        await monitoring.logEvent(
          "agent_started",
          `Agent "${agent.name}" started`,
          agentAuditMetadata(req, resumed.agent, {
            result: { status: "running" },
          }),
        );
        return serializeAgent(resumed.agent);
      },
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/stop", async (req, res, next) => {
  try {
    const result = await withAccessibleAgentLifecycleLock(
      {
        agentId: req.params.id,
        req,
        applicationName: "nora-backend-agent-stop",
      },
      async (agent) => {
        res.locals.auditContext = buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        });

        if (containerManager.canMutate(agent)) {
          try {
            await containerManager.stop(agent);
          } catch (error) {
            if (!containerManager.isIgnorableStopError(error)) {
              console.error("Container stop error:", error.message);
              throw error;
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
        return serializeAgent(updated.rows[0]);
      },
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
});

async function destroyAgent(agentId, req, res) {
  const visibleAgent = await findAccessibleAgentForRequest(req, agentId, "viewer");
  if (!visibleAgent) return res.status(404).json({ error: "Agent not found" });
  if (visibleAgent.user_id !== req.user.id) {
    return res.status(403).json({
      error:
        "Only the direct agent owner can delete this agent. Remove the workspace assignment instead.",
    });
  }

  const provisionLock = await acquireAgentProvisionLock(visibleAgent.id, {
    applicationName: "nora-backend-agent-delete",
  });
  try {
    // The agent may have been redeployed or its workspace access may have
    // changed while this request waited for an active provisioner. Reload the
    // complete row while holding the shared lock so cleanup always targets the
    // authoritative placement, including a newly created Remote Docker runtime.
    const agent = await findAccessibleAgentForRequest(req, agentId, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({
        error:
          "Only the direct agent owner can delete this agent. Remove the workspace assignment instead.",
      });
    }
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });

    // Remove waiting/delayed retries before deleting the durable row. Holding
    // the provision lock keeps a producer or worker from publishing a new
    // runtime between this cancellation, cleanup, and the durable deletion.
    await cancelDeploymentJobsForAgent(agent.id);

    if (containerManager.canDestroy(agent)) {
      try {
        await containerManager.destroy(agent);
      } catch (error) {
        console.error("Container cleanup error:", error.message);
        return res.status(error.statusCode || 500).json({
          error:
            error.message || "Failed to delete runtime resources; agent record was kept for retry.",
        });
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
    return res.json({ success: true });
  } finally {
    await provisionLock.release();
  }
}

router.post("/:id/delete", async (req, res, next) => {
  try {
    await destroyAgent(req.params.id, req, res);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await destroyAgent(req.params.id, req, res);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/restart", async (req, res, next) => {
  try {
    await withAccessibleAgentLifecycleLock(
      {
        agentId: req.params.id,
        req,
        applicationName: "nora-backend-agent-restart",
      },
      async (agent) => {
        res.locals.auditContext = buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        });
        if (!containerManager.canMutate(agent)) {
          const error = new Error("No container — redeploy the agent first");
          error.statusCode = 400;
          throw error;
        }

        // Auth sync owns the one exact restart. Do not restart once here and a
        // second time during provider reconciliation.
        const resumed = await resumeAgentWithProviderAuth(agent, "restart");
        await monitoring.logEvent(
          "agent_restarted",
          `Agent "${agent.name}" restarted`,
          agentAuditMetadata(req, resumed.agent, {
            result: { status: "running" },
          }),
        );
      },
    );
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/redeploy", async (req, res) => {
  try {
    const requestBody = req.body || {};
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    if (!requireSessionForRemoteDockerPlacement(req, res, currentRuntimeFields, runtimeFields)) {
      return;
    }
    // Workspace editors may trigger a redeploy, but the runtime always belongs
    // to the persisted agent owner. Validate and queue using that owner so the
    // editor's provider credentials can never be selected by the worker.
    await assertRuntimeTargetAvailable(runtimeFields, agent.user_id);
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

    // Preserve the exact previous runtime identity and placement until the
    // provisioner has validated the new target and owns its per-agent lock.
    // This keeps enqueue rejection, deployment-row failure, or target-auth
    // failure cleanup-safe.
    await enqueueReplacementDeployment(
      agent,
      buildReplacementDeploymentJob(agent, {
        runtimeFields,
        containerName,
        image,
      }),
    );

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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(await agentSchedules.listSchedules(agent.id));
  }),
);

router.post(
  "/:id/schedules",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
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
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    // Runs are recorded as agent.schedule.run events (audit-integrated).
    const result = await db.query(
      `SELECT type, message, metadata, created_at
         FROM events
        WHERE type = 'agent.schedule.run'
          AND metadata #>> '{result,scheduleId}' = $1
          AND metadata #>> '{result,agentId}' = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [req.params.scheduleId, agent.id, limit],
    );
    res.json(result.rows);
  }),
);

// ── Agent versions + rollback ────────────────────────────────────────────────

router.get(
  "/:id/versions",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json(await agentVersions.listVersions(agent.id, { limit }));
  }),
);

router.get(
  "/:id/versions/:versionId",
  asyncHandler(async (req, res) => {
    const agent = await findAccessibleAgentForRequest(req, req.params.id, "viewer");
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
    let agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    let currentRuntimeFields = buildAgentRuntimeFields(agent);
    if (!requireSessionForRemoteDockerPlacement(req, res, currentRuntimeFields)) return;
    const target = await agentVersions.getVersion(agent.id, req.params.versionId);
    if (!target) return res.status(404).json({ error: "Version not found" });

    const provisionLock = await acquireAgentProvisionLock(agent.id, {
      applicationName: "nora-backend-agent-rollback",
    });
    let shouldRedeploy = false;
    let restored;
    let currentPayload = null;
    let payloadUpdated = false;
    try {
      // The access check above keeps lock acquisition unavailable to callers
      // who cannot see the agent. Re-read after acquiring the shared lock so a
      // deployment that finished while rollback was waiting cannot make us
      // restore config without redeploying the now-running runtime.
      agent = await findAccessibleAgentForRequest(req, req.params.id, "editor");
      if (!agent) throw createAgentNotFoundError();
      currentRuntimeFields = buildAgentRuntimeFields(agent);
      if (!requireSessionForRemoteDockerPlacement(req, res, currentRuntimeFields)) return;
      res.locals.auditContext = buildAgentContext(agent, {
        ownerEmail: req.user.email || null,
      });
      shouldRedeploy = containerManager.canDestroy(agent);

      let runtimeFields = null;
      if (shouldRedeploy) {
        const canceledJobs = await cancelDeploymentJobsForAgent(agent.id);
        if (canceledJobs.active > 0) {
          return res.status(409).json({
            error:
              "An earlier deployment is still active for this agent. Try rollback again shortly.",
          });
        }
        // Validate while the shared lock is held and before mutating the
        // rollback config. A removed target must leave the current config and
        // runtime identity untouched.
        runtimeFields = currentRuntimeFields;
        await assertRuntimeTargetAvailable(runtimeFields, agent.user_id);
      }

      // Snapshot the current state first so rollback is itself reversible.
      const currentResult = await db.query("SELECT template_payload FROM agents WHERE id = $1", [
        agent.id,
      ]);
      currentPayload = currentResult.rows[0]?.template_payload || {};
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
      payloadUpdated = true;

      // Record the rolled-back state as the new "current" version.
      restored = await agentVersions.recordVersion(agent.id, target.config, {
        createdBy: req.user.id,
        message: `Rolled back to v${target.versionNumber}`,
        source: "rollback",
      });

      // Re-materialize wiring + queue redeploy if the agent has a container.
      await materializeTemplateWiring(agent.id, target.config);
      if (shouldRedeploy) {
        await enqueueReplacementDeployment(
          agent,
          buildReplacementDeploymentJob(agent, {
            runtimeFields,
            containerName: agent.container_name,
            image: agent.image,
          }),
          {
            provisionLock,
            skipCancellation: true,
          },
        );
      }
    } catch (error) {
      if (payloadUpdated) {
        try {
          await db.query("UPDATE agents SET template_payload = $1::jsonb WHERE id = $2", [
            JSON.stringify(currentPayload || {}),
            agent.id,
          ]);
          await materializeTemplateWiring(agent.id, currentPayload || {});
          await agentVersions.recordVersionBestEffort(agent.id, currentPayload || {}, {
            createdBy: req.user.id,
            message: `Rollback to v${target.versionNumber} could not be queued; restored previous config`,
            source: "rollback",
          });
        } catch (compensationError) {
          error.rollbackCompensationError = compensationError;
        }
      }
      throw error;
    } finally {
      await provisionLock.release();
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
      redeployed: shouldRedeploy,
    });
  }),
);

module.exports = router;
module.exports.buildHermesDashboardEnsureCommand = buildHermesDashboardEnsureCommand;
