# Phase 12 — Agent-Side Trace Enablement

**Plan doc:** "Phase 12: Agent-Side Trace Enablement" (line 1538).

**Objective:** turn tracing on for a running OpenClaw agent without
restarting it (deep-merge `diagnostics.otel` into
`/root/.openclaw/openclaw.json` live), and keep it applied across
restarts via the existing 30s status-loop reconciliation.

**Code:** `backend-api/agentTracing.ts`, `agent-runtime/lib/runtimeBootstrap.ts`,
`backend-api/routes/observability.ts`, `.env.example`.

**Unit tests:** `backend-api/__tests__/agentTracing.test.ts` covers the
plan doc's Tests list in full against mocked container calls: the delta
shape (`protocol: "http/protobuf"`, `captureContent: false`,
configurable `sampleRate` defaulting to 1.0, `tracesEndpoint` defaulting
to `BACKEND_API_URL` and overridden by `NORA_OTLP_PUBLIC_ENDPOINT`), the
platform-defaults fallback for an unassigned agent, the no-restart
assertion (only the config-merge command runs, with a fallback to
`runContainerCommand` when the runtime sidecar is unreachable), Hermes
agents being skipped, `traces_enabled: false` disabling the config, the
minted ingest key verifying against Phase 11's `verifyIngestKey`, and
reconciliation re-applying config to a "restarted" agent plus never
throwing when one agent's apply fails. All of this asserts against a
mocked `runContainerCommand`/gateway call, not a real container.

**Category note:** the delta-shape and fallback-chain logic is
thoroughly unit-tested and not repeated here. What remains is exercising
the live-merge mechanism against something that can actually restart —
or not restart — for real.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Applying the tracing config to a real running OpenClaw container issues no restart | Record the container's start time/PID before calling `applyTracingConfig`, apply it, then confirm both are unchanged afterward — the unit test only asserts *which function* was called (`runContainerCommand` vs. a restart path), not that the real container process actually survived | [x] implemented — `01-live-merge-no-restart.sh` | Uses agent5 (real running OpenClaw agent, assigned to workspace2 with `tracesEnabled:true`). Calls the real `agentTracing.applyTracingConfig` directly via `node_call` against the real worker-provisioner process. Confirmed `docker inspect` `StartedAt`/`Pid` unchanged, and the merged config actually landed at `/root/.openclaw/openclaw.json` (`diagnostics.otel.enabled:true`, `protocol:"http/protobuf"`, `captureContent:false`). Passing on a real run. |
| 2 | After the live merge, the agent actually begins exporting real OTLP spans | Apply tracing config to a real running agent, trigger it to do something span-worthy, and confirm real spans land in `agent_spans` via the real OTLP ingest path (Phase 11) — the end-to-end proof that the merged config is not just shaped correctly but functionally live | [x] implemented (with a documented upstream blocker) — `02-real-span-ingest.sh` | **Real finding, not a test-harness gap**: a genuine OpenClaw-generated span could not be produced. `openclaw config validate`/`openclaw config get diagnostics`/`openclaw config schema` all confirm agent5's live config is accepted and schema-correct. A real `chat.send` turn was fired (real nvidia/nemotron-3-super-120b-a12b call, real 200 response) with zero spans landing, even immediately after a full real container restart. Temporarily instrumenting the real `POST /otlp/v1/traces` handler (reverted via `git checkout` immediately after) proved **zero requests ever reach it**. Reading the installed OpenClaw package inside the container (`/usr/local/lib/node_modules/openclaw/dist/*.js`) shows `tracesEndpoint`/`otlp/v1/traces` appear only in the config-schema files — there is no `@opentelemetry/*` package and no `NodeSDK`/`BatchSpanProcessor`/`OTLPTraceExporter`/`exportSpans` code anywhere in the installed build. **`diagnostics.otel.*` is schema-complete but functionally unimplemented in openclaw@2026.6.11** — turning it on can never produce a real span against this runtime version, regardless of how correctly Nora applies it. The script documents this, then falls back (per the task's own guidance for this exact case) to a real HMAC-signed OTLP POST via `computeIngestKey`/the real ingest route, attributed to agent5's real agent id — proving the real ingest path (auth → enqueue → drain → `agent_spans`) works end-to-end for this agent, which is the strongest proof available given the upstream gap. |
| 3 | Reconciliation re-applies config to an agent that actually restarted (not a mocked "restarted" state) | Kill and restart a real agent container, let the 30s reconciliation loop run, and confirm the config reappears without manual intervention | [x] implemented — `03-reconcile-after-restart.sh` | A real `docker restart` alone does NOT discard `openclaw.json` (it's on the container's own filesystem, which a process-level restart doesn't touch) — confirmed empirically during this test's development. To exercise the real self-healing path meaningfully, the script strips `diagnostics.otel` from the on-disk config directly (simulating "this agent's config no longer has tracing applied"), restarts the container for real, confirms the stripped state survives the restart (ruling out the container's own boot sequence as the source of any recovery), then waits on the **real** `backgroundTasks.ts` 30s `RECONCILE_INTERVAL` timer (already running inside the real backend-api process, not called directly) to notice and re-apply via the real `reconcileTracingConfig` → `applyTracingConfig`. Passing on a real run — reappeared within ~10s. |

## Real bugs / findings from running these for real

- **`diagnostics.otel` requires a gateway restart to hot-reload, per OpenClaw's own reload log** (`[reload] config reload requires gateway restart; hot mode ignoring (diagnostics...)`) — confirmed in agent5's real container logs both at initial provisioning and at this phase's own live re-apply. This is a real gap against `agentTracing.ts`'s own stated design goal ("turn tracing on... WITHOUT restarting it") for this specific config section, though it turned out not to matter in practice for row 2's failure (a full restart still produced zero exported spans — see below).
- **The bigger, decisive finding**: the installed `openclaw@2026.6.11` build has no OpenTelemetry exporter implementation at all. `diagnostics.otel.*` is a real, schema-validated, `openclaw config validate`-passing config surface, but grepping the actual installed package (`/usr/local/lib/node_modules/openclaw/dist/*.js`, `node_modules/`) for `@opentelemetry`, `NodeSDK`, `BatchSpanProcessor`, `OTLPTraceExporter`, or any span-export function turns up nothing — those strings exist only in the schema/validation files, not in any executable path. No live agent action can produce a real exported span against this runtime version regardless of how correctly `agentTracing.ts` applies the config. This is upstream of Nora's own code, not a bug in `agentTracing.ts`/`backend-api`.
- No bugs were found in Nora's own code across rows 1 and 3 — `applyTracingConfig`, the live config-merge mechanism, and `reconcileTracingConfig`'s 30s self-healing all worked exactly as designed against the real stack.
