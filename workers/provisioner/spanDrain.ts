// @ts-nocheck
// Drains the `span-ingest` BullMQ queue (backend-api/routes/otlp.ts) into
// the `agent_spans` table. This is the only writer of that table.
//
// `mapSpanToRow` — which does the actual OTLP-span-to-column mapping,
// including pulling model/provider/token/cost data out of GenAI
// semantic-convention attributes — lives in backend-api/otlpDecode.ts and is
// reused here unchanged (required via the read-only `/backend-api` mount;
// see the two-".." trick used throughout worker.ts, e.g.
// `require("../../backend-api/lib/connectionConfig")`, which resolves to the
// repo-root sibling locally and to the `/backend-api:ro` compose mount in
// containers). workspace_id on every row is whatever the queue job already
// carries (the authenticated agent's resolved workspace) — this module does
// not and must not re-derive it from anything in the span payload.
//
// Batches inserts rather than one-row-at-a-time: a single OTLP export
// request can carry many spans, and a burst of exports would otherwise mean
// one round trip per span.

const { mapSpanToRow } = require("../../backend-api/otlpDecode.ts");

let _pool = null;

/**
 * Lazily build a dedicated pg Pool for this module, using the same
 * connection-config helper as the rest of worker-provisioner. Callers (in
 * particular worker.ts, which already holds its own pool) may instead pass
 * `{ pool }` explicitly to `drainSpanIngest` to reuse an existing pool and
 * avoid opening a second one; tests always inject a mock pool this way.
 */
function getDefaultPool() {
  if (!_pool) {
    const { Pool } = require("pg");
    const { buildPostgresConfig } = require("../../backend-api/lib/connectionConfig");
    _pool = new Pool(buildPostgresConfig(process.env));
  }
  return _pool;
}

const SPAN_COLUMNS = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "workspace_id",
  "agent_id",
  "name",
  "kind",
  "started_at",
  "duration_ms",
  "status",
  "model",
  "provider",
  "tokens_in",
  "tokens_out",
  "cost_usd",
  "attrs",
];

/**
 * A row is only insertable if it has the columns `agent_spans` requires
 * NOT NULL: trace_id, span_id, agent_id, name, started_at. Anything missing
 * one of these is a malformed/unusable span and is dropped rather than
 * failing the whole batch.
 */
function isInsertableRow(row) {
  return Boolean(
    row &&
      row.trace_id &&
      row.span_id &&
      row.agent_id &&
      typeof row.name === "string" &&
      row.started_at instanceof Date &&
      !Number.isNaN(row.started_at.getTime()),
  );
}

/**
 * Build a single multi-row parameterized INSERT for `agent_spans`.
 *
 * @param {object[]} rows - Rows shaped by mapSpanToRow, already filtered by isInsertableRow.
 * @returns {{text: string, values: any[]}}
 */
function buildBatchInsert(rows) {
  const values = [];
  const tuples = rows.map((row, rowIndex) => {
    const placeholders = SPAN_COLUMNS.map((col, colIndex) => {
      const paramIndex = rowIndex * SPAN_COLUMNS.length + colIndex + 1;
      return col === "attrs" ? `$${paramIndex}::jsonb` : `$${paramIndex}`;
    });
    for (const col of SPAN_COLUMNS) {
      values.push(col === "attrs" ? JSON.stringify(row.attrs || {}) : row[col] ?? null);
    }
    return `(${placeholders.join(", ")})`;
  });

  const text = `INSERT INTO agent_spans (${SPAN_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`;
  return { text, values };
}

/**
 * Batch-insert already-mapped span rows into agent_spans.
 *
 * @param {import("pg").Pool} pool
 * @param {object[]} rows
 */
async function batchInsertSpans(pool, rows) {
  if (!rows.length) return;
  const { text, values } = buildBatchInsert(rows);
  await pool.query(text, values);
}

/**
 * BullMQ processor for the `span-ingest` queue. Job data shape (see
 * backend-api/redisQueue.ts `addSpanIngestJob`):
 *
 *   { agentId: string, workspaceId: string|null, spans: Array<{span, resource, scope}> }
 *
 * `spans` entries are the normalized decode-time shape produced by
 * `decodeTraceRequest` in backend-api/otlpDecode.ts.
 *
 * @param {import("bullmq").Job} job
 * @param {{pool?: import("pg").Pool}} [deps] - Injectable pool for tests / pool reuse.
 * @returns {Promise<{inserted: number, skipped: number}>}
 */
async function drainSpanIngest(job, deps = {}) {
  const pool = deps.pool || getDefaultPool();
  const data = job?.data || job || {};
  const agentId = data.agentId;
  const workspaceId = data.workspaceId ?? null;
  const spanEntries = Array.isArray(data.spans) ? data.spans : [];

  const agent = { id: agentId, workspace_id: workspaceId };

  const rows = [];
  let skipped = 0;
  for (const entry of spanEntries) {
    if (!entry || !entry.span) {
      skipped += 1;
      continue;
    }
    const row = mapSpanToRow(entry.span, entry.resource || { attributes: [] }, agent);
    if (!isInsertableRow(row)) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }

  if (!rows.length) {
    return { inserted: 0, skipped };
  }

  await batchInsertSpans(pool, rows);
  return { inserted: rows.length, skipped };
}

module.exports = {
  drainSpanIngest,
  buildBatchInsert,
  isInsertableRow,
  SPAN_COLUMNS,
};
