# Phase 9 — Gateway RPC Client

**Plan doc:** "Phase 9: Gateway RPC Client" (line 1354).

**Objective:** provide a gateway WebSocket RPC client usable from
`worker-provisioner`, since the existing machinery lived only in
`backend-api`. Implements the gateway's frame protocol (`req`/`res`/
`event`), authenticates via per-agent gateway token, holds one persistent
connection per agent with reconnect/backoff capped at OpenClaw's own
limits (8 retries / 30s), classifies auth vs. scope vs. network failures
distinctly, and routes through SSRF-safe target resolution rather than
dialling a raw agent-supplied address.

**Code:** `agent-runtime/lib/gatewayRpc.ts`.

**Unit tests:** `agent-runtime/__tests__/gatewayRpc.test.ts` exists and is
thorough — it already covers every item on the plan doc's own Tests list,
against a `FakeSocket` double (addEventListener/send/close/readyState)
that never touches a real socket or DNS:

- request/response correlation by `id` across interleaved concurrent
  calls, including out-of-order responses
- an `event` frame arriving mid-flight does not corrupt correlation of
  the pending request
- reconnect backoff via `computeReconnectDelay` (doubles from 1s, caps at
  30s) and the full client caps at `MAX_RECONNECT_ATTEMPTS` before
  surfacing `GatewayUnavailableError`, using `vi.useFakeTimers()` to
  drive the schedule deterministically
- auth failure (`ok:false` on the connect handshake) surfaces as
  `GatewayAuthError`, distinct from a network failure surfacing as
  `GatewayUnavailableError` with the original error preserved as `.cause`
- scope failure (`operator_read_scope_required`) surfaces as
  `GatewayScopeError`, distinct from `GatewayAuthError`
- `resolveSafeGatewayTarget` rejects a link-local/metadata-style address
  and an unspecified (`0.0.0.0`) address

Given that, every item the plan doc lists is already unit-tested
convincingly — including the reconnect-backoff and mid-flight-event
scenarios this suite would otherwise exist to cover, because
`vi.useFakeTimers()` and a scripted `FakeSocket` reproduce the *logic*
under test exactly. What a fake socket structurally cannot reproduce is a
real dropped TCP connection's timing and error shape (a half-open
connection, a slow FIN, an actual OS-level `ECONNRESET` arriving on its
own schedule instead of on `queueMicrotask`), and real concurrent network
latency across interleaved calls. This file exists to name that gap
narrowly, not to duplicate the unit suite.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Request/response correlation holds under real network jitter, not just scripted out-of-order delivery | Open a real client against a real (or reverse-proxied, jitter-injecting) OpenClaw gateway, fire several concurrent `logs.tail`/`agent.status` calls, and confirm each resolves with its own response despite real, non-deterministic latency. | Covered by unit tests | `gatewayRpc.test.ts`'s interleaved-correlation test already exercises out-of-order delivery; a real socket doesn't change the correlation *logic*, only its timing. Not worth a chaos-suite entry on its own. |
| 2 | Reconnect backoff against a real dropped connection matches the scripted 8-attempt / 30s-cap schedule | Kill the real OpenClaw gateway process (or drop its port via a firewall rule) mid-session and confirm the client's real reconnect attempts — timed by the real clock, not `vi.useFakeTimers()` — still land on the same delay sequence and give up after 8 attempts. | **[x] implemented** — `02-reconnect-backoff-real-kill.sh` | Turned out to be two real findings, not one: a `docker stop` on the agent is caught by backend-api's own container-status reconciler in ~19-26s (well before the 121s reconnect budget matters) and closes the client directly; a pure network-level partition on a LIVE connection (container alive, port blocked) never triggers the reconnect loop at all — no close/error event fires on the socket, so the client just loops forever on 30s call timeouts instead. The documented 8-attempt/121s schedule IS real and does fire — but only on a fresh attach whose first connect attempt fails, confirmed via row 5's script (`05-ssrf-block-live-connect.sh`), not via disrupting an established connection. See both scripts' headers for the full, empirically-verified writeup. |
| 3 | A real auth failure (revoked/invalid gateway token against a live gateway) surfaces as `GatewayAuthError`, not misclassified as a network failure | Point a real client at a live OpenClaw gateway with a deliberately wrong token and confirm the classification the unit tests assert with a scripted `ok:false` handshake actually holds against the gateway's real rejection frame. | Probably belongs in unit tests instead | `gatewayRpc.test.ts` already asserts this classification against a scripted handshake response; the real gateway's rejection frame shape is a contract the *gateway* owns, not something this client's retry/backoff logic can regress on its own. Worth a manual check once, not a standing chaos-suite entry. |
| 4 | A real scope failure (valid token, insufficient scope) surfaces as `GatewayScopeError` against a live gateway | Same as #3 but with a valid token lacking the `operator.read` scope family, against a real gateway. | Probably belongs in unit tests instead | Same reasoning as #3 — the classification logic is fully unit-tested; only the gateway's actual error-code contract is unverified by mocks, and that's a one-time integration check, not a repeatable chaos scenario. |
| 5 | SSRF-safe target resolution actually blocks a live connection attempt to a blocked address, not just the resolver function in isolation | Configure an agent row with `gateway_host` pointing at a real link-local/metadata address reachable from the worker's network namespace, and confirm no socket connection is ever attempted (not just that `resolveSafeGatewayTarget` throws when called directly). | **[x] implemented** — `05-ssrf-block-live-connect.sh` | Confirmed against agent2 with `gateway_host` repointed at `169.254.169.254`: the real worker.ts wiring rejects with "not an allowed gateway address" and `/proc/net/tcp` inside worker-provisioner never shows a connection to that address — no socket is ever opened. This is also the script that confirmed row 2's reconnect-backoff schedule really does fire (see row 2's Notes) — it takes ~152s (30s reconcile delay + the full 121s retry budget) for the final log line to appear, since a never-established connection retries through the whole schedule before giving up. |

## Blocked on

~~A real OpenClaw gateway process this suite can start, kill, and
firewall independently of the rest of the dev stack — none of the
existing `lib/` helpers (see the top-level `infra-tests/README.md` in the
`logging-integration` worktree) provision one today.~~ Resolved — real
OpenClaw agents (agent2/3/4) became available for exactly this purpose;
see the top-level README.

## A real finding: OpenClaw gateway auth can wedge under heavy reconnect churn

Building and running rows 2 and 5 above (heavy real reconnect/backoff and
SSRF-rejection traffic against agent2/3) eventually caused the affected
agents' OpenClaw gateway to reject brand-new connection attempts with its
own `unauthorized: gateway token missing` rejection, confirmed straight
from the agent's own container log
(`[ws] unauthorized ... reason=token_missing`) — despite the token Nora
holds decrypting correctly and unchanged throughout. Reliably cleared by
restarting the affected agent's container. Separately,
`gatewayCollector.ts`'s held client for an agent, once it exhausts
`MAX_RECONNECT_ATTEMPTS` and becomes `unavailable`, never self-heals
without an `agents.status` transition or a full `worker-provisioner`
restart — confirmed directly during this session. See
`phase10-gateway-log-collector/README.md`'s matching section for the full
writeup; both phases hit the same underlying flakiness. Believed to be a
real OpenClaw/collector robustness gap under unusually heavy load, not
something a normal deployment would hit — flagged for a human to decide
whether it's worth hardening.
