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

// How long a known tracing_capability verdict is trusted before
// reconcileTracingConfig's 30s tick will re-run the plugin install/enable/
// list check (buildEnableTracingPluginCommand) against the SAME agent again.
// Confirmed empirically this matters: an agent whose workspace has tracing
// on gets this check re-run on literally every 30s reconcile tick forever
// once nothing throttles it — and a real manual `openclaw update` on such an
// agent, running concurrently with Nora's own automatic plugin install
// hitting the same on-disk OpenClaw install/state, produced worse, disk-
// persisted corruption (surviving a container restart) than an interrupted
// update alone would. 30 minutes is long enough to eliminate that collision
// window for all practical purposes while still picking up a manual
// version upgrade in a reasonable time (the settings PUT's own immediate
// reapply — see routes/observability.ts's tracesEnabledChanging branch —
// still forces an unthrottled check right when an operator deliberately
// flips the workspace toggle).
const TRACING_CAPABILITY_RECHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Whether `applyTracingConfig` should include the plugin install/enable/list
 * check this time, or skip it and just do the cheap, local, no-network
 * config merge. Pure function of the agent row's own last-known state.
 *
 * @param {{tracing_capability?: string, tracing_capability_checked_at?: string|Date|null}} agent
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function shouldCheckTracingCapability(agent, nowMs = Date.now()) {
  const capability = agent?.tracing_capability;
  if (!capability || capability === "unknown") return true;
  const checkedAt = agent?.tracing_capability_checked_at;
  if (!checkedAt) return true;
  const checkedAtMs = new Date(checkedAt).getTime();
  if (!Number.isFinite(checkedAtMs)) return true;
  return nowMs - checkedAtMs >= TRACING_CAPABILITY_RECHECK_INTERVAL_MS;
}

/**
 * Cheap, local, no-network probe: just `openclaw --version`, nothing else.
 * Used to decide whether a throttled recheck can skip the real (network- and
 * lock-touching) plugin install/enable/list sequence entirely -- when the
 * version hasn't changed since the verdict currently on file, that verdict
 * is still correct and there is nothing new to learn from re-running it.
 * Deliberately NOT compared against a fixed "minimum compatible version"
 * constant (see the module header's captureContent-adjacent note on why
 * this module avoids hardcoding OpenClaw's plugin API floor) -- comparing
 * against the LAST OBSERVED version for this specific agent instead means a
 * rollback to a previously-tested version still gets exactly one (bounded,
 * self-limiting) real recheck rather than either silently trusting a stale
 * verdict or needing a maintained version-ordering comparison.
 *
 * @returns {string} Shell script fragment.
 */
function buildProbeOpenclawVersionCommand() {
  return "openclaw --version 2>/dev/null | head -1";
}

/**
 * `authSync.runRuntimeCommand`/`runContainerCommand` don't share one exact
 * result shape -- both are read the same way throughout this module.
 *
 * @param {Object} [result]
 * @returns {string}
 */
function extractCommandOutput(result) {
  return typeof result?.output === "string"
    ? result.output
    : [result?.stdout, result?.stderr].filter(Boolean).join("\n");
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
        headers: { "x-nora-agent-id": agent.id, "x-nora-ingest-key": ingestKey },
        // Never configurable — see module header.
        captureContent: false,
        sampleRate,
      },
    },
  };
}

/**
 * Resolve an agent's workspace, the same way Phase 11's ingest route and
 * Phase 6's search scoping do — the single row in `workspace_agents` for this
 * agent (UNIQUE(agent_id) guarantees there is at most one), or null for an
 * agent that belongs to no workspace.
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
 * OpenClaw ships no OpenTelemetry exporter in core — `diagnostics.otel.*`
 * is accepted and validated by the config schema regardless, but produces
 * no actual export unless the separate `diagnostics-otel` plugin is BOTH
 * installed and allow-listed/enabled (see
 * /usr/local/lib/node_modules/openclaw/docs/gateway/opentelemetry.md inside
 * any OpenClaw agent container — "Exporters only attach when both the
 * diagnostics surface and the plugin are enabled"). Confirmed empirically:
 * a real agent with a fully-correct `diagnostics.otel` merge and no plugin
 * step exported nothing. `openclaw plugins install` is safe to re-run on an
 * already-installed plugin (idempotent — errors are swallowed with `|| true`
 * rather than failing the whole merge over a plugin that's already there);
 * `openclaw plugins enable` is idempotent by nature. Only run on the
 * enabling path — turning tracing off leaves the plugin installed but inert,
 * since `diagnostics.otel.enabled: false` alone already stops export per
 * the same doc line, and there's no reason to churn install/uninstall.
 *
 * @returns {string} Shell script fragment (plain `sh`, matches
 *   buildOpenClawConfigMergeCommand's own dialect).
 */
