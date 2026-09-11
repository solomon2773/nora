# Phase 7 — Export Endpoint

**Plan doc:** "Phase 7: Export Endpoint" (line 1231).

**Objective:** let an operator download a filtered log range as streamed
NDJSON or CSV, without buffering the whole export in memory.

**Code:** `backend-api/routes/observability.ts` (`GET /logs/export`),
`backend-api/logSearch.ts` (`streamLogExport`).

**Unit tests:** `backend-api/__tests__/logExport.test.ts` covers format
correctness (NDJSON/CSV shape, CSV escaping, `Content-Disposition`) and
the over-cap rejection, against fake data.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Export actually **streams** rather than buffering — memory stays bounded across a large real range | When exporting a large amount of log history, does Nora stream the download as it goes (steady memory use) — instead of loading the whole export into memory first, which could crash the process on a big export? | [ ] planned | The one test in this phase that's genuinely infra-shaped rather than a request/response format check: generate enough real flushed segments (across many agents, or one agent left running a while) to make a naive buffer-everything implementation's memory footprint obviously different from a streaming one, watch `docker stats worker-provisioner`/`backend-api` RSS during the request rather than just checking the response is eventually correct. |
| 2 | **A real search and a real export over the identical recent time range disagree** — export silently omits lines still sitting in the worker's live buffer, which search includes | If you export the last few minutes of an agent's logs right after it wrote them, do you get the same lines a search over that exact same range would show you — or does the export quietly skip whatever hasn't flushed to storage yet? | [ ] planned | Found while auditing this README against the actual code, not from the plan doc's own Tests list: `streamLogExport` (`backend-api/logSearch.ts:715`) calls only `selectCandidateSegments`/`fetchSegmentLines` — storage-only. It never calls `fetchWorkerBufferOverHttp`, the internal worker-provisioner call `searchLogs` uses to close the recency gap (Phase 6 item 7). So export and search, given the same filters, are not actually equivalent for a range that includes the last ~15 minutes — a real behavioral divergence between two endpoints the plan describes as taking "the same filters." Needs a live agent, a line written seconds ago (still unflushed), and a same-range search vs. export comparison — same shape as Phase 6's row 2, just checking non-equivalence instead of the recency gap being closed. |
| 3 | An over-cap range is rejected with a clear error before any streaming begins | If someone asks for a way-too-large export, does Nora reject it right away with a clear message — instead of starting a huge, possibly-never-finishing download? | Covered by unit tests | Fake data — no real infra condition changes this validation-order logic. Not duplicated here. |
| 4 | NDJSON export matches the equivalent search result set; export is workspace-scoped identically to search | Does the exported NDJSON contain exactly what a search over the same filters would return, and is export gated by workspace access the same way search is? | Covered by unit tests | Both are in `backend-api/__tests__/logExport.test.ts` ("NDJSON export output matches the equivalent search result set exactly", "export is workspace-scoped identically to search") — but only against fake segment data with a mocked buffer fetch, which is exactly what let row 2's divergence go unnoticed. The equivalence these unit tests assert holds for already-flushed data; it does not hold for the live-buffer window, which is row 2's gap. |
| 5 | NDJSON/CSV format correctness, `Content-Disposition` filename | Is the exported file actually valid NDJSON/CSV (with special characters like commas and quotes escaped correctly), and does it download with a sensible filename? | Covered by unit tests | Pure formatting logic — no infra condition involved. |

This phase is thinner than most in the suite — most of its real test
surface (format correctness, cap validation, result-set equivalence
against flushed data) is exactly the kind of thing unit tests already do
well. What isn't well-covered is genuinely infra-shaped: whether
streaming actually bounds memory (row 1), and row 2's real divergence
between search and export over the live-buffer window, which no unit
test with a mocked buffer fetch could have caught. Both are good targets
for a follow-up once the auth helper (see Phase 5's README) exists —
`GET /logs/export` needs a real JWT like every other endpoint-level test
in Phases 6-7.
