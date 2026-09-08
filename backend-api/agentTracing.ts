// @ts-nocheck
// backend-api/agentTracing.ts — Phase 12 of the logging control plane:
// agent-side trace enablement.
//
// Turns OpenTelemetry tracing on for a running OpenClaw agent WITHOUT
// restarting it, and keeps it on across restarts, mirroring the same
// self-healing pattern Phase 10 established for the gateway collector's
// `consoleLevel: warn` (periodic reconcile re-applies managed config that a
// real restart would otherwise silently drop, since a running-container
// config merge has no persistence of its own across a restart).
//
// Depends on:
//   - agent-runtime/lib/runtimeBootstrap.ts  — buildOpenClawConfigMergeCommand
//     (deep-merges a delta into /root/.openclaw/openclaw.json on a running
//     container, no restart required) and buildRuntimeEnv (source of the
//     BACKEND_API_URL every agent is already given).
//   - backend-api/routes/otlp.ts (Phase 11) — computeIngestKey/verifyIngestKey.
//     mintIngestKey below calls computeIngestKey directly rather than
//     reimplementing the HMAC scheme, so a minted key is GUARANTEED to
//     authenticate against verifyIngestKey — same function, not a parallel
//     derivation that could drift.
//   - backend-api/authSync.ts — runRuntimeCommand/runContainerCommand, the
//     same "try the runtime sidecar, fall back to a direct container exec"
//     pair authSync already uses to apply managed OpenClaw config to a
//     running agent without restarting it.
//   - workspace_log_settings (Phase 1/5) — traces_enabled/trace_sample_rate
//     columns; resolved through the same fallback chain as retention
//     (workspace row when one exists, platform defaults otherwise).
//
// Data-sensitivity note (do not "fix" this without reading the plan):
// `captureContent` is hardcoded `false` with no configuration knob — setting
// it `true` would put prompt/tool-output content into span attributes.
// `trace_sample_rate` is read from whatever workspace_log_settings holds
// (1.0 by default) but is NOT exposed as user-settable anywhere in this
// phase; sampling below 1.0 would break the Traces lens's cost aggregates
// and leave gateway-log `trace_id`s pointing at traces that were never
// exported.

const db = require("./db");
const { buildOpenClawConfigMergeCommand, buildRuntimeEnv } = require("../agent-runtime/lib/runtimeBootstrap");
const { resolveAgentRuntimeFamily } = require("../agent-runtime/lib/agentRuntimeFields");
const otlpRoutes = require("./routes/otlp");

// Platform defaults mirror the workspace_log_settings column defaults
// exactly (see the CREATE TABLE in server.ts) — an agent with no workspace
// has no row there by design, and must resolve to these rather than silently
// receiving no tracing config at all (the specific failure mode Phase 12
// exists to avoid).
const PLATFORM_LOG_SETTINGS_DEFAULTS = Object.freeze({
  gateway_logs_enabled: true,
  traces_enabled: false,
  trace_sample_rate: 1.0,
});

function lazyDb(deps) {
  return deps.dbClient || deps.db || db;
}

/**
 * HMAC under NORA_OTLP_INGEST_SECRET — delegates to Phase 11's
 * `computeIngestKey` in routes/otlp.ts rather than reimplementing the
 * derivation, so a minted key is guaranteed to authenticate against
 * `verifyIngestKey` (same function, called both places).
 *
 * @param {string} agentId
 * @returns {string} hex-encoded HMAC digest
 */
function mintIngestKey(agentId) {
  return otlpRoutes.computeIngestKey(agentId);
}

/**
 * `otlpBase` defaults to the BACKEND_API_URL already injected into every
 * agent by `buildRuntimeEnv()`. Kubernetes, remote-Docker, and Proxmox
 * agents may not be able to reach that address from their network position,
 * so NORA_OTLP_PUBLIC_ENDPOINT overrides it when set.
 *
 * @returns {string} Base URL with no trailing slash.
 */
