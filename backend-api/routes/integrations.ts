// @ts-nocheck
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const integrations = require("../integrations");
const llmProviders = require("../llmProviders");
const mcpServers = require("../mcpServers");
const { runtimeAuthHeaders } = require("../runtimeAuth");
const { encrypt, decrypt } = require("../crypto");
const { rpcCall } = require("../gatewayProxy");
const { runContainerCommand, syncAuthToUserAgents } = require("../authSync");
const { buildHermesIntegrationInstallCommand } = require("../integrationRuntimeFiles");
const {
  apiKeyWorkspaceId,
  findAgentForRequest,
  requireAccessibleAgent,
} = require("../middleware/ownership");
const { requireSession, scopeByMethod } = require("../middleware/auth");
const { AGENT_RUNTIME_PORT } = require("../../agent-runtime/lib/contracts");
const { runtimeUrlForAgent } = require("../../agent-runtime/lib/agentEndpoints");
const { resolveAgentRuntimeFamily } = require("../agentRuntimeFields");
const { normalizeEmailConfigInput } = require("../integrations");
const {
  activateWecomForOpenClawAgent,
  deactivateWecomForOpenClawAgent,
  verifyWecomForOpenClawAgent,
} = require("../integrations/providers/wecomActivation");

const router = express.Router();

const TWITTER_OAUTH_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TWITTER_OAUTH_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const TWITTER_OAUTH_ME_URL = "https://api.x.com/2/users/me";
const TWITTER_OAUTH_SCOPES = ["tweet.read", "users.read", "tweet.write", "offline.access"];
const TWITTER_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EMAIL_CRON_PROMPT =
  "Look for any new emails or calendar invites I should be aware of and summarize anything important for me.";
const SINGLETON_INTEGRATION_PROVIDERS = new Set(["wecom"]);

// Email cron lifecycle

/**
 * Register an email check-in cron for a ready agent, retrying gateway failures.
 *
 * @param {Object} agent - Runtime target that owns the cron.
 * @param {string} integrationId - Email integration referenced by the job.
 * @param {Object} pollingIntervalSeconds - Cron config; non-object input uses defaults.
 * @returns {Promise<string|null>} Created cron id, or null when registration is unavailable.
 */
async function registerEmailCronJob(agent, integrationId, pollingIntervalSeconds) {
  if (!agent || !["running", "warning"].includes(agent.status)) return null;
  const cronConfig = normalizeEmailConfigInput({
    cron:
      pollingIntervalSeconds && typeof pollingIntervalSeconds === "object"
        ? pollingIntervalSeconds
        : {},
  }).cron;
  const intervalMinutes = Number.parseInt(String(cronConfig?.intervalMinutes || 60), 10);
  const safeIntervalMinutes =
    Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60;
  const prompt =
    String(cronConfig?.prompt || DEFAULT_EMAIL_CRON_PROMPT).trim() || DEFAULT_EMAIL_CRON_PROMPT;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await rpcCall(agent, "cron.add", {
        name: `email_checkin_${integrationId}`,
        schedule: { kind: "interval", everyMs: safeIntervalMinutes * 60 * 1000 },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: prompt,
          thinking: "minimal",
          lightContext: true,
          timeoutSeconds: 300,
        },
        delivery: { mode: "none" },
        agentId: "main",
      });
      return result?.id || result?.cronId || null;
    } catch (error) {
      if (attempt === 4) {
        console.warn(
          `[email-cron] failed to create cron for integration ${integrationId}: ${error?.message || error}`,
        );
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

async function removeEmailCronJob(agent, cronJobId) {
  if (!agent || !cronJobId) return;
  try {
    await rpcCall(agent, "cron.remove", { id: cronJobId });
  } catch {
    // best-effort; gateway may be unavailable during teardown
  }
}

function extractCronJobs(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.jobs)) return result.jobs;
  return [];
}

function cronJobReferencesIntegration(job, integrationId) {
  if (!job || !integrationId) return false;
  const idText = String(integrationId);
  const name = String(job?.name || "");
  if (name === `email_checkin_${idText}`) return true;

  const payload = job?.payload;
  const message = String(payload?.message || "");
  return message.includes(idText);
}

