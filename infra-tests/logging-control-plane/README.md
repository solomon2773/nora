# infra-tests/logging-control-plane/

Chaos/fault-injection and crash-consistency tests for the logging control
plane's infra-heavy phases (segment writer, log collector, retention
sweeper, storage migration, search, export). This is deliberately **not**
part of `e2e/` — `e2e/` is Playwright, browser-driven tests of user-facing
flows. Nothing here touches a browser; these tests kill processes,
disconnect networks, and mutate database state directly, then assert on
what survived. That's a different, standard category of testing —
[chaos engineering](https://en.wikipedia.org/wiki/Chaos_engineering) (the
Netflix Chaos Monkey lineage) crossed with crash-consistency testing (the
[Jepsen](https://jepsen.io/) style: kill something mid-operation, verify
the durable state is still correct).

It's also not a replacement for the unit tests already in
`workers/provisioner/*.test.js` and `backend-api/__tests__/*.test.ts` —
those verify logic with mocked time/IO/storage, fast and deterministic.
This suite verifies the system survives what mocks can't simulate: a real
`SIGKILL`, a real Docker container restart, real disk filling up, a real
network partition to S3. In this session alone, testing this way (by
hand, before this suite existed) found one real production bug that every
unit test and code review missed: `retentionSweeper.startRetentionSweeper()`
was fully implemented and tested in isolation, but never actually called
from `worker.ts` — so the capacity-halt state, hourly retention sweep, and
daily reconciliation had never run in production. That's the class of bug
this suite exists to keep catching.

## A real, confirmed timing gap: the 10s shutdown deadline

Running this suite for real also surfaced a second finding, this one in
the shutdown path itself: `worker.ts`'s shutdown coordinator races
`segmentWriter.flushAll()` against its own internal 10000ms deadline and
exits either way. This is not hypothetical — confirmed directly from
worker-provisioner's own logs during a live repro:

```
[shutdown] received SIGTERM, starting graceful shutdown (deadline 10000ms)
[shutdown] flushAll did not complete within 10000ms — exiting anyway. Any lines
not yet durably flushed will be re-ingested on the next collector attach via
the last successfully flushed cursor...
```

Sometimes the flush lands in under a second; sometimes it loses this race
and the buffered segment is never written at all — reproduced on a
completely ordinary local flush, with nothing artificially slowed down.
The code already anticipates this (the log message above describes the
mitigation: replay from the last flushed cursor on the next reconcile
attach, provided the source container is still around), so this reads as
a known, accepted tradeoff rather than an oversight — but it meant almost
every script in this suite that uses "SIGTERM the worker to force a
flush, then assert on the resulting segment" as its OWN setup step was
exposed to an unrelated, intermittent chance of asserting against zero
segments. `lib/docker_ctl.sh`'s `force_flush_via_sigterm` absorbs that at
the one place scripts ask "did my flush happen" (see its header for
which call sites intentionally do NOT use it — the tests whose whole
point IS this exact race, like `segment-writer/01-sigterm-flush.sh`
and `04-retry-and-park.sh`, and the second flush in
`03-capacity-gate-real-data.sh` where "nothing flushed" is the correct
expected outcome). Whether the product's own 10s deadline itself should
change is a separate, real question this suite surfaced but does not
answer — flagging it here rather than silently working around it.

## Why this lives in the repo, not a throwaway branch

Chaos/crash tests only pay for themselves if they get re-run — the next
time someone touches `segmentWriter.ts`, `logCollector.ts`, or
`retentionSweeper.ts` is exactly when a regression here would reappear. A
suite that lived only in one worktree and never merged would provide zero
protection against that. It's **opt-in and destructive by design**, never
wired into CI or `npm test` — run deliberately by a human before/after
touching this subsystem, the same way `e2e/scripts/run-kind-k8s-smoke.sh`
is a real, versioned, but manual smoke test today.

## Structure

```
infra-tests/
├── lib/                        shared bash helpers (see below)
├── results/                    results/*.jsonl (gitignored) — one file per run
├── segment-writer/      README + numbered test scripts
├── log-collector/
├── retention-sweeper/
├── storage-migration/
├── deletion-recovery/
├── search/
├── export/
├── frontend-runtime-lens/
├── gateway-rpc-client/
├── gateway-log-collector/
├── otlp-ingest/
├── agent-trace-enablement/
├── traces-lens/
├── k8s-parity/
└── run-all.sh
```

Phases 5c-14 (Stages B-E of the plan) were consolidated in from the
`logging-control-plane`, `logging-gateway-rpc`, `logging-otlp-ingest`, and
`logging-frontend-lens` worktrees once their branches merged into this
one — each phase's README documents the "Unit tests" coverage it was
audited against and what's still `[ ] planned`; several (5c, 9, 10, 11,
12, 13) are matrix-only or partially scripted, still blocked on the
harnesses their own READMEs' "Blocked on" sections describe (a real
OpenClaw gateway for 9/10/12, a live-Kind cluster for 14's rows 1-2).
Phases 0, 1, 2, and 15 have no directory here by design — pure
schema/parser/docs work with no infra-chaos surface (see each merged
branch's own phase README audit for the reasoning).

Each test directory's `README.md` documents that phase's full test matrix (every
scenario from the plan doc's own "### Tests" list, translated into a
concrete infra-level scenario), marked `[x]` implemented or `[ ]` planned
— so the matrix is complete even before every script is written, and
nobody has to cross-reference the plan doc to see what's covered.

## Running

Every script (and `run-all.sh`) refuses to run without an explicit
confirmation, since these are destructive:

```bash
# One test, while iterating on it — usually faster than a full batch run
INFRA_TESTS_CONFIRM=yes-i-know ./log-collector/01-worker-kill-midwindow.sh

# One phase
INFRA_TESTS_CONFIRM=yes-i-know ./run-all.sh log-collector

# Everything implemented
INFRA_TESTS_CONFIRM=yes-i-know ./run-all.sh
```

Requires the dev stack up (`docker compose up -d` from the repo root) and
a Postgres `users` row to exist (any real user — tests provision their own
throwaway agents owned by the first user found, never touching your real
agents).

**Portability note:** these scripts target bash 3.2 (what macOS ships by
default) — no `mapfile`/`readarray`, no associative arrays. If you're on
Linux with bash 4+, everything still works; the constraint is one-directional.

## Safety model

- **Dedicated test agents, never your real ones.** `lib/agent.sh` spins up
  a minimal alpine container (just emits an incrementing counter — the
  application code under test doesn't care what's inside the container,
  only that `containerManager.logs()` can follow it) plus a matching
  `agents` row, and tears both down afterward, including any
  `log_segments`/`log_segment_legacy_copies` rows the test caused.
- **Explicit confirmation required.** `INFRA_TESTS_CONFIRM=yes-i-know` must
  be set — no flag alone, no default-yes. Every script calls
  `require_confirmation` before touching anything.
- **Cleanup runs on any exit path.** Every script traps `EXIT` and tears
  down what it provisioned whether it passed, failed, or crashed partway
  through. `cleanup_orphaned_test_containers` (containers) and
  `cleanup_orphaned_test_agents` (DB rows) — both called at the start of
  every agent-provisioning script — are the safety net for a PRIOR run
  that didn't get that far (a hard kill skips the `EXIT` trap; a graceful
  stop or Ctrl-C does not).
