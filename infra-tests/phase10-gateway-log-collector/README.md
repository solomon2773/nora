# Phase 10 — Gateway Log Collector

**Plan doc:** "Phase 10: Gateway Log Collector" (line 1396).

**Objective:** poll `logs.tail` per running OpenClaw agent with
`gateway_logs_enabled` and write `gateway`-stream segments carrying trace
context. Persists cursor per source kind in `agent_log_cursors` after
each successful flush (never in-memory only), resets cursor scope on a
`{"type":"meta"}` source-kind transition (log rotation is one such
transition), adapts poll interval (fast while lines flow, backs off when
quiet, snaps back on the next non-empty response), normalizes lines
through `normalizeGatewayLogLine`, drops lines already past resolved
retention at ingest, applies a second pattern-based redaction pass on
ingest, and sets/reconciles `consoleLevel: warn` on OpenClaw agents so
runtime and gateway streams don't duplicate every line forever.

**Code:** `workers/provisioner/logs/gatewayCollector.ts`,
`workers/provisioner/logs/redaction.ts`.

**Unit tests:** `workers/provisioner/gatewayCollector.test.js` exists and,
like the Phase 9 suite, is already thorough — Node's built-in test
runner, fakes for `db`/`segmentWriter`/`gatewayClient` passed in via a
`deps` object, no real timers (`pollAgentGatewayLogs`/`reconcileStreams`
called directly). It covers every item on the plan doc's own Tests list
with a fake DB and fake gateway client:

- cursor persists across a simulated worker restart (a brand-new
  `cursorState` object standing in for the restart, re-deriving the
  cursor from the fake `db` rather than starting from null) — asserts no
  duplicate and no gap across the two "processes"
- a `{"type":"meta"}` record mid-batch updates only the new source kind's
  cursor, leaving the old kind's cursor untouched
- a rotation-shaped meta record (no explicit `sourceKind`) splits one
  poll's batch into two runs without dropping any line
- `computeNextPollStep` backs off through `POLL_BACKOFF_STEPS_MS` on
  empty polls and snaps back to the fastest step on the next non-empty one
- `trace_id`/`span_id`/`session_id`/`channel` all survive normalization
  into the written segment line
- `redactLine`/`redactText` mask an `apiKey=`-style value, a
  `config.get`-shaped generic leak, and a bearer token, while leaving
  benign text untouched
- a Hermes-family agent is skipped by `reconcileStreams()` without
  opening a gateway client, applying console-level config, or logging a
  warning/error
- a line older than resolved retention is dropped (not appended) while
  the cursor still advances past it, so the stale backlog isn't
  reprocessed forever
- an agent found without `consoleLevel: warn` already applied gets it
  applied by a plain `reconcileStreams()` tick, not only at provisioning