async function findEmailCronJobIds(agent, integrationId) {
  if (!agent || !integrationId || !["running", "warning"].includes(agent.status)) return [];
  try {
    const result = await rpcCall(agent, "cron.list");
    return extractCronJobs(result)
      .filter((job) => cronJobReferencesIntegration(job, integrationId))
      .map((job) => String(job?.id || job?.cronId || ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function removeEmailCronJobs(agent, cronJobIds = []) {
  const uniqueIds = [...new Set((cronJobIds || []).filter(Boolean))];
  for (const cronJobId of uniqueIds) {
    await removeEmailCronJob(agent, cronJobId);
  }
}

/**
 * Replace an integration's email cron after best-effort removal of its prior job.
 *
 * @param {Object} agent - Runtime target that owns the cron.
 * @param {string} integrationId - Email integration referenced by the job.
 * @param {string|null} previousCronJobId - Previously persisted cron id.
 * @param {Object} pollingIntervalSeconds - Cron config; non-object input uses defaults.
 * @returns {Promise<string|null>} New cron id, or the prior id when replacement fails.
 */
async function reconcileEmailCronJob(
  agent,
  integrationId,
  previousCronJobId,
  pollingIntervalSeconds,
) {
  if (!agent || !integrationId) return previousCronJobId || null;

  if (previousCronJobId) {
    await removeEmailCronJob(agent, previousCronJobId);
  }

  const nextCronJobId = await registerEmailCronJob(agent, integrationId, pollingIntervalSeconds);
  if (!nextCronJobId) return previousCronJobId || null;

  return nextCronJobId;
}

// WeCom activation lifecycle

async function updateWecomActivationState(agentId, integrationId, activation) {
  if (!integrationId || !activation || typeof activation !== "object") return null;
  return integrations.updateIntegration(integrationId, agentId, null, {
    activation,
  });
}

/**
 * Activate a saved WeCom integration and persist its resulting lifecycle state.
 *
 * Activation failures are recorded best-effort before being exposed as a gateway error.
 *
 * @param {Object} agent - OpenClaw runtime target.
 * @param {string} agentId - Agent that owns the integration.
 * @param {string} integrationId - Saved WeCom integration to activate.
 * @returns {Promise<Object>} Integration with the latest activation state.
 */
async function activateWecomIntegration(agent, agentId, integrationId) {
  const savedIntegration = await integrations.getDecryptedIntegration(integrationId, agentId);
  if (!savedIntegration) {
    const error = new Error("Saved WeCom integration could not be loaded for activation.");
    error.statusCode = 500;
    throw error;
  }

  try {
    const outcome = await activateWecomForOpenClawAgent(agent, savedIntegration.config || {}, {
      runContainerCommand,
      rpcCall,
    });
    return (
      (await updateWecomActivationState(agentId, integrationId, outcome.activation)) ||
      savedIntegration
    );
  } catch (error) {
    const message =
      String(error?.message || "WeCom activation failed.")
        .trim()
        .replace(/\s+/g, " ") || "WeCom activation failed.";
    await updateWecomActivationState(agentId, integrationId, {
      lifecycleStatus: "activation_failed",
      readiness: "error",
      lastError: message,
      lastVerifiedAt: "",
    }).catch(() => null);
    const wrapped = new Error(message);
    wrapped.statusCode = 502;
    throw wrapped;
  }
}

// Credential reconciliation safety

function integrationMutationCommittedError(message, cause = null, syncResults = []) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = 502;
  error.code = "INTEGRATION_RUNTIME_REVOCATION_UNCONFIRMED";
  error.committed = true;
  error.syncResults = Array.isArray(syncResults) ? syncResults : [];
  return error;
}

function sendIntegrationRouteError(res, error) {
  res.status(error.statusCode || 500).json({
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.committed ? { committed: true } : {}),
    ...(Array.isArray(error.syncResults) ? { sync_results: error.syncResults } : {}),
  });
}

async function withIntegrationProviderStateLock(agent, _provider, operation) {
  if (!agent?.user_id || typeof llmProviders.withProviderStateLock !== "function") {
    throw new Error("Integration provider-state locking is unavailable");
  }
  return llmProviders.withProviderStateLock(agent.user_id, () =>
    operation({ providerLockHeld: true }),
  );
}

async function reconcileIntegrationAuth(
  agent,
  {
    providerLockHeld = false,
    extraManagedEnvNames = [],
    committedAction = "saved",
    request = null,
  } = {},
) {
  let results;
  try {
    results = await syncAuthToUserAgents(agent.user_id, agent.id, {
      providerLockHeld,
      ...(extraManagedEnvNames.length > 0 ? { extraManagedEnvNames } : {}),
      ...(request?.apiKey ? { apiKeyWorkspaceId: apiKeyWorkspaceId(request) } : {}),
    });
  } catch (error) {
    throw integrationMutationCommittedError(
      `Integration ${committedAction}, but runtime credential reconciliation could not be confirmed`,
      error,
    );
  }

  const failed = (Array.isArray(results) ? results : []).filter(
    (result) => result?.status === "failed",
  );
  const unsafe = failed.filter(
    (result) => result.runtimeStopped !== true || result.quarantinePersisted !== true,
  );
  if (unsafe.length > 0) {
    throw integrationMutationCommittedError(
      `Integration ${committedAction}, but ${unsafe.length} runtime${unsafe.length === 1 ? "" : "s"} could not be stopped and quarantined after credential reconciliation failed`,
      null,
      results,
    );
  }

  return {
    sync_results: results,
    ...(failed.length > 0
      ? {
          sync_warning: `${failed.length} runtime${failed.length === 1 ? " was" : "s were"} stopped and quarantined after credential reconciliation failed`,
        }
      : {}),
  };
}

async function captureIntegrationCredentialEnvState(agentId) {
  const [integrationEnv, mcpRuntimeState] = await Promise.all([
    integrations.getIntegrationEnvVars(agentId),
    typeof mcpServers.getEnabledMcpRuntimeState === "function"
      ? mcpServers.getEnabledMcpRuntimeState(agentId)
      : Promise.resolve({ managedEnvNames: [] }),
  ]);
  const gatewayEnvNames = Object.keys(integrationEnv || {});
  return {
    gatewayEnvNames,
    managedEnvNames: [
      ...new Set([...gatewayEnvNames, ...(mcpRuntimeState?.managedEnvNames || [])]),
    ],
  };
}

// Editor floor — integration configs include sensitive credentials, so viewers
// don't see them. Per-route GET could be relaxed to viewer in a follow-up if
// the redacted listing turns out to be useful for read-only operators.
router.use("/agents/:id/integrations", requireAccessibleAgent("editor", "id"));
// API keys must carry integrations:read or integrations:write to call these.
router.use("/agents/:id/integrations", scopeByMethod("integrations:read", "integrations:write"));

// Per-agent MCP server management reuses the same access + scope gates.
router.use("/agents/:id/mcp-servers", requireAccessibleAgent("editor", "id"));
router.use("/agents/:id/mcp-servers", scopeByMethod("integrations:read", "integrations:write"));
router.use("/integrations/twitter/oauth/callback", requireSession);
router.use("/integrations/linkedin/oauth/callback", requireSession);

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomToken(byteLength = 32) {
  return base64Url(crypto.randomBytes(byteLength));
}

function sha256Base64Url(value) {
  return base64Url(crypto.createHash("sha256").update(value).digest());
}

function requestProtocol(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.protocol || "http";
}

function requestHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
}

function publicBaseUrl(req) {
  const configured = String(process.env.NEXTAUTH_URL || process.env.NORA_PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = requestHost(req);
  if (!host) return "http://localhost:8080";
  return `${requestProtocol(req)}://${host}`;
}

function twitterOAuthCallbackUrl(req) {
  return `${publicBaseUrl(req)}/api/integrations/twitter/oauth/callback`;
}

function defaultTwitterOAuthRedirectPath(agentId) {
  return `/app/agents/${encodeURIComponent(agentId)}`;
}

/**
 * Restrict OAuth completion redirects to Nora application paths.
 *
 * @param {*} value - Requested post-OAuth redirect.
 * @param {string} agentId - Agent used for the safe fallback path.
 * @returns {string} Local `/app/` redirect path.
 */
function normalizeRedirectPath(value, agentId) {
  const fallback = defaultTwitterOAuthRedirectPath(agentId);
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/app/")) return fallback;
  if (trimmed.startsWith("//")) return fallback;
  return trimmed || fallback;
}

function appendQuery(targetPath, params = {}) {
  const url = new URL(targetPath, "http://nora.local");
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Parse a provider response and surface its most useful structured error detail.
 *
 * @param {Object} res - Fetch response.
 * @param {string} label - Provider operation label.
 * @returns {Promise<Object>} Parsed JSON object, or an empty object for an empty success body.
 */
async function readJsonResponse(res, label) {
  const rawText = await res.text().catch(() => "");
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const firstError = Array.isArray(data?.errors) ? data.errors[0] : null;
    const detail =
      firstError?.detail ||
      firstError?.message ||
      data?.error_description ||
      data?.error ||
      data?.detail ||
      data?.message ||
      data?.title ||
      rawText ||
      `HTTP ${res.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }

  return data || {};
}

function normalizeTwitterOAuthConfig(config = {}) {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  return {
    clientId: String(source.client_id || source.clientId || "").trim(),
    clientSecret: String(source.client_secret || source.clientSecret || "").trim(),
    defaultUsername: String(source.default_username || source.username || "")
      .trim()
      .replace(/^@+/, ""),
  };
}

async function exchangeTwitterOAuthCode({
  code,
  codeVerifier,
  redirectUri,
  clientId,
  clientSecret,
}) {
  if (!clientId) {
    const error = new Error("Twitter/X OAuth Client ID is required.");
    error.statusCode = 400;
    throw error;
  }

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }

  const res = await fetch(TWITTER_OAUTH_TOKEN_URL, {
    method: "POST",
    headers,
    body,
  });
  return readJsonResponse(res, "Twitter/X token exchange");
}

async function fetchTwitterOAuthUser(accessToken) {
  const url = new URL(TWITTER_OAUTH_ME_URL);
  url.searchParams.set("user.fields", "username,name");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return readJsonResponse(res, "Twitter/X user lookup");
}

function tokenExpiresAt(tokenData = {}) {
  const expiresIn = Number.parseInt(tokenData.expires_in, 10);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

// ── LinkedIn OAuth 2.0 ───────────────────────────────────
// Parallel to the Twitter helpers above. These should be extracted
// into a generic OAuth2 helper alongside the Twitter ones once a
// third OAuth provider lands.
const LINKEDIN_OAUTH_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_OAUTH_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_OAUTH_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_OAUTH_SCOPES = ["openid", "profile", "email", "w_member_social"];
const LINKEDIN_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function linkedinOAuthCallbackUrl(req) {
  return `${publicBaseUrl(req)}/api/integrations/linkedin/oauth/callback`;
}

function normalizeLinkedinOAuthConfig(config = {}) {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  return {
    clientId: String(source.client_id || source.clientId || "").trim(),
    clientSecret: String(source.client_secret || source.clientSecret || "").trim(),
    defaultUsername: String(source.default_username || source.username || "").trim(),
  };
}

async function exchangeLinkedinOAuthCode({ code, redirectUri, clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    const error = new Error("LinkedIn OAuth Client ID and Client Secret are both required.");
    error.statusCode = 400;
    throw error;
  }

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const res = await fetch(LINKEDIN_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return readJsonResponse(res, "LinkedIn token exchange");
}

async function fetchLinkedinOAuthUser(accessToken) {
  const res = await fetch(LINKEDIN_OAUTH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return readJsonResponse(res, "LinkedIn user lookup");
}

async function getAgentIntegrationRuntimeTarget(agentId, request = null) {
  if (request?.apiKey) {
    return findAgentForRequest(request, agentId);
  }
  const agentResult = await db.query(
    `SELECT id, container_id, host, runtime_host, runtime_port, status, gateway_token,
            gateway_host_port, gateway_host, gateway_port, backend_type,
            runtime_family, deploy_target, execution_target_id, sandbox_profile, user_id
       FROM agents WHERE id = $1`,
    [agentId],
  );
  return agentResult.rows[0] || null;
}

/**
 * Project stored integrations into the selected runtime and optionally surface sync failures.
 *
 * Strict modes surface Hermes manifest build/install failures or OpenClaw
 * manifest-delivery failures. OpenClaw gateway env projection remains best effort.
 *
 * @param {string} agentId - Agent whose integration state should be projected.
 * @param {Object} [options={}] - Failure policy, prior env names, and request authorization context.
 * @returns {Promise<Object|null>} Runtime family and manifest sync outcome.
 */
async function syncIntegrationsToAgent(
  agentId,
  { strict = false, strictHermes = false, previousEnvNames = [], request = null } = {},
) {
  const agent = await getAgentIntegrationRuntimeTarget(agentId, request);
  if (!agent) return null;

  if (resolveAgentRuntimeFamily(agent) === "hermes") {
    let syncData;
    try {
      syncData = await integrations.getIntegrationsForSync(agentId);
    } catch (error) {
      const manifestError = error?.message || "Failed to build Hermes integration manifest";
      if (strictHermes) {
        const strictError = new Error(manifestError, { cause: error });
        strictError.statusCode = error?.statusCode || 502;
        strictError.code = error?.code || "HERMES_INTEGRATION_MANIFEST_FAILED";
        throw strictError;
      }
      return {
        runtimeFamily: "hermes",
        manifestStatus: "failed",
        manifestError,
      };
    }
    let manifestStatus = "skipped";
    let manifestError = null;
    if (agent.container_id && ["running", "warning"].includes(agent.status)) {
      try {
        await runContainerCommand(agent, buildHermesIntegrationInstallCommand(syncData), {
          timeout: 30000,
        });
        manifestStatus = "synced";
      } catch (error) {
        manifestStatus = "failed";
        manifestError = error.message;
        if (strictHermes) {
          const strictError = new Error(
            manifestError || "Failed to install Hermes integration skill",
          );
          strictError.statusCode = 502;
          throw strictError;
        }
      }
    }

    return {
      runtimeFamily: "hermes",
      manifestStatus,
      ...(manifestError ? { manifestError } : {}),
    };
  }

  const activeRuntime = ["running", "warning"].includes(agent.status);
  if (!activeRuntime) {
    return { runtimeFamily: resolveAgentRuntimeFamily(agent), manifestStatus: "skipped" };
  }

  const runtimeUrl = runtimeUrlForAgent(agent, "/integrations/sync");
  if (!runtimeUrl) {
    if (strict) {
      const error = new Error("Agent runtime not yet provisioned");
      error.statusCode = 409;
      throw error;
    }
    return { runtimeFamily: resolveAgentRuntimeFamily(agent), manifestStatus: "skipped" };
  }

  // 1. Push integration metadata (non-sensitive) to the agent runtime.
  let manifestStatus = "skipped";
  let manifestError = null;
  try {
    const syncData = await integrations.getIntegrationsForSync(agentId);
    const response = await fetch(runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
      body: JSON.stringify({ integrations: syncData }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Runtime sync returned HTTP ${response.status}`);
    }
    manifestStatus = "synced";
  } catch (e) {
    manifestStatus = "failed";
    manifestError = String(e?.message || e);
    // Cap log output — error strings can echo arbitrarily large attacker- or
    // runtime-supplied content back into the logs.
    const truncatedError =
      manifestError.length > 200 ? `${manifestError.slice(0, 200)}…` : manifestError;
    console.warn(
      `[sync-integrations] Runtime sync failed for agent ${agentId} on port ${AGENT_RUNTIME_PORT}: ${truncatedError}`,
    );
    if (strict) {
      const error = new Error(manifestError || "Failed to sync integrations to runtime");
      error.statusCode = 502;
      throw error;
    }
  }

  // 2. Push decrypted tokens into the live gateway env via RPC. Logging in
  // this block deliberately omits the error message and env contents — the
  // payload may include credentials, and an echoing runtime error would leak
  // them into clear-text logs. Status code (success/failure) is enough.
  if (activeRuntime) {
    let envCount = 0;
    let patchCount = 0;
    let pushOk = false;
    try {
      const envVars = await integrations.getIntegrationEnvVars(agentId);
      envCount = Object.keys(envVars).length;
      const envPatch = Object.fromEntries(
        (Array.isArray(previousEnvNames) ? previousEnvNames : [])
          .map((name) => String(name || "").trim())
          .filter(Boolean)
          .map((name) => [name, null]),
      );
      Object.assign(envPatch, envVars);
      patchCount = Object.keys(envPatch).length;
      if (patchCount > 0) {
        const configSnapshot = await rpcCall(agent, "config.get");
        const baseHash =
          typeof configSnapshot?.hash === "string" && configSnapshot.hash.trim()
            ? configSnapshot.hash.trim()
            : null;
        if (!baseHash) throw new Error("runtime config hash unavailable");
        await rpcCall(agent, "config.patch", {
          raw: JSON.stringify({ env: envPatch }),
          baseHash,
        });
        pushOk = true;
      } else {
        pushOk = true;
      }
    } catch {
      pushOk = false;
    }
    if (pushOk && patchCount > 0) {
      console.log(
        `[sync-integrations] Reconciled ${envCount} current integration env var(s) across ${patchCount} managed key(s) for agent ${agentId} gateway`,
      );
    } else if (!pushOk) {
      console.warn(`[sync-integrations] Gateway env push failed for agent ${agentId}`);
    }
  }

  return {
    runtimeFamily: resolveAgentRuntimeFamily(agent),
    manifestStatus,
    ...(manifestError ? { manifestError } : {}),
  };
}

