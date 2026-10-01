// @ts-nocheck
// The delete-all-logs job and the collection toggle's SQL, against real
// PostgreSQL. The unit tests (workers/provisioner/logPurge.test.js) use a fake
// database, which cannot catch mistakes in the parts that are SQL: the scope
// that spares logs kept for deleted agents, the single-flight request upsert,
// JSONB patching of job state, and the batched deletes.
//
// Runs only when TEST_POSTGRES_URL is set, like migrationPostgres.test.ts.

const fs = require("fs");
const path = require("path");
const { Client, Pool } = require("pg");

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = TEST_POSTGRES_URL ? describe : describe.skip;

describeWithPostgres("log purge and collection state on PostgreSQL", () => {
  jest.setTimeout(120_000);

  const silent = { log() {}, warn() {}, error() {} };
  let adminClient;
  let pool;
  let schemaName;
  let logPurge;
  let logCollectionState;
  let realSweep;

  // The sweeper deletes stored objects through these; nothing is stored here.
  const sweep = (whereSql, param, cutoff, deps) =>
    realSweep(whereSql, param, cutoff, {
      ...deps,
      deleteStorageObjects: async (keys) => ({ deleted: keys }),
      storageConfigForSegment: async () => ({ storageBackend: "local" }),
    });

  const ids = {
    keptAgent: "11111111-1111-1111-1111-111111111111", // deleted with "keep logs"
    liveAgentA: "22222222-2222-2222-2222-222222222222",
    liveAgentB: "33333333-3333-3333-3333-333333333333",
    keptWorkspace: "55555555-5555-5555-5555-555555555555",
  };
  let keySeq = 0;

  async function segment(agentId, { workspaceId = null, lines = 10, bytes = 100 } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO log_segments(agent_id, workspace_id, stream, ts_from, ts_to, storage_key, encryption_key_id, lines, bytes)
       VALUES($1, $2, 'runtime', '2026-01-01', '2026-01-02', $3, 'default', $4, $5) RETURNING id`,
      [agentId, workspaceId, `k/${++keySeq}`, lines, bytes],
    );
    return rows[0].id;
  }

  async function span(agentId, workspaceId = null) {
    await pool.query(
      `INSERT INTO agent_spans(trace_id, span_id, agent_id, workspace_id, name, started_at)
       VALUES($1, $2, $3, $4, 'op', '2026-01-01')`,
      [`t${++keySeq}`, `s${keySeq}`, agentId, workspaceId],
    );
  }

  async function reset() {
    await pool.query(`TRUNCATE log_segment_legacy_copies, log_segments, agent_spans, deleted_log_owners`);
    await pool.query(
      `UPDATE platform_settings SET log_purge_job = NULL, log_collection_enabled = NULL, log_collection_updated_at = NULL WHERE singleton = TRUE`,
    );
    await pool.query(
      `INSERT INTO platform_settings(singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING`,
    );
  }

  beforeAll(async () => {
    schemaName = `nora_purge_${process.pid}_${Date.now()}`;
    adminClient = new Client({ connectionString: TEST_POSTGRES_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE SCHEMA ${schemaName}`);
    pool = new Pool({
      connectionString: TEST_POSTGRES_URL,
      options: `-c search_path=${schemaName},public`,
    });
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8"));

    logPurge = require("../../workers/provisioner/logs/logPurge.ts");
    logCollectionState = require("../../workers/provisioner/logs/logCollectionState.ts");
    realSweep = require("../../workers/provisioner/logs/retentionSweeper.ts").sweepExpiredSegmentsByScope;
  });

  afterAll(async () => {
    await pool?.end();
    if (adminClient) {
      await adminClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminClient.end();
    }
  });

  beforeEach(reset);

  async function seedMixed() {
    // Logs kept for a deleted agent ("keep logs"). A kept-workspace record is
    // present too, to make sure that branch of the scope predicate is valid
    // SQL; log_segments.workspace_id is ON DELETE SET NULL, so there are no
    // segments to attach to it here.
    await pool.query(
      `INSERT INTO deleted_log_owners(kind, source_id, display_name) VALUES
         ('agent', $1, 'old agent'),
         ('workspace', $2, 'old workspace')`,
      [ids.keptAgent, ids.keptWorkspace],
    );

    // Active logs.
    await segment(ids.liveAgentA, { lines: 10, bytes: 100 });
    await segment(ids.liveAgentA, { lines: 20, bytes: 200 });
    await segment(ids.liveAgentB, { lines: 5, bytes: 50 });
    await span(ids.liveAgentA);
    await span(ids.liveAgentB);
    // Kept logs, which a delete-all must not touch.
    await segment(ids.keptAgent, { lines: 7, bytes: 70 });
    await span(ids.keptAgent);
  }

  it("stats count only active logs, not logs kept for deleted owners", async () => {
    await seedMixed();
    const stats = await logPurge.getLogStats({ db: pool });
    expect(stats).toMatchObject({ segments: 3, lines: 35, bytes: 350, agents: 2, spans: 2 });
    expect(stats.oldest).toBeTruthy();
    expect(stats.newest).toBeTruthy();
  });

  it("stats are all zero on an empty installation", async () => {
    expect(await logPurge.getLogStats({ db: pool })).toMatchObject({ segments: 0, lines: 0, bytes: 0, agents: 0, spans: 0 });
  });

  it("requesting a purge is single-flight, and a finished one can be followed by a new one", async () => {
    const first = await logPurge.requestLogPurge({ requestedBy: null }, { db: pool });
    expect(first.created).toBe(true);
    expect(first.job.status).toBe("pending");

    const second = await logPurge.requestLogPurge({ requestedBy: null }, { db: pool });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    await pool.query(
      `UPDATE platform_settings SET log_purge_job = log_purge_job || '{"status":"completed"}'::jsonb WHERE singleton = TRUE`,
    );
    const third = await logPurge.requestLogPurge({ requestedBy: null }, { db: pool });
    expect(third.created).toBe(true);
    expect(third.job.id).not.toBe(first.job.id);
  });

  it("runs a purge end to end: deletes active segments, legacy copies and spans in batches, spares kept logs", async () => {
    await seedMixed();
    const { rows } = await pool.query(`SELECT id FROM log_segments WHERE agent_id = $1 LIMIT 1`, [ids.liveAgentA]);
    await pool.query(
      `INSERT INTO log_segment_legacy_copies(log_segment_id, storage_backend, ts_to) VALUES ($1, 'local', '2026-01-02')`,
      [rows[0].id],
    );
    await logPurge.requestLogPurge({ requestedBy: null }, { db: pool });

    const events = [];
    const result = await logPurge.runPendingPurge({
      db: pool,
      logger: silent,
      sweepExpiredSegmentsByScope: sweep,
      logEvent: async (...args) => { events.push(args); },
      isCollectionEnabled: async () => false,
      segmentBatch: 2, // forces more than one batch
      spanBatch: 1,
    });

    expect(result).toMatchObject({ ran: true, segmentsDeleted: 3, spansDeleted: 2 });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM log_segments WHERE agent_id IN ($1, $2)`, [ids.liveAgentA, ids.liveAgentB])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM agent_spans WHERE agent_id IN ($1, $2)`, [ids.liveAgentA, ids.liveAgentB])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM log_segment_legacy_copies`)).rows[0].n).toBe(0);

    // Logs kept for the deleted agent are still there, and still recoverable.
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM log_segments WHERE agent_id = $1`, [ids.keptAgent])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM agent_spans WHERE agent_id = $1`, [ids.keptAgent])).rows[0].n).toBe(1);

    const job = await logPurge.readPurgeJob({ db: pool });
    expect(job).toMatchObject({ status: "completed", segmentsDeleted: 3, spansDeleted: 2 });
    expect(job.finishedAt).toBeTruthy();
    expect(events.map((e) => e[0])).toEqual(["log_purge_completed"]);
  });

  it("a second purge with nothing left completes cleanly", async () => {
    await logPurge.requestLogPurge({ requestedBy: null }, { db: pool });
    const result = await logPurge.runPendingPurge({
      db: pool,
      logger: silent,
      sweepExpiredSegmentsByScope: sweep,
      logEvent: async () => {},
    });
    expect(result).toMatchObject({ ran: true, segmentsDeleted: 0, spansDeleted: 0 });
    expect((await logPurge.readPurgeJob({ db: pool })).status).toBe("completed");
  });

  it("setLogCollectionEnabled moves the 'since' timestamp only when the value actually changes", async () => {
    const read = async () =>
      (await pool.query(`SELECT log_collection_enabled AS v, log_collection_updated_at AS at FROM platform_settings WHERE singleton = TRUE`)).rows[0];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    await logCollectionState.setLogCollectionEnabled(true, { db: pool });
    const first = await read();
    expect(first.v).toBe(true);
    expect(first.at).toBeTruthy();

    await sleep(30);
    await logCollectionState.setLogCollectionEnabled(true, { db: pool }); // repeating "on" while on
    const repeated = await read();
    expect(repeated.at.getTime()).toBe(first.at.getTime());

    await sleep(30);
    await logCollectionState.setLogCollectionEnabled(false, { db: pool });
    const off = await read();
    expect(off.v).toBe(false);
    expect(off.at.getTime()).toBeGreaterThan(first.at.getTime());

    await sleep(30);
    await logCollectionState.setLogCollectionEnabled(true, { db: pool }); // turned back on: a new 'since'
    const again = await read();
    expect(again.at.getTime()).toBeGreaterThan(off.at.getTime());
  });

  it("the resolved state carries 'since' only for an enabled, stored decision", async () => {
    await logCollectionState.setLogCollectionEnabled(true, { db: pool });
    const on = await logCollectionState.resolveLogCollectionState({ db: pool, env: {} });
    expect(on).toMatchObject({ enabled: true, source: "database" });
    expect(Number.isNaN(Date.parse(on.since))).toBe(false);

    await logCollectionState.setLogCollectionEnabled(false, { db: pool });
    expect((await logCollectionState.resolveLogCollectionState({ db: pool, env: {} })).since).toBeNull();
  });

  it("collection state follows the stored value, then the environment, then 'undecided'", async () => {
    const state = (env = {}) => logCollectionState.resolveLogCollectionState({ db: pool, env });

    expect(await state()).toEqual({ enabled: false, decided: false, source: "default", since: null });
    expect(await state({ NORA_LOG_ENABLED: "true" })).toEqual({ enabled: true, decided: true, source: "env", since: null });

    await pool.query(`UPDATE platform_settings SET log_collection_enabled = FALSE WHERE singleton = TRUE`);
    expect(await state({ NORA_LOG_ENABLED: "true" })).toEqual({ enabled: false, decided: true, source: "database", since: null });

    await pool.query(`UPDATE platform_settings SET log_collection_enabled = TRUE WHERE singleton = TRUE`);
    expect(await state()).toEqual({ enabled: true, decided: true, source: "database", since: null });
  });
});