Given that coverage, redaction pattern-matching and the Hermes-skip logic
are squarely and convincingly unit-tested — no real infra changes either
outcome, so neither belongs in this suite. What's left for this suite,
same as Phases 3/4, is the behavior that only a real worker process, real
wall-clock timing, and a real filesystem/gateway can exercise honestly.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Cursor persists across a real `worker-provisioner` process restart (SIGKILL, not a simulated `cursorState` swap) | Run the collector against a real agent with lines flowing, `docker compose kill worker-provisioner` mid-poll, bring it back up, and confirm the resumed poll picks up from the persisted `agent_log_cursors` row with no duplicate lines and no gap in the resulting segment. | **[x] implemented** — `01-worker-sigkill-cursor.sh` | Ran against agent2 with real chat-generated content. Found and fixed a real product bug in the process: `pollAgentGatewayLogs` treated `response.lines` as pre-parsed objects, but a real gateway returns each line as a raw JSON string — every real record was silently dropped, so no `gateway`-stream segment had ever been written in this stack's history despite the collector actively polling. Fixed in `gatewayCollector.ts`; all 12 existing unit tests still pass. Confirms cursor monotonicity and zero duplicate lines across a real SIGKILL. |
| 2 | Real log rotation at `logging.maxFileBytes` (100MB) mid-poll does not drop lines | Drive a real OpenClaw agent's log file past the configured rotation threshold while the collector is actively polling, and confirm the resulting gateway-stream segment has no gap across the rotation boundary. | **[x] implemented** — `02-log-rotation-no-drop.sh` | Ran against agent4 with `logging.maxFileBytes` shrunk to 2000 bytes via the same live config-merge mechanism `agentTracing.ts` uses. Asserts on the same structural invariants as #1 (zero duplicate lines, nonzero content) rather than per-turn markers — see the script's header for why an initial per-`runId` design was dropped (OpenClaw's own gateway log lines never carry chat content, and the `chat.send` completion line can land well after this script's fixed windows). Config restored to 104857600 in cleanup regardless of pass/fail. |
| 3 | Adaptive poll interval's real wall-clock behavior matches the scripted step sequence under a live gateway | Watch real `logs.tail` request timestamps against a live OpenClaw gateway across a flow → quiet → flow cycle, and confirm the observed intervals back off and recover per `POLL_BACKOFF_STEPS_MS`, not just that `computeNextPollStep` returns the right numbers in isolation. | **[x] implemented** — `03-adaptive-poll-timing.sh` | Ran against agent2. The precise backoff-step cadence is hard to pin down cleanly in practice: OpenClaw's gateway writes a "res ✓ logs.tail" line for every poll (including this test's own probe calls), which self-referentially keeps content flowing and makes a truly idle window hard to guarantee — logged as a data point, not hard-gated. What IS hard-gated and passed: a fresh gateway-stream segment lands within 20s of resuming activity after the quiet phase. |
| 4 | A worker restart mid-batch, immediately followed by rapid duplicate-cursor writes from two collector instances, does not corrupt the persisted cursor | Simulate an unclean handoff (old process not fully dead, new process already polling) and confirm `agent_log_cursors` doesn't end up with a cursor that regresses or duplicates lines from a race between the two writers. | [ ] planned | Not attempted — #1's harness did not make this cheap in practice (see this phase's real-agent gateway-auth flakiness noted below), and time in this session went to getting #1-#3 to a real, verified pass instead. Still worth a look if the harness gets more robust. |
| 5 | Redaction pattern-matching on real, messy transcript content (not hand-picked fixture strings) | Feed the second-pass redactor real OpenClaw transcript JSONL samples (if any sanitized samples exist) instead of the unit test's hand-picked `apiKey="sk-..."` fixture, to sanity-check the pattern list against real-world noise/false-positive rate. | Probably belongs in unit tests instead | This is a fixture-quality question, not an infra-timing one — better served by adding more cases to `gatewayCollector.test.js` than by anything this suite's chaos/process-kill machinery provides. Listed here only so it isn't silently dropped from the plan doc's Tests list. |
| 6 | A Hermes agent is skipped entirely under `reconcileStreams()`'s real 30s loop, across many mixed agents, without error | Run the real 30s reconcile loop against a mixed fleet (OpenClaw + Hermes agents) for several cycles and confirm no gateway client is ever opened for a Hermes agent and no error/warning is logged. | Covered by unit tests | The unit test already asserts this for a single `reconcileStreams()` call with a fake client that throws if invoked for the Hermes agent; a real 30s loop against a mixed fleet doesn't change the skip logic, only repeats it. Not worth a standing chaos entry. |

## Blocked on

~~Same restart/kill harness gap as Phase 9 (#2 there): needs a way to run
a real `worker-provisioner` process (or the whole dev stack) that this
suite can kill and restart deliberately, plus a real or scriptable
OpenClaw gateway to drive log rotation and adaptive-polling timing
against.~~ Resolved — real OpenClaw agents (agent2/3/4) are now
available for exactly this purpose; see the top-level `infra-tests/README.md`.

## Confirmed: a real `gateway`-stream segment does get written

As of the start of this session, zero `log_segments` rows with
`stream='gateway'` had ever existed in this stack's history, despite the
collector actively polling and persisting a real, advancing cursor for
every OpenClaw agent — an open question flagged in the original task
briefing. Root cause: `pollAgentGatewayLogs` treated `response.lines` as
already-parsed objects (matching every unit test's fake client), but a
real gateway's `logs.tail` RPC returns each line as a raw JSON-encoded
STRING — `normalizeGatewayLogLine`'s `typeof record !== "object"` guard
silently rejected every single real record. Fixed in `gatewayCollector.ts`
(the `rawRecords`/`records` parsing step in `pollAgentGatewayLogs`); all
12 existing unit tests still pass unmodified. Confirmed via
`SELECT * FROM log_segments WHERE stream='gateway'` returning real rows
for agent2/agent3/agent5 within seconds of the fix landing.

## A second real finding: OpenClaw gateway auth can wedge under heavy reconnect churn

While building and running this phase's scripts (and Phase 9's), all four
real agents at various points started rejecting every new gateway
connection — including from a brand-new client — with the gateway's own
`unauthorized: gateway token missing (provide gateway auth token)`
rejection (confirmed straight from the agent container's own log:
`[ws] unauthorized ... reason=token_missing`), despite the decrypted
token Nora holds being verified correct and unchanged. It affected
whichever agent(s) had most recently been hit hardest by this suite's own
reconnect/backoff/SSRF-rejection experiments, not consistently one agent,
and reliably cleared after restarting the affected agent's OpenClaw
container. Separately, `gatewayCollector.ts`'s own held client for an
agent, once it exhausts `MAX_RECONNECT_ATTEMPTS` and becomes
`unavailable`, never self-heals without either an `agents.status`
transition or a full `worker-provisioner` restart — confirmed directly:
after all four agents were auth-wedged and then restarted, the collector
kept repeating the exact same stale rejection for over ten minutes until
`worker-provisioner` itself was restarted, at which point every agent
reattached cleanly on the first attempt. Both are believed to be
real robustness gaps under unusually heavy chaos-testing load rather
than something a normal deployment would hit, and are flagged here for a
human to decide whether they're worth hardening (e.g., detecting a
permanently-`unavailable` client and forcing a detach/reattach on the
next reconcile tick) rather than silently worked around. All four agents
and `worker-provisioner` were left healthy at the end of this session.