async function replaceOAuthIntegrationAndReconcile(agent, provider, accessToken, config, request) {
  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }
  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  let result;
  await withIntegrationProviderStateLock(agent, provider, async ({ providerLockHeld }) => {
    let mutationCommitted = false;
    try {
      const previousEnvState = await captureIntegrationCredentialEnvState(agent.id);
      result = await integrations.replaceIntegration(agent.id, provider, accessToken, config);
      mutationCommitted = true;
      if (runtimeFamily === "hermes") {
        await syncIntegrationsToAgent(agent.id, {
          strictHermes: true,
          previousEnvNames: previousEnvState.gatewayEnvNames,
          request,
        });
      } else {
        await syncIntegrationsToAgent(agent.id, {
          strict: true,
          previousEnvNames: previousEnvState.gatewayEnvNames,
          request,
        });
      }
      await reconcileIntegrationAuth(agent, {
        providerLockHeld,
        extraManagedEnvNames: previousEnvState.managedEnvNames,
        committedAction: "saved",
        request,
      });
    } catch (error) {
      if (mutationCommitted && !error?.committed) {
        throw integrationMutationCommittedError(
          "Integration saved, but runtime reconciliation could not be confirmed",
          error,
          error?.syncResults,
        );
      }
      throw error;
    }
  });
  return result;
}