- **Real services get restarted, not left down.** Any script that kills
  `backend-api`/`worker-provisioner` brings it back up before exiting,
  regardless of pass/fail.
- **Migration tests are genuinely isolated from other agents' data — by
  quarantine, not by convention.** `storageMigration.ts`'s
  `migrateSegmentBatch` migrates every segment on the current
  `storage_backend` installation-wide — it has no per-agent scope, because
  a real destination migration genuinely is a platform-wide operation.
  This is not hypothetical: an earlier version of this suite, run against
  this session's real dev stack, migrated two real agents' local log
  segments to the test MinIO bucket (and deleted their local copies in
  the process) — a migration job created by a test doesn't distinguish
  "this test's data" from "whatever else happens to be `local` right
  now." Every `storage-migration/` script now calls
  `quarantine_foreign_local_segments` (`lib/quarantine.sh`) right after
  provisioning and flushing its own agent(s) and before touching the
  destination or creating any job: every OTHER agent's `local` segment is
  temporarily reassigned to a sentinel `storage_backend` value the
  product never matches, making it invisible to the job's own query for
  the duration of the test. This is real isolation built on the same
  mechanism the product's own migration query already trusts (a literal
  `storage_backend` column match), not a product code change and not a
  refusal-to-run — every storage-migration script can run regardless of
  what else exists, while being structurally unable to touch it.
  `restore_any_stuck_quarantined_segments`, called at the start of every
  storage-migration script, is the safety net for a prior run that crashed hard
  enough to skip its own cleanup trap (mirrors
  `cleanup_orphaned_test_agents`'s role for agent rows). An earlier
  version used a hard-block pre-flight check
  (`assert_only_test_local_segments`) that refused to run when any other
  local segment existed at all; that was replaced because it made one
  test's leftover state block every later test from running — quarantine
  gets both properties at once (nothing blocks, nothing foreign gets
  touched).

## Result format

Each test appends one JSON object to `results/run-<timestamp>.jsonl`:

```json
{"phase":"log-collector","test":"01-worker-kill-midwindow","status":"pass","duration_ms":94213,"started_at":"2026-09-10T19:04:11Z","details":"segment_lines=101 within [98, 106] — crash-and-replay lost nothing and duplicated nothing"}
```

JSON Lines rather than a single JSON array or a markdown report: it's
append-safe (a crashing script never corrupts previously-written lines,
unlike a single JSON array that needs its closing bracket written last),
trivially greppable/parseable for later tooling (`jq`, a trend dashboard,
whatever), and it's the format the chaos-engineering tooling ecosystem
(Chaos Toolkit, Litmus) already converges on for exactly this reason.
`run-all.sh` prints a live human-readable summary on top of writing this
file — nobody has to read raw JSON to see what happened, but the record is
there when something needs to be diffed against a previous run.

## Shared helpers (`lib/`)

- **`common.sh`** — `require_confirmation`, `test_start`/`test_pass`/
  `test_fail` (result recording + live output), `log_info`/`log_warn`/
  `log_step`, timing helpers.
- **`db.sh`** — `db_query`/`db_exec` wrapping `docker compose exec postgres
  psql`, always with `-q` (see the comment in the file for why — `-t`
  alone does not suppress DML command-completion tags like `INSERT 0 1`,
  which will silently corrupt a `RETURNING`-based capture otherwise).
- **`docker_ctl.sh`** — `compose` (run compose from the repo root
  regardless of cwd), `wait_for_healthy`, `start_log_emitter`,
  `cleanup_orphaned_test_containers`, and `force_flush_via_sigterm` — see
  "A real, confirmed timing gap" above for why most SIGTERM-forced-flush
  setup steps in this suite use it instead of a bare `compose stop`/`up`.
- **`agent.sh`** — `provision_test_agent`/`teardown_test_agent`: a
  throwaway agent backed by a real Docker container, for exercising the
  real `containerManager.logs()` → collector → writer path without the
  cost/complexity of provisioning a full OpenClaw/Hermes runtime. See the
  file header for why a plain alpine container is sufficient — the guarantees
  under test live entirely in how Nora reads and stores the log stream, not
  in what the source container is running. Also `cleanup_orphaned_test_agents`
  — the DB-row counterpart to `cleanup_orphaned_test_containers` below.
- **`local_cap.sh`** — temporarily overrides `NORA_LOG_LOCAL_MAX_BYTES`,
  restoring the original value afterward. Documents a real gotcha:
  changing it requires recreating (not just restarting) `worker-provisioner`
  /`backend-api`, which also resets `retentionSweeper.ts`'s in-memory
  capacity-state singleton — see the file's header and Phase 5's README for
  why that matters for test design.
- **`node_call.sh`** — runs a JS snippet inside the real, running
  worker-provisioner container with real DB/encryption-key access, calling
  `retentionSweeper.ts`/`storageMigration.ts`'s exported functions
  directly — no HTTP, no JWT. Works around `docker compose exec` not
  re-running the container's entrypoint (which is what normally resolves
  `DB_PASSWORD`/`ENCRYPTION_KEY`/etc. from their Docker secret files) by
  replicating that one resolution step itself. This is what makes most of
  Phase 5's and Phase 5b's core-logic tests possible without an auth helper.
