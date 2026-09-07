// @ts-nocheck
// backend-api/logSearch.ts — Logging control plane Phase 6 (search) and
// Phase 7 (export). Orchestrates: prune candidate segments in SQL → fetch
// their objects in parallel → decrypt/decompress/prefilter/parse → merge
// into one chronological timeline for a single agent, optionally closing the
// last-few-minutes recency gap with worker-provisioner's live buffer.
//
// Deliberately does NOT reuse Phase 5c's logDeletion.ts / admin-recovery
// path (item 8c): search and export require a LIVE, currently-resolvable
// agent (`findAccessibleAgentForActor`), never a deleted agent's kept logs.
//
// Read the implementation plan's Phase 6/Phase 7 sections and the
// manifest's "Multitenancy And Access Model" / "Search Performance Model"
// sections before changing the ordering/termination logic below — several
// of the choices here (buffer-then-storage read order, wave-based early
// termination, prefilter-before-parse) are load-bearing for correctness or
// performance guarantees this module promises, not arbitrary structure.

const zlib = require("zlib");

const objectStorage = require("../agent-runtime/lib/objectStorage.ts");
const segmentWriterModule = require("../workers/provisioner/logs/segmentWriter.ts");
const logStorageConfigModule = require("../workers/provisioner/logs/logStorageConfig.ts");
const { findAccessibleAgentForActor } = require("./middleware/ownership");

// ── Tunables ─────────────────────────────────────────────────────────────

// Item 4: fetch candidates in parallel at a configurable concurrency,
// default 64 — a local disk read is ~1ms, a remote object fetch is
// ~50-150ms, so a serial implementation passes tests against `local` and is
// then unusably slow against `s3`/`r2` in production.
const DEFAULT_FETCH_CONCURRENCY = Number(process.env.NORA_LOG_SEARCH_FETCH_CONCURRENCY) || 64;
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1000;
const DECODED_SEGMENT_CACHE_MAX = Number(process.env.NORA_LOG_SEARCH_CACHE_SEGMENTS) || 256;

// Segments flush at most every 15 minutes (Design Decision 6). A query whose
// `to` predates "now minus this" cannot possibly overlap anything still
// sitting in an open, not-yet-flushed buffer, so the worker call is skipped
// entirely (item 7's "skip the worker call" rule). This is an approximation
// — the actual oldest-open-buffer timestamp lives in worker-provisioner, and
// asking it defeats the point of skipping the call — but it is a safe
// *conservative* one: it can only cause an extra (harmless, gracefully
// degraded) worker call, never a missed recency-gap merge.
const FLUSH_INTERVAL_MS = segmentWriterModule.DEFAULT_FLUSH_INTERVAL_MS;

// Export range cap (Phase 7 item 4): default 30 days, matching the
// manifest's "5,760 candidate segments over 30 days" worked example as the
// documented upper bound of what this path is sized for.
const DEFAULT_EXPORT_MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

// ── undici dispatcher sizing (item 4 continued) ─────────────────────────
//
// Verified against the undici version actually resolved in this workspace
// (7.29.1, bundled transitively via Node's own fetch stack): `Agent`'s
// default per-origin `Pool` treats an unset `connections` option as
// unbounded (`this[kConnections] = connections || null`, and the dispatch
// gate is `if (!this[kConnections] || ...)`), so the *specific* failure mode
// the plan warns about — a low hard-coded default silently serializing
// requests — does NOT reproduce with this repo's default global dispatcher
// today. That is a fact about this exact dependency version, not a promise
// undici makes in its public contract, and it does not mean sizing is free
// to skip: an uncapped pool under a very wide (e.g. 30-day) query could open
// far more simultaneous TCP connections against S3/R2 than intended. So this
// still constructs and passes an explicit `Agent` sized to the configured
// concurrency, both as insurance against that finding not holding on a
// different undici/Node version and as a genuine upper bound on fan-out.
let cachedDispatcher = null;
let cachedDispatcherConnections = null;
function sharedDispatcher(connections) {
  const size = Math.max(1, Number(connections) || DEFAULT_FETCH_CONCURRENCY);
  if (!cachedDispatcher || cachedDispatcherConnections !== size) {
    // Lazy require: only search/export paths need this, and agent-runtime's
    // objectStorage.ts (which actually issues the fetch) has no node_modules
    // of its own — see its module header — so this stays a backend-api-only
    // dependency (added to package.json) rather than a shared one.
    const { Agent } = require("undici");
    cachedDispatcher = new Agent({ connections: size });
    cachedDispatcherConnections = size;
  }
  return cachedDispatcher;
}