// Printed by the shell fragment below so `applyTracingConfig` can tell
// whether the plugin actually ended up enabled, without trusting either
// command's own exit code (both are intentionally `|| true`-guarded so an
// idempotent re-run, or a plugin already installed by hand, never fails the
// whole config merge). `openclaw plugins list --enabled --json` is the
// ground truth for "is it actually on", independent of why install/enable
// did or didn't need to do anything.
const TRACING_CAPABILITY_MARKER = "__NORA_TRACING_CAPABILITY__";
// Captured purely for diagnostics/display (e.g. "OpenClaw 2026.6.11 —
// needs ≥2026.9.3" in the Traces lens's unsupported message) -- NEVER the
// trigger for the supported/unsupported verdict itself. The verdict stays
// capability-based (did the plugin actually end up enabled), not
// version-based, so a manually-updated agent is read correctly without Nora
// having to hardcode/maintain the plugin API's minimum version anywhere.
const TRACING_VERSION_MARKER = "__NORA_TRACING_OPENCLAW_VERSION__";

function buildEnableTracingPluginCommand() {
  return [
    "openclaw plugins install clawhub:@openclaw/diagnostics-otel || true",
    "openclaw plugins enable diagnostics-otel || true",
    `if openclaw plugins list --enabled --json 2>/dev/null | grep -q '"diagnostics-otel"'; then`,
    `  echo "${TRACING_CAPABILITY_MARKER}=supported"`,
    `else`,
    `  echo "${TRACING_CAPABILITY_MARKER}=unsupported"`,
    `fi`,
    `echo "${TRACING_VERSION_MARKER}=$(openclaw --version 2>/dev/null | head -1)"`,
  ].join("\n");
}

/**
 * Pull the `supported`/`unsupported` verdict out of the combined
 * plugin-check + config-merge command's captured output. `undefined` when
 * the marker never printed at all (an unreachable agent, a shell that
 * errored before reaching the check, or `deps` overriding
 * `applyConfigMergeCommand` in a test with no output field) -- distinct from
 * "unsupported", and deliberately left unpersisted, since a failure to
 * OBSERVE capability is not the same fact as observing it's absent.
 *
 * @param {string} [output]
 * @returns {"supported"|"unsupported"|undefined}
 */
function parseTracingCapabilityFromOutput(output) {
  const text = String(output || "");
  const match = text.match(new RegExp(`${TRACING_CAPABILITY_MARKER}=(supported|unsupported)`));
  return match ? match[1] : undefined;
}

/**
 * Pull the raw `openclaw --version` line printed alongside the capability
 * marker -- diagnostic-only, see `TRACING_VERSION_MARKER` above.
 *
 * @param {string} [output]
 * @returns {string|undefined}
 */