- **`storage_dest.sh`** — temporarily points the platform-wide log storage
  destination at the local MinIO test instance (with or without real
  working credentials, depending on what a test needs), capturing and
  restoring the exact previous destination row (including encrypted
  credential columns, copied verbatim — never decrypted/re-encrypted by
  this helper) afterward.
- **`minio_ctl.sh`** — thin `mc` wrapper (object existence/count checks)
  against the same MinIO instance, parallel to `db.sh`'s role for the
  object-storage side of an assertion.
- **`quarantine.sh`** — real isolation for migration tests: temporarily
  reassigns every OTHER agent's `local` segment to a sentinel
  `storage_backend` value so a test's own migration job (platform-wide by
  design, see Safety model above) can't see or touch them. Every
  `storage-migration/` script calls `quarantine_foreign_local_segments`
  before creating a job and relies on its own `cleanup()` trap calling
  `restore_quarantined_local_segments` to put things back; `restore_any_stuck_quarantined_segments`
  at each script's start is the crash-safety net, mirroring
  `cleanup_orphaned_test_agents`'s role for agent rows.

## Adding a new phase's tests

Follow the existing directories as a template: a `README.md` with the
phase's objective (copy from the plan doc), why it needs infra-level
testing specifically (not just "more unit tests" — what does a mock hide
here?), and a full test matrix; then numbered scripts (`01-`, `02-`, ...)
each sourcing `lib/common.sh` + whatever else it needs, calling
`require_confirmation`, `test_start`, and exactly one of `test_pass`/
`test_fail`, with a `trap cleanup EXIT`.
