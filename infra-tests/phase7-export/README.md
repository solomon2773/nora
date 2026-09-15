# Phase 7 — Export Endpoint

**Plan doc:** "Phase 7: Export Endpoint" (line 1231).

**Objective:** let an operator download a filtered log range as streamed
NDJSON or CSV, without buffering the whole export in memory.

**Code:** `backend-api/routes/observability.ts` (`GET /logs/export`),
`backend-api/logSearch.ts` (`streamLogExport`).

**Unit tests:** `backend-api/__tests__/logExport.test.ts` covers format
correctness (NDJSON/CSV shape, CSV escaping, `Content-Disposition`) and
the over-cap rejection, against fake data. Its "streamLogExport recency
gap" block additionally covers row 2's guarantee with injected deps —
buffer/storage overlap resolution, `q`/`levels`/window filtering of
buffered lines, and the degraded-worker header.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Export actually **streams** rather than buffering — memory stays bounded across a large real range | When exporting a large amount of log history, does Nora stream the download as it goes (steady memory use) — instead of loading the whole export into memory first, which could crash the process on a big export? | [ ] planned | The one test in this phase that's genuinely infra-shaped rather than a request/response format check: generate enough real flushed segments (across many agents, or one agent left running a while) to make a naive buffer-everything implementation's memory footprint obviously different from a streaming one, watch `docker stats worker-provisioner`/`backend-api` RSS during the request rather than just checking the response is eventually correct. |
| 2 | **A real search and a real export over the identical recent time range agree** — including lines still sitting in the worker's live buffer | If you export the last few minutes of an agent's logs right after it wrote them, do you get the same lines a search over that exact same range would show you — or does the export quietly skip whatever hasn't flushed to storage yet? | [x] implemented — `01-search-export-recency-parity.sh` | Was a real, confirmed divergence, found by auditing this README against the actual code rather than from the plan doc's own Tests list: `streamLogExport` called only `selectCandidateSegments`/`fetchSegmentLines` — storage-only — and never `fetchWorkerBufferOverHttp`, the internal worker-provisioner call `searchLogs` uses to close the recency gap (Phase 6 item 7). Export and search were therefore not equivalent for any range touching the last ~15 minutes, despite both being documented as taking "the same filters." **Fixed** in `backend-api/logSearch.ts`: `streamLogExport` now performs the same buffer-first read (`readBufferSnapshots`) and storage-wins admission (`admitRecencyGapLines`) that search does, with buffered lines written in the export's chronological tail. Two things fixed alongside it, both affecting search equally since the admission path is shared: buffered lines are now held to the caller's `q`/`levels` filters (previously the only lines in a result no filter was ever applied to) and clipped to the requested time window. An unreachable worker degrades to storage-only via an `X-Nora-Log-Warning` response header rather than failing, since a stream has no envelope for search's `warning` field. This script asserts the parity end-to-end against a live agent with a deliberately unflushed buffer; the unit-test counterpart is `logExport.test.ts`'s "streamLogExport recency gap" block. |
| 3 | An over-cap range is rejected with a clear error before any streaming begins | If someone asks for a way-too-large export, does Nora reject it right away with a clear message — instead of starting a huge, possibly-never-finishing download? | Covered by unit tests | Fake data — no real infra condition changes this validation-order logic. Not duplicated here. |
| 4 | NDJSON export matches the equivalent search result set; export is workspace-scoped identically to search | Does the exported NDJSON contain exactly what a search over the same filters would return, and is export gated by workspace access the same way search is? | Covered by unit tests | Both are in `backend-api/__tests__/logExport.test.ts` ("NDJSON export output matches the equivalent search result set exactly", "export is workspace-scoped identically to search") — but only against fake segment data with a mocked buffer fetch, which is exactly what let row 2's divergence go unnoticed. The equivalence these unit tests assert holds for already-flushed data; it does not hold for the live-buffer window, which is row 2's gap. |
| 5 | NDJSON/CSV format correctness, `Content-Disposition` filename | Is the exported file actually valid NDJSON/CSV (with special characters like commas and quotes escaped correctly), and does it download with a sensible filename? | Covered by unit tests | Pure formatting logic — no infra condition involved. |

This phase is thinner than most in the suite — most of its real test
surface (format correctness, cap validation, result-set equivalence
against flushed data) is exactly the kind of thing unit tests already do
well. What isn't well-covered is genuinely infra-shaped: whether
streaming actually bounds memory (row 1), and row 2's divergence between
search and export over the live-buffer window.

Row 2 is now done. The auth helper it was blocked on exists
(`infra-tests/lib/auth.sh` — `mint_jwt`/`authed_curl`, built for
phase5c), so `01-search-export-recency-parity.sh` makes the real
JWT-authenticated `GET /logs/search` and `GET /logs/export` calls this
phase always needed. Worth restating why that bug survived as long as it
did, since it generalizes: every existing unit test mocked the buffer
fetch AND used fixed historical timestamps, and `readBufferSnapshots`
skips the worker call entirely for a range whose `to` predates the
oldest possible open buffer — so the mocked buffer was never consulted
and the storage-only code path looked correct in every test. A unit test
can assert this guarantee (the new "streamLogExport recency gap" block
does), but only once someone knows to point it at a range reaching the
present.

Row 1 (streaming actually bounds memory) remains open — it needs enough
real flushed segments to make a buffer-everything implementation's RSS
obviously different from a streaming one, watched via `docker stats`
during the request.