function parseTracingOpenclawVersionFromOutput(output) {
  const text = String(output || "");
  const match = text.match(new RegExp(`${TRACING_VERSION_MARKER}=(.*)`));
  const value = match ? match[1].trim() : "";
  return value ? value : undefined;
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
 *   Also reads `tracing_capability`/`tracing_capability_checked_at` off this
 *   row, when present, to decide whether the plugin check below is due —
 *   see `shouldCheckTracingCapability`. A caller whose own SELECT doesn't
 *   carry those columns (e.g. a deliberate operator toggle re-apply) should
 *   pass `options.forceCapabilityCheck: true` instead of relying on the
 *   absent columns defaulting to "always check".
 * @param {Object} [deps] - Test seams: dbClient, authSync.
 * @param {Object} [options] - `{ forceCapabilityCheck?: boolean }` — skip
 *   the throttle and always attempt the plugin check when true (used for a
 *   deliberate, one-shot operator settings change, never for the recurring
 *   30s reconcile loop).
 * @returns {Promise<{applied: boolean, skipped?: string, delta?: Object}>}
 */
async function applyTracingConfig(agent, deps = {}, options = {}) {
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
  const configMergeCommand = buildOpenClawConfigMergeCommand(delta);

  // "Due" = the throttle says it's time to look again (forced, unknown
  // verdict, or the recheck interval elapsed) -- distinct from `checkCapability`
  // below, which is whether we actually end up running the expensive,
  // network-touching plugin install this time. A known verdict due for
  // recheck still gets a cheap, local `openclaw --version`-only probe first;
  // the real check only runs if that probe shows something actually changed.
  const dueForCapabilityCheck =
    settings.traces_enabled &&
    (options.forceCapabilityCheck || shouldCheckTracingCapability(agent));

  let checkCapability = dueForCapabilityCheck;
  if (
    dueForCapabilityCheck &&
    !options.forceCapabilityCheck &&
    agent.tracing_capability &&
    agent.tracing_capability !== "unknown"
  ) {
    let probedVersion = "";
    try {
      const probeResult = await applyConfigMergeCommand(
        agent,
        buildProbeOpenclawVersionCommand(),
        deps,
      );
      probedVersion = extractCommandOutput(probeResult).trim();
    } catch {
      // Unreachable/errored probe -- fall through and let the real check
      // (if it also fails) fail the normal, already-established way rather
      // than silently trusting a stale verdict off an inconclusive probe.
    }
    if (probedVersion && probedVersion === agent.tracing_openclaw_version) {
      checkCapability = false;
    }
  }

  // Plugin step must run BEFORE the config merge: the merge's own trailing
  // step re-reads openclaw.json and (per OpenClaw's config watcher) can
  // reconnect diagnostics wiring against whatever plugin state already
  // exists at that moment — installing/enabling first, then merging config,
  // matches the order the plugin's own docs show for a fresh setup.
  const command = checkCapability
    ? [buildEnableTracingPluginCommand(), configMergeCommand].join("\n")
    : configMergeCommand;

  if (dueForCapabilityCheck) {
    // Refresh the throttle clock whenever we looked at all this tick --
    // whether that meant the cheap version-only probe found nothing changed,
    // or the full plugin check ran. Recorded BEFORE running `command` (which
    // may still be the expensive path), not after, so a hang or timeout
    // still starts the recheck-interval clock -- otherwise a single stuck
    // attempt would look identical to "never tried" on the next tick and
    // get retried immediately, indefinitely, which is the exact pile-up
    // this throttle exists to prevent.
    const dbClient = lazyDb(deps);
    try {
      await dbClient.query(`UPDATE agents SET tracing_capability_checked_at = NOW() WHERE id = $1`, [
        agent.id,
      ]);
    } catch {
      // Best-effort -- worst case this attempt isn't throttled correctly,
      // no worse than before this change existed.
    }
  }

  const result = await applyConfigMergeCommand(agent, command, deps);

  let tracingCapability;
  let tracingOpenclawVersion;
  if (checkCapability) {
    const output = extractCommandOutput(result);
    tracingCapability = parseTracingCapabilityFromOutput(output);
    tracingOpenclawVersion = parseTracingOpenclawVersionFromOutput(output);
    if (tracingCapability) {
      const dbClient = lazyDb(deps);
      try {
        await dbClient.query(
          `UPDATE agents
              SET tracing_capability = $1, tracing_openclaw_version = $2, tracing_capability_checked_at = NOW()
            WHERE id = $3`,
          [tracingCapability, tracingOpenclawVersion || null, agent.id],
        );
      } catch {
        // Best-effort, matching the rest of this module's persistence —
        // the next reconcile tick re-derives and re-persists this anyway.
      }
    }
  }

  return { applied: true, delta, workspaceId, settings, tracingCapability, tracingOpenclawVersion };
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
              host, runtime_host, runtime_port, gateway_host, gateway_port,
              tracing_capability, tracing_capability_checked_at
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
  buildEnableTracingPluginCommand,
  parseTracingCapabilityFromOutput,
  parseTracingOpenclawVersionFromOutput,
  buildProbeOpenclawVersionCommand,
  shouldCheckTracingCapability,
  TRACING_CAPABILITY_RECHECK_INTERVAL_MS,
  resolveAgentWorkspaceId,
  resolveWorkspaceLogSettings,
  applyTracingConfig,
  reconcileTracingConfig,
};
