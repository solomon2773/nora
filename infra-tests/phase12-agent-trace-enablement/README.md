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
| 1 | Applying the tracing config to a real running OpenClaw container issues no restart | Record the container's start time/PID before calling `applyTracingConfig`, apply it, then confirm both are unchanged afterward — the unit test only asserts *which function* was called (`runContainerCommand` vs. a restart path), not that the real container process actually survived | [ ] planned | Needs a real OpenClaw container from `agent.sh`-style provisioning (or an equivalent), plus a way to read `docker inspect`'s `StartedAt`/`Pid` before and after. |
| 2 | After the live merge, the agent actually begins exporting real OTLP spans | Apply tracing config to a real running agent, trigger it to do something span-worthy, and confirm real spans land in `agent_spans` via the real OTLP ingest path (Phase 11) — the end-to-end proof that the merged config is not just shaped correctly but functionally live | [ ] planned | Depends on Phase 11's real-infra harness (span-ingest drain) existing first, plus a real OpenClaw container capable of actually emitting OTLP traffic — heavier setup than most rows in this suite. |
| 3 | Reconciliation re-applies config to an agent that actually restarted (not a mocked "restarted" state) | Kill and restart a real agent container, let the 30s reconciliation loop run, and confirm the config reappears without manual intervention | Straddles both | The unit test simulates "restarted" by asserting reconciliation re-applies when config is absent; the fully real version — a real container restart under a real timer tick — is the infra-shaped half of this same scenario and isn't covered. |

## Blocked on

A real running OpenClaw agent container provisioned the way
`infra-tests/lib/agent.sh` (in the `logging-integration` worktree)
provisions one for other phases — no such harness exists in this
worktree yet, and OpenClaw-capable (not plain-alpine) containers are a
heavier provisioning cost than what the existing `agent.sh` pattern
covers.