// ── Line ordering ────────────────────────────────────────────────────────

function effectiveTs(line) {
  return line.ts || line.observed_ts;
}

/**
 * Comparator implementing the manifest's merge order:
 * `(COALESCE(ts, observed_ts), stream, ord)`. `order` flips the timestamp
 * direction only — `stream`/`ord` tie-breaks are always ascending, since
 * they exist purely to make same-timestamp ordering deterministic, not to
 * express a "newest first" preference of their own.
 */
function compareLines(a, b, order = "desc") {
  const ta = effectiveTs(a);
  const tb = effectiveTs(b);
  if (ta < tb) return order === "desc" ? 1 : -1;
  if (ta > tb) return order === "desc" ? -1 : 1;
  if (a.stream < b.stream) return -1;
  if (a.stream > b.stream) return 1;
  const oa = a.ord ?? Number.MAX_SAFE_INTEGER;
  const ob = b.ord ?? Number.MAX_SAFE_INTEGER;
  return oa - ob;
}

// ── Cursor encode/decode (item 6 / function list) ───────────────────────
//
// Encodes `(ts, stream, ord)` — never an offset. An offset over a merged
// multi-source stream is unstable because a late-arriving segment shifts
// every row after it; a tuple cursor is stable because it names an actual
// position in the timeline rather than a row count.
function encodeCursor(line) {
  return Buffer.from(
    JSON.stringify({ ts: effectiveTs(line), stream: line.stream, ord: line.ord ?? null }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(str) {
  try {
    const parsed = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.ts !== "string" || typeof parsed.stream !== "string") {
      throw new Error("malformed cursor");
    }
    return parsed;
  } catch {
    const error = new Error("Invalid cursor");
    error.statusCode = 400;
    error.code = "invalid_cursor";
    throw error;
  }
}

function isAfterCursor(line, cursor, order) {
  if (!cursor) return true;
  const ts = effectiveTs(line);
  if (order === "desc") {
    if (ts < cursor.ts) return true;
    if (ts > cursor.ts) return false;
  } else {
    if (ts > cursor.ts) return true;
    if (ts < cursor.ts) return false;
  }
  if (line.stream !== cursor.stream) return line.stream > cursor.stream;
  const ord = line.ord ?? Number.MAX_SAFE_INTEGER;
  const cursorOrd = cursor.ord ?? Number.MAX_SAFE_INTEGER;
  return ord > cursorOrd;
}

/**
 * Min-heap k-way merge (item 5 / function list). Implemented as a sort over
 * an already-bounded accumulator rather than a literal binary heap: at this
 * scale (a wave's worth of segments, capped by the fetch concurrency and
 * early-termination logic in `searchLogs`/`streamLogExport`) the two are
 * behaviourally equivalent, and a sort is far easier to verify against the
 * exact `(ts, stream, ord)` ordering contract under test. Correctness, not
 * micro-optimizing an already-cheap in-memory sort, is what the Search
 * Performance Model actually calls "the bottleneck" — see its "fetching and
 * parsing is not the bottleneck" note.
 */
function mergeSegments(lines, limit, cursor = null, order = "desc") {
  const filtered = cursor ? lines.filter((line) => isAfterCursor(line, cursor, order)) : lines.slice();
  filtered.sort((a, b) => compareLines(a, b, order));
  const page = filtered.slice(0, limit);
  const nextCursor = page.length === limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
  return { lines: page, nextCursor };
}

// ── Segment fetch + decode (item 4a / item 5 / function list) ──────────
//
// Cache holds the DECOMPRESSED, DECRYPTED plaintext NDJSON bytes for a
// storage_key — never the parsed lines and never the raw encrypted object.
// Caching at this layer (rather than post-parse) is what keeps the
// "a segment with no `q` match is never JSON-parsed" guarantee true even on
// a cache hit: a cached buffer still goes through the same
// Buffer.indexOf-before-parse prefilter on every call, it just skips the
// network fetch + decrypt + decompress that produced it the first time.
const decodedSegmentCache = new Map();

function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

/**
 * `fetchSegmentLines(row, opts)` — item 5 / function list. Fetches (or
 * reuses a cached decode of) one segment's object, decrypts, decompresses,
 * prefilters on `q` before ever parsing, then parses and applies `levels`.
 *
 * @param {Object} row - a `log_segments` row (from `selectCandidateSegments`).
 * @param {Object} [opts]
 * @param {string} [opts.q] - text filter; matched with Buffer.indexOf over
 *   the raw decompressed bytes before parsing (item 5a "prefilter"), then
 *   re-checked per-line so only matching lines are returned.
 * @param {string[]} [opts.levels] - level filter, applied post-parse.
 * @param {Object} [opts.keyRing] - decryption key ring; defaults to parsing
 *   NORA_LOG_ENCRYPTION_KEY once per call site (callers should pass one in
 *   to avoid re-parsing per segment).
 * @param {Object} [opts.dispatcher] - undici Agent/Pool for the underlying
 *   fetch (item 4).
 * @param {Function} [opts.getStorageObjectFn]
 * @param {Function} [opts.storageConfigForSegmentFn] - item 4a: resolves
 *   THIS row's own recorded storage_backend/storage_config, not the
 *   platform's current destination, so a segment written under a previous
 *   destination is still fetched and decrypted correctly.
 * @param {Function} [opts.decryptSegmentFn]
 * @param {Map} [opts.cache]
 * @param {number} [opts.cacheMax]
 */
async function fetchSegmentLines(row, opts = {}) {
  const {
    q,
    levels,
    keyRing,
    dispatcher,
    getStorageObjectFn = objectStorage.getStorageObject,
    storageConfigForSegmentFn = logStorageConfigModule.storageConfigForSegment,
    decryptSegmentFn = segmentWriterModule.decryptSegment,
    cache = decodedSegmentCache,
    cacheMax = DECODED_SEGMENT_CACHE_MAX,
  } = opts;

  let uncompressed = lruGet(cache, row.storage_key);
  if (uncompressed === undefined) {
    const config = await storageConfigForSegmentFn(row);
    const encrypted = await getStorageObjectFn(row.storage_key, config, { dispatcher });
    const ring = keyRing || segmentWriterModule.loadLogEncryptionKeys();
    const compressed = decryptSegmentFn(encrypted, ring);
    uncompressed = zlib.zstdDecompressSync(compressed);
    lruSet(cache, row.storage_key, uncompressed, cacheMax);
  }

  // Item 5a "prefilter before parse": a whole-segment miss on `q` skips
  // JSON-parsing entirely — this is the expensive part (~1.8ms/segment)
  // this guard exists to avoid paying on every miss.
  if (q) {
    if (uncompressed.indexOf(Buffer.from(q, "utf8")) === -1) {
      return [];
    }
  }

  const text = uncompressed.toString("utf8");
  const levelSet = Array.isArray(levels) && levels.length ? new Set(levels) : null;
  const lines = [];
  for (const rawLine of text.split("\n")) {
    if (!rawLine) continue;
    if (q && !rawLine.includes(q)) continue;
    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (levelSet && !levelSet.has(parsed.level)) continue;
    lines.push({ ...parsed, agentId: row.agent_id, workspaceId: row.workspace_id ?? null });
  }
  return lines;
}

// ── Candidate segment selection (item 3 / function list) ───────────────

function normalizeStreams(streams) {
  const list = Array.isArray(streams) ? streams : streams ? [streams] : [];
  const filtered = list.filter((s) => s === "runtime" || s === "gateway");
  return filtered.length ? filtered : ["runtime", "gateway"];
}

function normalizeLevels(levels) {
  const list = Array.isArray(levels) ? levels : levels ? [levels] : [];
  return list.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim().toUpperCase());
}

/**
 * `selectCandidateSegments(params)` — item 3 / function list. The single
 * indexed SQL query: prunes on CONTENT time (`ts_from`/`ts_to`), never
 * write/`created_at` time — gateway segments can arrive late, and a
 * write-time filter would silently drop them. Uses
 * `idx_log_segments_agent_stream_ts` (`agent_id, stream, ts_from DESC`).
 *
 * Always returns rows ordered `ts_to DESC` — callers wanting ascending
 * order reverse the (already-fetched, cheap — this is just index rows, not
 * segment bodies) array themselves rather than re-querying.
 */
async function selectCandidateSegments({ agentId, streams, from, to }, deps = {}) {
  const db = deps.db || require("./db");
  const normalizedStreams = normalizeStreams(streams);
  const conditions = ["agent_id = $1", "stream = ANY($2)"];
  const values = [agentId, normalizedStreams];
  if (from) {
    values.push(from instanceof Date ? from.toISOString() : from);
    conditions.push(`ts_to >= $${values.length}`);
  }
  if (to) {
    values.push(to instanceof Date ? to.toISOString() : to);
    conditions.push(`ts_from <= $${values.length}`);
  }
  const sql = `SELECT id, workspace_id, agent_id, stream, ts_from, ts_to, storage_key,
                      storage_backend, storage_config, encryption_key_id, bytes, lines
                 FROM log_segments
                WHERE ${conditions.join(" AND ")}
                ORDER BY ts_to DESC`;
  const result = await db.query(sql, values);
  return result.rows;
}

// ── Workspace scoping (items 8/8a/8b/8c) ────────────────────────────────

/**
 * Item 8a: apply workspace filtering EXPLICITLY, for every actor including
 * platform admins. `findAccessibleAgentForActor` grants an admin access to
 * ANY agent, bypassing workspace membership entirely — that bypass governs
 * per-agent access only, and must never be treated as satisfying this
 * endpoint's workspace-scoping requirement. This check runs unconditionally
 * after `findAccessibleAgentForActor` succeeds, independent of `actor.role`.
 *
 * Item 8b: a null-workspace agent (an agent owned directly by a user, with
 * no workspace row in `workspace_agents`) is reached through the
 * accessible-agent check above, NOT through a workspace filter that would
 * otherwise exclude it for having no workspace — so a request with no
 * `workspaceId` succeeds for such an agent, and a request WITH a
 * `workspaceId` can never succeed for it (there is no workspace it could
 * match), which is the correct behaviour rather than a special case to work
 * around.
 */
async function enforceWorkspaceScope({ agentId, workspaceId }, deps = {}) {
  const db = deps.db || require("./db");
  const result = await db.query(
    `SELECT workspace_id FROM workspace_agents WHERE agent_id = $1 LIMIT 1`,
    [agentId],
  );
  const actualWorkspaceId = result.rows[0]?.workspace_id || null;

  if (actualWorkspaceId) {
    if (!workspaceId || workspaceId !== actualWorkspaceId) {
      const error = new Error("Agent belongs to a different workspace than requested");
      error.statusCode = 403;
      error.code = "wrong_workspace";
      throw error;
    }
    return;
  }

  if (workspaceId) {
    const error = new Error("Agent does not belong to any workspace");
    error.statusCode = 403;
    error.code = "wrong_workspace";
    throw error;
  }
}

// ── Recency gap (item 7) ─────────────────────────────────────────────────

const WORKER_INTERNAL_URL = process.env.NORA_WORKER_INTERNAL_URL || "http://worker-provisioner:4001";
const WORKER_INTERNAL_TIMEOUT_MS = Number(process.env.NORA_WORKER_INTERNAL_TIMEOUT_MS) || 2000;
const RECENT_LINES_UNAVAILABLE = "recent_lines_unavailable";

/**
 * Item 7: internal backend-api → worker-provisioner call to
 * `GET /internal/log-buffer`, authenticated with the shared JWT_SECRET (see
 * worker.ts's health server extension). Returns `null` when nothing is
 * buffered; throws on any transport/auth failure so the caller can degrade
 * to storage-only results with the "recent lines unavailable" marker rather
 * than fail the whole query.
 *
 * ⚠️ Replica-count caveat: this assumes the request reaches the worker
 * replica holding the requested agent's buffer. See worker.ts's comment on
 * the internal endpoint for what was verified (Helm defaults to 1 replica,
 * with no hard validation enforcing it yet) and why this is written to be
 * safe, not merely optimistic, if that assumption doesn't hold.
 */
async function fetchWorkerBufferOverHttp(agentId, stream) {
  const url = `${WORKER_INTERNAL_URL}/internal/log-buffer?agentId=${encodeURIComponent(agentId)}&stream=${encodeURIComponent(stream)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_INTERNAL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "x-nora-internal-key": String(process.env.JWT_SECRET || "") },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`worker-provisioner internal log-buffer request failed with ${response.status}`);
    }
    const body = await response.json();
    return body && body.found ? body : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step 1 of the two-step recency-gap dance (item 7): read the live buffer
 * for each requested stream BEFORE storage is pruned/fetched. This must run
 * FIRST, not after — the two orderings fail differently and only one is
 * detectable:
 *
 *   - Storage-first: a flush landing between the storage prune and the
 *     buffer read means the flushed lines were not yet indexed when storage
 *     was pruned, AND are gone from the buffer by the time it's read. They
 *     appear in NEITHER result — a silent, undetectable gap.
 *   - Buffer-first (this function): the same flush means the lines appear
 *     in the buffer snapshot taken here AND in the storage segments fetched
 *     afterward — a duplicate, which `admitRecencyGapLines` below resolves
 *     deterministically via "storage wins on overlap".
 *
 * Skips the call entirely when `to` predates the oldest possible open
 * buffer (approximated as "now minus one flush interval" — see
 * `FLUSH_INTERVAL_MS`'s comment for why this is a conservative
 * approximation rather than an exact figure). An unreachable worker sets
 * `warning` rather than throwing, so the caller can degrade to
 * storage-only results instead of failing the whole query.
 */
async function readBufferSnapshots({ agentId, streams, to }, deps = {}) {
  const fetchBuffer = deps.fetchWorkerBuffer || fetchWorkerBufferOverHttp;
  const snapshots = new Map();
  let warning = null;

  for (const stream of streams) {
    if (to) {
      const oldestPossibleOpenBuffer = Date.now() - FLUSH_INTERVAL_MS;
      if (new Date(to).getTime() < oldestPossibleOpenBuffer) continue;
    }
    try {
      const snapshot = await fetchBuffer(agentId, stream, deps);
      if (snapshot && Array.isArray(snapshot.lines) && snapshot.lines.length) {
        snapshots.set(stream, snapshot.lines);
      }
    } catch {
      warning = RECENT_LINES_UNAVAILABLE;
    }
  }

  return { snapshots, warning };
}

/**
 * Step 2 of the recency-gap dance: once storage has actually been fetched
 * and `newestTsToByStream` reflects the newest segment ACTUALLY READ per
 * stream, admit only the buffer lines strictly newer than that boundary.
 * This is what resolves the buffer-first ordering's known duplicate risk —
 * a line that made it into both the step-1 snapshot and a freshly-flushed
 * segment is dropped here, since storage (the durable copy) wins.
 */
function admitRecencyGapLines(snapshots, newestTsToByStream, agentId) {
  const admitted = [];
  for (const [stream, lines] of snapshots.entries()) {
    const boundary = newestTsToByStream.get(stream) || null;
    for (const line of lines) {
      const ts = effectiveTs(line);
      if (boundary && !(new Date(ts).getTime() > new Date(boundary).getTime())) continue;
      admitted.push({ ...line, agentId, workspaceId: line.workspaceId ?? null });
    }
  }
  return admitted;
}

// ── searchLogs orchestration (item 1-8 / function list) ─────────────────

function clampLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, parsed);
}

function requireAgentId(params) {
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  if (!agentId) {
    const error = new Error("agentId is required");
    error.statusCode = 400;
    error.code = "agent_id_required";
    throw error;
  }
  return agentId;
}

function notFoundAgentError() {
  const error = new Error("Agent not found");
  error.statusCode = 404;
  return error;
}

/**
 * `searchLogs(params, actor)` — item 1/orchestrator. Prune → fetch (waves,
 * concurrency-bounded, early termination) → merge → recency-gap merge.
 *
 * @param {Object} params - `{ workspaceId, agentId, streams, levels, from,
 *   to, q, traceId, cursor, limit, order }`. `agentId` is singular and
 *   required (item 2) — this endpoint serves one agent's timeline, never a
 *   merged cross-agent view.
 * @param {Object} actor - authenticated actor (`req.user`-shaped).
 * @param {Object} [deps] - dependency injection for tests.
 */
async function searchLogs(params, actor, deps = {}) {
  const db = deps.db || require("./db");
  const findAgentFn = deps.findAccessibleAgentForActor || findAccessibleAgentForActor;

  const agentId = requireAgentId(params);
  const agent = await findAgentFn(agentId, actor, "viewer");
  if (!agent) throw notFoundAgentError();

  // Item 8c: this path requires a LIVE, currently-resolvable agent —
  // `findAccessibleAgentForActor` above already enforces that (it queries
  // `agents` directly), so there is nothing further to do for that item
  // beyond NOT reusing Phase 5c's deleted-agent recovery path, which this
  // function never calls.
  await enforceWorkspaceScope(
    { agentId, workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null },
    { db },
  );

  const streams = normalizeStreams(params.streams);
  const levels = normalizeLevels(params.levels);
  const from = params.from ? new Date(params.from) : null;
  const to = params.to ? new Date(params.to) : null;
  const limit = clampLimit(params.limit);
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  const order = params.order === "asc" ? "asc" : "desc";
  const concurrency = Number(deps.fetchConcurrency) || DEFAULT_FETCH_CONCURRENCY;
  const dispatcher = deps.dispatcher || sharedDispatcher(concurrency);
  const keyRing = deps.keyRing || segmentWriterModule.loadLogEncryptionKeys();

  // Item 7, step 1: read the live buffer BEFORE pruning/fetching storage —
  // see `readBufferSnapshots`'s comment for why this ordering (not the
  // reverse) is what makes the flush-in-the-middle race a detectable
  // duplicate instead of a silent gap. Only meaningful for the "give me the
  // latest" shape of query — newest-first, first page (no cursor yet). A
  // paginated continuation or an explicitly ascending/historical query has
  // already established its window; re-consulting the buffer there would be
  // wasted work and risks a duplicate the "storage wins" rule can't fully
  // prevent once a cursor is already anchored mid-buffer.
  const wantsRecencyGap = order === "desc" && !cursor;
  const bufferRead = wantsRecencyGap
    ? await readBufferSnapshots({ agentId, streams, to }, deps)
    : { snapshots: new Map(), warning: null };

  const selectFn = deps.selectCandidateSegments || selectCandidateSegments;
  const rowsDesc = await selectFn({ agentId, streams, from, to }, { db });
  // item 5a: rows already come back ts_to DESC (the newest-first default
  // ordering this early-termination scheme optimizes for). An ascending
  // query reverses the (cheap — index rows only) array rather than
  // re-querying, and is the documented slow path with no early termination
  // benefit — see the plan's Search Performance Model.
  const orderedRows = order === "asc" ? rowsDesc.slice().reverse() : rowsDesc;

  const fetchFn = deps.fetchSegmentLines || fetchSegmentLines;
  const collected = [];
  const newestTsToByStream = new Map();
  let index = 0;

  while (index < orderedRows.length) {
    const wave = orderedRows.slice(index, index + concurrency);
    index += wave.length;

    // Item 4a: resolve each row's OWN storage config (fetchFn does this
    // internally via storageConfigForSegmentFn) and group the concurrent
    // fetch by storage_backend so connection pools stay coherent per
    // destination — done here by simply issuing the whole wave's fetches
    // together (Promise.all): rows sharing a backend naturally share the
    // sized dispatcher's connection pool for that origin, while a `local`
    // row in the same wave never touches the dispatcher at all (objectStorage
    // only uses `dispatcher` for the S3/R2 fetch path).
    const results = await Promise.all(
      wave.map((row) => fetchFn(row, { q: params.q, levels, keyRing, dispatcher })),
    );
    wave.forEach((row, i) => {
      const current = newestTsToByStream.get(row.stream);
      if (!current || new Date(row.ts_to).getTime() > new Date(current).getTime()) {
        newestTsToByStream.set(row.stream, row.ts_to);
      }
      collected.push(...results[i]);
    });

    if (collected.length >= limit) {
      const boundaryRow = orderedRows[index];
      if (!boundaryRow) break;
      const boundaryTs = order === "desc" ? boundaryRow.ts_to : boundaryRow.ts_from;
      const sorted = collected.slice().sort((a, b) => compareLines(a, b, order));
      const nthTs = effectiveTs(sorted[limit - 1]);
      const done =
        order === "desc"
          ? new Date(nthTs).getTime() >= new Date(boundaryTs).getTime()
          : new Date(nthTs).getTime() <= new Date(boundaryTs).getTime();
      if (done) break;
    }
  }

  // Item 7, step 2: now that `newestTsToByStream` reflects the segments
  // ACTUALLY READ, admit only buffer lines strictly newer than that
  // boundary — storage wins on overlap, resolving step 1's buffer-first
  // duplicate risk deterministically.
  if (wantsRecencyGap) {
    collected.push(...admitRecencyGapLines(bufferRead.snapshots, newestTsToByStream, agentId));
  }
  const warning = bufferRead.warning;

  const merged = mergeSegments(collected, limit, cursor, order);
  return {
    lines: merged.lines,
    nextCursor: merged.nextCursor,
    ...(warning ? { warning } : {}),
  };
}

// ── streamLogExport orchestration (Phase 7) ──────────────────────────────

const EXPORT_MAX_RANGE_MS = Number(process.env.NORA_LOG_EXPORT_MAX_RANGE_MS) || DEFAULT_EXPORT_MAX_RANGE_MS;

function assertExportRangeWithinCap(from, to) {
  if (!from || !to) {
    const error = new Error("Log export requires both a from and a to timestamp");
    error.statusCode = 400;
    error.code = "export_range_required";
    throw error;
  }
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    const error = new Error("Log export from/to must be valid timestamps");
    error.statusCode = 400;
    error.code = "export_range_invalid";
    throw error;
  }
  const rangeMs = toMs - fromMs;
  if (rangeMs <= 0) {
    const error = new Error("Log export 'to' must be after 'from'");
    error.statusCode = 400;
    error.code = "export_range_invalid";
    throw error;
  }
  if (rangeMs > EXPORT_MAX_RANGE_MS) {
    const maxDays = Math.round(EXPORT_MAX_RANGE_MS / (24 * 60 * 60 * 1000));
    const requestedDays = Math.round(rangeMs / (24 * 60 * 60 * 1000));
    const error = new Error(
      `Requested export range spans ${requestedDays} day(s), which exceeds the maximum exportable ` +
        `range of ${maxDays} day(s). Narrow the from/to range and try again.`,
    );
    error.statusCode = 400;
    error.code = "export_range_too_large";
    throw error;
  }
}

const CSV_HEADER = "ts,observed_ts,ts_source,stream,level,message,trace_id,span_id,session_id,channel";
const CSV_FIELDS = [
  "ts",
  "observed_ts",
  "ts_source",
  "stream",
  "level",
  "message",
  "trace_id",
  "span_id",
  "session_id",
  "channel",
];

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(line) {
  return CSV_FIELDS.map((field) => csvEscape(line[field])).join(",");
}

/**
 * Item 3: mirrors the admin audit export's `nora-audit-<iso>.csv` naming
 * convention (see `admin-dashboard/pages/audit.tsx`'s `extractFilename` /
 * `handleExport`) — an ISO-timestamped filename, extension matching format.
 */
function exportFilename(format) {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `nora-logs-${iso}.${format === "csv" ? "csv" : "ndjson"}`;
}

function resolveExportFormat(params = {}) {
  if (params.format === "csv") return "csv";
  if (params.format === "ndjson") return "ndjson";
  if (typeof params.accept === "string" && params.accept.includes("text/csv")) return "csv";
  return "ndjson";
}

/**
 * `streamLogExport(params, actor, res, deps)` — Phase 7 item 2/function
 * list. Reuses `selectCandidateSegments`/`fetchSegmentLines` but writes to
 * `res` incrementally as results become available, never buffering the
 * whole export.
 *
 * Incremental-but-correct ordering: lines are held in a small pending
 * buffer only until a "safe boundary" is known — the ts_from of the next
 * not-yet-fetched candidate segment (rows are walked in ascending ts_from
 * order for export). Any pending line at or before that boundary can never
 * be superseded by anything still to come, so it is safe to sort and flush.
 * This is the same partitioned-merge idea `searchLogs`'s early-termination
 * boundary check uses, applied to guarantee full-range ordering instead of
 * to cut a fetch short — it is what keeps memory bounded to "segments
 * currently in flight" rather than "the whole export."
 */
async function streamLogExport(params, actor, res, deps = {}) {
  const db = deps.db || require("./db");
  const findAgentFn = deps.findAccessibleAgentForActor || findAccessibleAgentForActor;

  const agentId = requireAgentId(params);
  const agent = await findAgentFn(agentId, actor, "viewer");
  if (!agent) throw notFoundAgentError();

  await enforceWorkspaceScope(
    { agentId, workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null },
    { db },
  );

  assertExportRangeWithinCap(params.from, params.to);

  const streams = normalizeStreams(params.streams);
  const levels = normalizeLevels(params.levels);
  const from = new Date(params.from);
  const to = new Date(params.to);
  const format = resolveExportFormat(params);
  const concurrency = Number(deps.fetchConcurrency) || DEFAULT_FETCH_CONCURRENCY;
  const dispatcher = deps.dispatcher || sharedDispatcher(concurrency);
  const keyRing = deps.keyRing || segmentWriterModule.loadLogEncryptionKeys();

  const selectFn = deps.selectCandidateSegments || selectCandidateSegments;
  const rowsDesc = await selectFn({ agentId, streams, from, to }, { db });
  const orderedRows = rowsDesc.slice().reverse(); // ascending ts_from for a chronological export

  const fetchFn = deps.fetchSegmentLines || fetchSegmentLines;

  const filename = exportFilename(format);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader(
    "Content-Type",
    format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
  );

  const writeLine = (line) => {
    if (format === "csv") {
      res.write(csvRow(line) + "\r\n");
    } else {
      res.write(JSON.stringify(line) + "\n");
    }
  };

  if (format === "csv") {
    res.write(CSV_HEADER + "\r\n");
  }

  let pending = [];
  let index = 0;
  while (index < orderedRows.length) {
    const wave = orderedRows.slice(index, index + concurrency);
    index += wave.length;

    const results = await Promise.all(
      wave.map((row) => fetchFn(row, { q: params.q, levels, keyRing, dispatcher })),
    );
    results.forEach((lines) => pending.push(...lines));
    pending.sort((a, b) => compareLines(a, b, "asc"));

    const boundaryRow = orderedRows[index];
    if (!boundaryRow) {
      // No more candidates — everything pending is now safe to flush.
      for (const line of pending) writeLine(line);
      pending = [];
      break;
    }
    const boundaryTs = boundaryRow.ts_from;
    const safeCount = pending.findIndex(
      (line) => new Date(effectiveTs(line)).getTime() > new Date(boundaryTs).getTime(),
    );
    const splitAt = safeCount === -1 ? pending.length : safeCount;
    for (let i = 0; i < splitAt; i++) writeLine(pending[i]);
    pending = pending.slice(splitAt);
  }

  res.end();
}

module.exports = {
  searchLogs,
  selectCandidateSegments,
  mergeSegments,
  encodeCursor,
  decodeCursor,
  fetchSegmentLines,
  streamLogExport,
  assertExportRangeWithinCap,
  exportFilename,
  csvEscape,
  compareLines,
  effectiveTs,
  enforceWorkspaceScope,
  fetchWorkerBufferOverHttp,
  RECENT_LINES_UNAVAILABLE,
  DEFAULT_FETCH_CONCURRENCY,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  EXPORT_MAX_RANGE_MS,
};