function resolveOtlpBase() {
  const explicit = String(process.env.NORA_OTLP_PUBLIC_ENDPOINT || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const env = buildRuntimeEnv();
  return String(env.BACKEND_API_URL || "").replace(/\/+$/, "");
}

/**
 * Build the OpenClaw config delta that turns tracing on (or off) for an
 * agent, per the resolved workspace log settings. Pure function: no I/O
 * beyond reading NORA_OTLP_INGEST_SECRET/NORA_OTLP_PUBLIC_ENDPOINT/
 * BACKEND_API_URL from process.env via mintIngestKey/resolveOtlpBase.
 *
 * When `settings.traces_enabled` is false, returns a minimal delta that
 * disables OTel rather than omitting the section entirely — this is what
 * lets `applyTracingConfig` actually turn tracing OFF for an agent that
 * previously had it on, rather than merely skipping a future apply.
 *
 * @param {{id: string}} agent
 * @param {{traces_enabled: boolean, trace_sample_rate: number}} settings
 * @returns {Object} openclaw.json delta
 */
function buildTracingConfigDelta(agent, settings) {
  if (!settings || !settings.traces_enabled) {
    return {
      diagnostics: {
        otel: {
          enabled: false,
          traces: false,
        },
      },
    };
  }

  const ingestKey = mintIngestKey(agent.id);
  const otlpBase = resolveOtlpBase();
  const sampleRate = Number.isFinite(Number(settings.trace_sample_rate))
    ? Number(settings.trace_sample_rate)
    : PLATFORM_LOG_SETTINGS_DEFAULTS.trace_sample_rate;

  return {
    diagnostics: {
      enabled: true,
      otel: {
        enabled: true,
        traces: true,
        metrics: false,
        logs: false,
        tracesEndpoint: `${otlpBase}/otlp/v1/traces`,
        // OpenClaw has retired gRPC entirely; `openclaw doctor --fix`
        // actively rewrites any legacy "grpc" value it finds. This must
        // stay exactly "http/protobuf".
        protocol: "http/protobuf",
        headers: { "x-nora-ingest-key": ingestKey },
        // Never configurable — see module header.
        captureContent: false,
        sampleRate,
      },
    },
  };
}

/**
 * Resolve an agent's workspace, the same way Phase 11's ingest route and
 * Phase 6's search scoping do — the first (and only expected) row in
 * `workspace_agents`, or null for an agent that belongs to no workspace.
 *
 * @param {string} agentId
 * @param {Object} [deps]
 * @returns {Promise<string|null>}
 */
async function resolveAgentWorkspaceId(agentId, deps = {}) {
  const dbClient = lazyDb(deps);
  try {
    const result = await dbClient.query(
      `SELECT workspace_id FROM workspace_agents WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    return result.rows[0]?.workspace_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective enablement/sampling settings for a workspace through
 * the Phase 5 fallback chain: the workspace's `workspace_log_settings` row
 * when one exists, platform defaults otherwise. An agent with no workspace
 * (`workspaceId == null`) always resolves to the platform defaults — this is
 * the specific case that would otherwise silently never export any traces.
 *
 * @param {string|null} workspaceId
 * @param {Object} [deps]
 * @returns {Promise<{gateway_logs_enabled: boolean, traces_enabled: boolean, trace_sample_rate: number}>}
 */
async function resolveWorkspaceLogSettings(workspaceId, deps = {}) {
  const dbClient = lazyDb(deps);
  if (workspaceId) {
    try {
      const result = await dbClient.query(
        `SELECT gateway_logs_enabled, traces_enabled, trace_sample_rate
           FROM workspace_log_settings
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      const row = result.rows[0];
      if (row) {
        return {
          gateway_logs_enabled: Boolean(row.gateway_logs_enabled),
          traces_enabled: Boolean(row.traces_enabled),
          trace_sample_rate: Number(row.trace_sample_rate),
        };
      }
    } catch {
      // Fall through to platform defaults on a lookup failure — conservative
      // and consistent with resolveRetentionDaysForColumn's own fallback.
    }
  }
  return { ...PLATFORM_LOG_SETTINGS_DEFAULTS };
}

/**
 * Run the config-merge command against an agent's running container,
 * preferring the runtime sidecar and falling back to a direct container exec
 * — the same two-step path `authSync.js` already uses to apply managed
 * OpenClaw config without a restart. Lazily required to avoid a require
 * cycle (authSync also pulls in a good deal of provider/model machinery this
 * module has no need for).
 *
 * @param {Object} agent
 * @param {string} command
 * @returns {Promise<Object>}
 */
async function applyConfigMergeCommand(agent, command, deps = {}) {
  const authSync = deps.authSync || require("./authSync");
  try {
    return await authSync.runRuntimeCommand(agent, command, { timeout: 30000 });
  } catch (error) {
    return await authSync.runContainerCommand(agent, command, { timeout: 30000 });
  }
}

/**
 * Resolve settings, mint/reuse the ingest key, build the delta, and merge it
 * into the agent's running openclaw.json — no restart. Skips non-OpenClaw
 * (e.g. Hermes) agents entirely, without error, since the OpenClaw
 * `diagnostics.otel` config shape has no Hermes equivalent in this phase.
 *
 * @param {Object} agent - Agent row; must carry `id` and enough
 *   runtime/container addressing fields for `authSync.runRuntimeCommand`/
 *   `runContainerCommand` to reach it (host/runtime_port/backend_type/etc.).
 * @param {Object} [deps] - Test seams: dbClient, authSync.
 * @returns {Promise<{applied: boolean, skipped?: string, delta?: Object}>}
 */
async function applyTracingConfig(agent, deps = {}) {
  if (!agent || !agent.id) {
    return { applied: false, skipped: "missing_agent" };
  }

  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  if (runtimeFamily !== "openclaw") {
    return { applied: false, skipped: "unsupported_runtime_family" };
  }

  const workspaceId = await resolveAgentWorkspaceId(agent.id, deps);
  const settings = await resolveWorkspaceLogSettings(workspaceId, deps);
  const delta = buildTracingConfigDelta(agent, settings);
  const command = buildOpenClawConfigMergeCommand(delta);

  await applyConfigMergeCommand(agent, command, deps);

  return { applied: true, delta, workspaceId, settings };
}

/**
 * Walk running OpenClaw agents and re-apply/remove tracing config per each
 * agent's currently-resolved `traces_enabled` state. Called from the
 * existing 30s agent-status reconcile loop (backgroundTasks.js) so an agent
 * that restarted — and thus lost its in-memory-applied config merge, since
 * this is a running-container merge with no persistence across a real
 * restart — gets it correctly re-applied automatically. Best-effort: a
 * single agent's failure never aborts the sweep, matching
 * `reconcileBackgroundAgentStatuses`'s own convention.
 *
 * @param {Object} [deps] - Test seams: dbClient, authSync.
 * @returns {Promise<void>}
 */
async function reconcileTracingConfig(deps = {}) {
  const dbClient = lazyDb(deps);
  try {
    const agents = await dbClient.query(
      `SELECT id, user_id, container_id, backend_type, deploy_target,
              execution_target_id, runtime_family, sandbox_profile, status,
              host, runtime_host, runtime_port, gateway_host, gateway_port
         FROM agents
        WHERE container_id IS NOT NULL
          AND status IN ('running', 'warning')`,
    );

    for (const agent of agents.rows) {
      try {
        await applyTracingConfig(agent, deps);
      } catch {
        // Reconciliation is best-effort only — an unreachable agent this
        // tick gets another chance next tick.
      }
    }
  } catch {
    // Reconciliation is best-effort only.
  }
}

module.exports = {
  PLATFORM_LOG_SETTINGS_DEFAULTS,
  mintIngestKey,
  resolveOtlpBase,
  buildTracingConfigDelta,
  resolveAgentWorkspaceId,
  resolveWorkspaceLogSettings,
  applyTracingConfig,
  reconcileTracingConfig,
};