/**
 * Forward an integration tool invocation only to a running or warning non-Hermes runtime.
 *
 * @param {string} agentId - Target agent.
 * @param {Object} [payload={}] - Runtime tool name and input.
 * @param {Object|null} [request=null] - Optional API-key request used to scope agent access.
 * @returns {Promise<Object>} Runtime invocation result.
 */
async function invokeAgentIntegrationTool(agentId, payload = {}, request = null) {
  const agent = await getAgentIntegrationRuntimeTarget(agentId, request);
  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  if (resolveAgentRuntimeFamily(agent) === "hermes") {
    const error = new Error("Integration tool invocation is not available for Hermes runtimes");
    error.statusCode = 409;
    throw error;
  }

  if (!["running", "warning"].includes(agent.status)) {
    const error = new Error(`Agent is ${agent.status}, not running`);
    error.statusCode = 409;
    throw error;
  }

  const runtimeUrl = runtimeUrlForAgent(agent, "/integrations/tools/invoke");
  if (!runtimeUrl) {
    const error = new Error("Agent runtime not yet provisioned");
    error.statusCode = 409;
    throw error;
  }

  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Runtime returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

// ─── Agent integrations ──────────────────────────────────────────

router.get("/agents/:id/integrations", async (req, res) => {
  try {
    res.json(await integrations.listIntegrations(req.params.id));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// List the MCP servers available to this agent (supported providers annotated
// with connected/enabled), and let an operator set which are enabled. Changing
// the set requires a redeploy to re-merge the runtime config.
router.get("/agents/:id/mcp-servers", async (req, res) => {
  try {
    res.json({ servers: await mcpServers.getAvailableMcpServers(req.params.id) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.put("/agents/:id/mcp-servers", async (req, res) => {
  try {
    const providers = Array.isArray(req.body?.providers) ? req.body.providers : [];
    const enabled = await mcpServers.setAgentMcpServerIds(req.params.id, providers);
    res.json({
      enabled,
      redeployRequired: true,
      servers: await mcpServers.getAvailableMcpServers(req.params.id),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations/twitter/oauth/start", async (req, res) => {
  try {
    const oauthConfig = normalizeTwitterOAuthConfig(req.body?.config || req.body);
    if (!oauthConfig.clientId) {
      return res.status(400).json({
        error:
          "Twitter/X OAuth Client ID is required. Create an X app, set the Nora callback URL, then enter the Client ID in this integration.",
      });
    }

    const state = randomToken(32);
    const codeVerifier = randomToken(64);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const redirectUri = twitterOAuthCallbackUrl(req);
    const redirectPath = normalizeRedirectPath(req.body?.redirectPath, req.params.id);
    const expiresAt = new Date(Date.now() + TWITTER_OAUTH_STATE_TTL_MS);

    await db.query(
      `INSERT INTO integration_oauth_states(
         state, provider, user_id, agent_id, code_verifier, client_id,
         client_secret, config, redirect_path, expires_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        state,
        "twitter",
        req.user.id,
        req.params.id,
        codeVerifier,
        oauthConfig.clientId,
        oauthConfig.clientSecret ? encrypt(oauthConfig.clientSecret) : null,
        JSON.stringify({
          default_username: oauthConfig.defaultUsername,
        }),
        redirectPath,
        expiresAt,
      ],
    );

    const authorizationUrl = new URL(TWITTER_OAUTH_AUTHORIZE_URL);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", oauthConfig.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", TWITTER_OAUTH_SCOPES.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    res.json({
      authorizationUrl: authorizationUrl.toString(),
      redirectUri,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations/linkedin/oauth/start", async (req, res) => {
  try {
    const oauthConfig = normalizeLinkedinOAuthConfig(req.body?.config || req.body);
    if (!oauthConfig.clientId || !oauthConfig.clientSecret) {
      return res.status(400).json({
        error:
          "LinkedIn OAuth Client ID and Client Secret are required. Create a LinkedIn app, add the Nora callback URL as an authorized redirect, then enter the Client ID and Client Secret in this integration.",
      });
    }

    const state = randomToken(32);
    // LinkedIn confidential clients don't require PKCE, but we generate
    // a code verifier anyway so the integration_oauth_states schema
    // (shared with Twitter) stays uniform.
    const codeVerifier = randomToken(64);
    const redirectUri = linkedinOAuthCallbackUrl(req);
    const redirectPath = normalizeRedirectPath(req.body?.redirectPath, req.params.id);
    const expiresAt = new Date(Date.now() + LINKEDIN_OAUTH_STATE_TTL_MS);

    await db.query(
      `INSERT INTO integration_oauth_states(
         state, provider, user_id, agent_id, code_verifier, client_id,
         client_secret, config, redirect_path, expires_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        state,
        "linkedin",
        req.user.id,
        req.params.id,
        codeVerifier,
        oauthConfig.clientId,
        encrypt(oauthConfig.clientSecret),
        JSON.stringify({
          default_username: oauthConfig.defaultUsername,
        }),
        redirectPath,
        expiresAt,
      ],
    );

    const authorizationUrl = new URL(LINKEDIN_OAUTH_AUTHORIZE_URL);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", oauthConfig.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", LINKEDIN_OAUTH_SCOPES.join(" "));
    authorizationUrl.searchParams.set("state", state);

    res.json({
      authorizationUrl: authorizationUrl.toString(),
      redirectUri,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.get("/integrations/linkedin/oauth/callback", async (req, res) => {
  let redirectPath = "/app/agents";
  let state = typeof req.query.state === "string" ? req.query.state : "";

  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const providerError = typeof req.query.error === "string" ? req.query.error : "";
    const providerErrorDescription =
      typeof req.query.error_description === "string" ? req.query.error_description : "";

    if (providerError) {
      throw new Error(providerErrorDescription || providerError);
    }
    if (!state || !code) {
      const error = new Error("LinkedIn OAuth callback missing state or code");
      error.statusCode = 400;
      throw error;
    }

    const stateResult = await db.query(
      `SELECT s.state, s.provider, s.user_id, s.agent_id, s.code_verifier,
              s.client_id, s.client_secret, s.config, s.redirect_path,
              s.expires_at, a.user_id AS agent_user_id
         FROM integration_oauth_states s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.state = $1 AND s.provider = $2`,
      [state, "linkedin"],
    );
    const oauthState = stateResult.rows[0];
    if (!oauthState) {
      const error = new Error("LinkedIn OAuth state expired or was already used");
      error.statusCode = 400;
      throw error;
    }

    await db.query("DELETE FROM integration_oauth_states WHERE state = $1", [state]);
    state = "";
    redirectPath = normalizeRedirectPath(oauthState.redirect_path, oauthState.agent_id);

    if (new Date(oauthState.expires_at).getTime() < Date.now()) {
      const error = new Error("LinkedIn OAuth state expired. Start the connection again.");
      error.statusCode = 400;
      throw error;
    }
    if (
      String(oauthState.user_id) !== String(req.user.id) ||
      String(oauthState.agent_user_id) !== String(req.user.id)
    ) {
      const error = new Error("LinkedIn OAuth state does not belong to this Nora user");
      error.statusCode = 403;
      throw error;
    }

    const clientSecret = oauthState.client_secret ? decrypt(oauthState.client_secret) : "";
    const tokenData = await exchangeLinkedinOAuthCode({
      code,
      redirectUri: linkedinOAuthCallbackUrl(req),
      clientId: oauthState.client_id,
      clientSecret,
    });
    const accessToken = String(tokenData.access_token || "").trim();
    if (!accessToken) {
      throw new Error("LinkedIn token exchange did not return an access token");
    }

    const profile = await fetchLinkedinOAuthUser(accessToken);
    let stateConfig = {};
    if (oauthState.config && typeof oauthState.config === "object") {
      stateConfig = oauthState.config;
    } else if (typeof oauthState.config === "string") {
      try {
        stateConfig = JSON.parse(oauthState.config);
      } catch {
        stateConfig = {};
      }
    }
    const linkedinName = String(profile?.name || profile?.given_name || "").trim();
    const linkedinSub = String(profile?.sub || "").trim();
    const defaultUsername = String(stateConfig.default_username || "").trim() || linkedinName;
    const config = {
      access_token: accessToken,
      refresh_token: tokenData.refresh_token || "",
      token_type: tokenData.token_type || "Bearer",
      scope: tokenData.scope || LINKEDIN_OAUTH_SCOPES.join(" "),
      expires_at: tokenExpiresAt(tokenData),
      client_id: oauthState.client_id,
      client_secret: clientSecret,
      sub: linkedinSub,
      name: linkedinName,
      default_username: defaultUsername,
    };

    const agent = await getAgentIntegrationRuntimeTarget(oauthState.agent_id, req);
    await replaceOAuthIntegrationAndReconcile(agent, "linkedin", accessToken, config, req);

    return res.redirect(
      appendQuery(redirectPath, {
        integration: "linkedin",
        status: "connected",
      }),
    );
  } catch (e) {
    if (state) {
      db.query("DELETE FROM integration_oauth_states WHERE state = $1", [state]).catch(() => {});
    }
    return res.redirect(
      appendQuery(redirectPath, {
        integration: "linkedin",
        status: "error",
        error: e.message || "LinkedIn OAuth failed",
        ...(e.committed ? { committed: "true" } : {}),
      }),
    );
  }
});

router.post("/agents/:id/integrations", async (req, res) => {
  try {
    const { provider, token, config } = req.body;
    if (!provider) return res.status(400).json({ error: "Provider required" });
    const agent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
    let result;
    let authSync = null;
    await withIntegrationProviderStateLock(agent, provider, async ({ providerLockHeld }) => {
      let mutationCommitted = false;
      try {
        const previousEnvState = await captureIntegrationCredentialEnvState(req.params.id);
        result = SINGLETON_INTEGRATION_PROVIDERS.has(String(provider))
          ? await integrations.replaceIntegration(req.params.id, provider, token, config)
          : await integrations.connectIntegration(req.params.id, provider, token, config);
        mutationCommitted = true;

        if (provider === "wecom" && runtimeFamily === "openclaw" && result?.id) {
          const latestAgent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
          result = await activateWecomIntegration(latestAgent || agent, req.params.id, result.id);
        }

        if (runtimeFamily === "hermes") {
          await syncIntegrationsToAgent(req.params.id, {
            strictHermes: true,
            previousEnvNames: previousEnvState.gatewayEnvNames,
            request: req,
          });
        } else {
          await syncIntegrationsToAgent(req.params.id, {
            strict: true,
            previousEnvNames: previousEnvState.gatewayEnvNames,
            request: req,
          });
        }
        authSync = await reconcileIntegrationAuth(agent, {
          providerLockHeld,
          extraManagedEnvNames: previousEnvState.managedEnvNames,
          committedAction: "saved",
          request: req,
        });
      } catch (error) {
        if (mutationCommitted && !error?.committed) {
          throw integrationMutationCommittedError(
            "Integration saved, but runtime reconciliation could not be confirmed",
            error,
            error?.syncResults,
          );
        }
        throw error;
      }
    });

    if (authSync && result && typeof result === "object") {
      result = { ...result, ...authSync };
    }

    if (provider === "email" && result?.id) {
      const normalizedConfig = normalizeEmailConfigInput(config || {});
      const cronConfig = normalizedConfig?.cron || {};
      const latestAgent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
      const cronJobId = cronConfig.enabled
        ? await registerEmailCronJob(latestAgent || agent, result.id, cronConfig)
        : null;
      if (cronJobId != null) {
        await integrations.updateEmailCronJobId(result.id, req.params.id, cronJobId);
        result.cron_job_id = cronJobId;
      }
    }

    // Auto-verify the stored credentials so broken keys surface at save time
    // instead of at first agent use. Non-blocking: the row is already stored
    // and synced — the outcome rides along for the UI to display.
    if (result?.id) {
      try {
        const connectivity = await integrations.testIntegration(result.id, req.params.id);
        result = { ...result, connectivity };
      } catch (testError) {
        result = { ...result, connectivity: { success: false, error: testError.message } };
      }
    }

    res.json(result);
  } catch (e) {
    sendIntegrationRouteError(res, e);
  }
});

router.delete("/agents/:id/integrations/:iid", async (req, res) => {
  try {
    const agent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
    const existing = await integrations.listIntegrations(req.params.id);
    const current = Array.isArray(existing)
      ? existing.find((item) => String(item.id) === String(req.params.iid))
      : null;
    const linkedCronJobId = current?.cron_job_id || null;
    const runtimeCronJobIds =
      current?.provider === "email" ? await findEmailCronJobIds(agent, req.params.iid) : [];

    if (linkedCronJobId || runtimeCronJobIds.length > 0) {
      await removeEmailCronJobs(agent, [linkedCronJobId, ...runtimeCronJobIds]);
    }

    if (current?.provider === "wecom" && runtimeFamily === "openclaw") {
      await deactivateWecomForOpenClawAgent(agent, { rpcCall, runContainerCommand });
    }

    let removed;
    let authSync = null;
    await withIntegrationProviderStateLock(
      agent,
      current?.provider,
      async ({ providerLockHeld }) => {
        let mutationCommitted = false;
        try {
          const previousEnvState = await captureIntegrationCredentialEnvState(req.params.id);
          removed = await integrations.removeIntegration(req.params.iid, req.params.id);
          mutationCommitted = true;

          if (runtimeFamily === "hermes") {
            await syncIntegrationsToAgent(req.params.id, {
              strictHermes: true,
              previousEnvNames: previousEnvState.gatewayEnvNames,
              request: req,
            });
          } else {
            await syncIntegrationsToAgent(req.params.id, {
              strict: true,
              previousEnvNames: previousEnvState.gatewayEnvNames,
              request: req,
            });
          }
          authSync = await reconcileIntegrationAuth(agent, {
            providerLockHeld,
            extraManagedEnvNames: previousEnvState.managedEnvNames,
            committedAction: "deleted",
            request: req,
          });
        } catch (error) {
          if (mutationCommitted && !error?.committed) {
            throw integrationMutationCommittedError(
              "Integration deleted, but runtime credential revocation could not be confirmed",
              error,
              error?.syncResults,
            );
          }
          throw error;
        }
      },
    );

    const fallbackCronJobId = removed?.cron_job_id || linkedCronJobId;
    const fallbackRuntimeCronJobIds =
      removed?.provider === "email" ? await findEmailCronJobIds(agent, req.params.iid) : [];
    if (fallbackCronJobId || fallbackRuntimeCronJobIds.length > 0) {
      await removeEmailCronJobs(agent, [fallbackCronJobId, ...fallbackRuntimeCronJobIds]);
    }

    res.json({ success: true, ...(authSync || {}) });
  } catch (e) {
    sendIntegrationRouteError(res, e);
  }
});

router.put("/agents/:id/integrations/:iid", async (req, res) => {
  try {
    const agent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
    const existing = await integrations.listIntegrations(req.params.id);
    const current = Array.isArray(existing)
      ? existing.find((item) => String(item.id) === String(req.params.iid))
      : null;
    if (!current) return res.status(404).json({ error: "Integration not found" });

    let result;
    let authSync = null;
    await withIntegrationProviderStateLock(
      agent,
      current?.provider,
      async ({ providerLockHeld }) => {
        let mutationCommitted = false;
        try {
          const previousEnvState = await captureIntegrationCredentialEnvState(req.params.id);
          result = await integrations.updateIntegration(
            req.params.iid,
            req.params.id,
            req.body?.token,
            req.body?.config || {},
          );
          mutationCommitted = true;

          if (result?.provider === "wecom" && runtimeFamily === "openclaw") {
            const latestAgent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
            result = await activateWecomIntegration(latestAgent || agent, req.params.id, result.id);
          }

          if (runtimeFamily === "hermes") {
            await syncIntegrationsToAgent(req.params.id, {
              strictHermes: true,
              previousEnvNames: previousEnvState.gatewayEnvNames,
              request: req,
            });
          } else {
            await syncIntegrationsToAgent(req.params.id, {
              strict: true,
              previousEnvNames: previousEnvState.gatewayEnvNames,
              request: req,
            });
          }
          authSync = await reconcileIntegrationAuth(agent, {
            providerLockHeld,
            extraManagedEnvNames: previousEnvState.managedEnvNames,
            committedAction: "updated",
            request: req,
          });
        } catch (error) {
          if (mutationCommitted && !error?.committed) {
            throw integrationMutationCommittedError(
              "Integration updated, but runtime credential reconciliation could not be confirmed",
              error,
              error?.syncResults,
            );
          }
          throw error;
        }
      },
    );

    if (authSync && result && typeof result === "object") {
      result = { ...result, ...authSync };
    }

    if (result?.provider === "email") {
      const previousCronJobId = current?.cron_job_id || null;
      const latestAgent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
      const runtimeCronJobIds = await findEmailCronJobIds(latestAgent || agent, result.id);
      const cronConfig = normalizeEmailConfigInput(req.body?.config || {}).cron || {};
      if (cronConfig.enabled) {
        if (!previousCronJobId && runtimeCronJobIds.length > 0) {
          await removeEmailCronJobs(latestAgent || agent, runtimeCronJobIds);
        }
        const nextCronJobId = await reconcileEmailCronJob(
          latestAgent || agent,
          result.id,
          previousCronJobId,
          cronConfig,
        );
        if (nextCronJobId !== previousCronJobId) {
          await integrations.updateEmailCronJobId(result.id, req.params.id, nextCronJobId);
          result.cron_job_id = nextCronJobId;
        }
      } else if (previousCronJobId || runtimeCronJobIds.length > 0) {
        await removeEmailCronJobs(latestAgent || agent, [previousCronJobId, ...runtimeCronJobIds]);
        await integrations.updateEmailCronJobId(result.id, req.params.id, null);
        result.cron_job_id = null;
      }
    }

    res.json(result);
  } catch (e) {
    sendIntegrationRouteError(res, e);
  }
});

router.get("/integrations/twitter/oauth/callback", async (req, res) => {
  let redirectPath = "/app/agents";
  let state = typeof req.query.state === "string" ? req.query.state : "";

  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const providerError = typeof req.query.error === "string" ? req.query.error : "";
    const providerErrorDescription =
      typeof req.query.error_description === "string" ? req.query.error_description : "";

    if (providerError) {
      throw new Error(providerErrorDescription || providerError);
    }
    if (!state || !code) {
      const error = new Error("Twitter/X OAuth callback missing state or code");
      error.statusCode = 400;
      throw error;
    }

    const stateResult = await db.query(
      `SELECT s.state, s.provider, s.user_id, s.agent_id, s.code_verifier,
              s.client_id, s.client_secret, s.config, s.redirect_path,
              s.expires_at, a.user_id AS agent_user_id
         FROM integration_oauth_states s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.state = $1 AND s.provider = $2`,
      [state, "twitter"],
    );
    const oauthState = stateResult.rows[0];
    if (!oauthState) {
      const error = new Error("Twitter/X OAuth state expired or was already used");
      error.statusCode = 400;
      throw error;
    }

    await db.query("DELETE FROM integration_oauth_states WHERE state = $1", [state]);
    state = "";
    redirectPath = normalizeRedirectPath(oauthState.redirect_path, oauthState.agent_id);

    if (new Date(oauthState.expires_at).getTime() < Date.now()) {
      const error = new Error("Twitter/X OAuth state expired. Start the connection again.");
      error.statusCode = 400;
      throw error;
    }
    if (
      String(oauthState.user_id) !== String(req.user.id) ||
      String(oauthState.agent_user_id) !== String(req.user.id)
    ) {
      const error = new Error("Twitter/X OAuth state does not belong to this Nora user");
      error.statusCode = 403;
      throw error;
    }

    const tokenData = await exchangeTwitterOAuthCode({
      code,
      codeVerifier: oauthState.code_verifier,
      redirectUri: twitterOAuthCallbackUrl(req),
      clientId: oauthState.client_id,
      clientSecret: oauthState.client_secret ? decrypt(oauthState.client_secret) : "",
    });
    const accessToken = String(tokenData.access_token || "").trim();
    if (!accessToken) {
      throw new Error("Twitter/X token exchange did not return an access token");
    }

    const profile = await fetchTwitterOAuthUser(accessToken);
    const user = profile?.data || {};
    const username = String(user.username || "").trim();
    const twitterUserId = String(user.id || "").trim();
    let stateConfig = {};
    if (oauthState.config && typeof oauthState.config === "object") {
      stateConfig = oauthState.config;
    } else if (typeof oauthState.config === "string") {
      try {
        stateConfig = JSON.parse(oauthState.config);
      } catch {
        stateConfig = {};
      }
    }
    const defaultUsername =
      String(stateConfig.default_username || "")
        .trim()
        .replace(/^@+/, "") || username;
    const config = {
      access_token: accessToken,
      refresh_token: tokenData.refresh_token || "",
      token_type: tokenData.token_type || "bearer",
      scope: tokenData.scope || TWITTER_OAUTH_SCOPES.join(" "),
      expires_at: tokenExpiresAt(tokenData),
      client_id: oauthState.client_id,
      client_secret: oauthState.client_secret ? decrypt(oauthState.client_secret) : "",
      user_id: twitterUserId,
      username,
      default_username: defaultUsername,
    };

    const agent = await getAgentIntegrationRuntimeTarget(oauthState.agent_id, req);
    await replaceOAuthIntegrationAndReconcile(agent, "twitter", accessToken, config, req);

    return res.redirect(
      appendQuery(redirectPath, {
        integration: "twitter",
        status: "connected",
      }),
    );
  } catch (e) {
    if (state) {
      db.query("DELETE FROM integration_oauth_states WHERE state = $1", [state]).catch(() => {});
    }
    return res.redirect(
      appendQuery(redirectPath, {
        integration: "twitter",
        status: "error",
        error: e.message || "Twitter/X OAuth failed",
        ...(e.committed ? { committed: "true" } : {}),
      }),
    );
  }
});

router.post("/agents/:id/integrations/:iid/test", async (req, res) => {
  try {
    const agent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
    const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
    const existing = await integrations.listIntegrations(req.params.id);
    const current = Array.isArray(existing)
      ? existing.find((item) => String(item.id) === String(req.params.iid))
      : null;
    let result;

    if (current?.provider === "wecom" && runtimeFamily === "openclaw") {
      const savedIntegration = await integrations.getDecryptedIntegration(
        req.params.iid,
        req.params.id,
      );
      if (!savedIntegration) {
        return res.status(404).json({ error: "Integration not found" });
      }
      result = await verifyWecomForOpenClawAgent(agent, savedIntegration.config || {}, {
        runContainerCommand,
        rpcCall,
      });
      if (result?.activation) {
        await updateWecomActivationState(req.params.id, req.params.iid, result.activation).catch(
          () => null,
        );
      }
    } else {
      result = await integrations.testIntegration(req.params.iid, req.params.id);
      if (current?.provider === "email") {
        await integrations.updateIntegration(req.params.iid, req.params.id, null, {
          verification: {
            lastTestAt: new Date().toISOString(),
            lastSuccess: Boolean(result?.success),
            lastError: result?.success
              ? ""
              : String(result?.error || result?.message || "Connection test failed"),
          },
        });
      }
    }
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations/tools/invoke", async (req, res) => {
  try {
    const toolName =
      typeof req.body.toolName === "string" && req.body.toolName
        ? req.body.toolName
        : typeof req.body.name === "string" && req.body.name
          ? req.body.name
          : "";
    if (!toolName) {
      return res.status(400).json({ error: "toolName required" });
    }

    const input =
      req.body.input && typeof req.body.input === "object" && !Array.isArray(req.body.input)
        ? req.body.input
        : req.body.arguments &&
            typeof req.body.arguments === "object" &&
            !Array.isArray(req.body.arguments)
          ? req.body.arguments
          : {};

    // Refresh OAuth tokens that are within the skew window of expiry and
    // push the latest env to the gateway, so the runtime makes outbound
    // API calls (e.g. X / Twitter) with an unexpired access token. Best-
    // effort: a transient sync failure shouldn't block tool invocations
    // whose providers don't require a refresh.
    try {
      const agent = await getAgentIntegrationRuntimeTarget(req.params.id, req);
      if (agent) {
        await withIntegrationProviderStateLock(agent, null, () =>
          syncIntegrationsToAgent(req.params.id, { strict: false, request: req }),
        );
      }
    } catch (syncError) {
      console.warn(
        `[integrations/tools/invoke] pre-invoke sync failed for agent ${req.params.id}: ${syncError?.message ?? syncError}`,
      );
    }

    const result = await invokeAgentIntegrationTool(
      req.params.id,
      {
        toolName,
        input,
      },
      req,
    );
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ─── Integration catalog ──────────────────────────────────────────

router.get("/integrations/catalog", async (req, res, next) => {
  try {
    const { category } = req.query;
    res.json(await integrations.getCatalog(category));
  } catch (e) {
    next(e);
  }
});

router.get("/integrations/catalog/:catalogId", async (req, res, next) => {
  try {
    const item = await integrations.getCatalogItem(req.params.catalogId);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
