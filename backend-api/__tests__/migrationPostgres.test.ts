// @ts-nocheck

const fs = require("fs");
const path = require("path");
const { Client, Pool } = require("pg");

const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = TEST_POSTGRES_URL ? describe : describe.skip;

describeWithPostgres("PostgreSQL legacy migration gate", () => {
  jest.setTimeout(120_000);

  let adminClient;
  let adminConnected = false;
  let migrationPool;
  let schemaName;
  let migrateDB;
  let userId;

  beforeAll(async () => {
    schemaName = `nora_migration_${process.pid}_${Date.now()}`;
    adminClient = new Client({ connectionString: TEST_POSTGRES_URL });
    await adminClient.connect();
    adminConnected = true;
    await adminClient.query(`CREATE SCHEMA ${schemaName}`);

    migrationPool = new Pool({
      connectionString: TEST_POSTGRES_URL,
      options: `-c search_path=${schemaName},public`,
    });

    const schemaSql = fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8");
    await migrationPool.query(schemaSql);

    // Recreate representative pre-ledger states that historically blocked a
    // strict all-or-nothing migration: stale backup kinds, duplicate Agent Hub
    // slugs, and duplicate workspace assignments.
    await migrationPool.query(`
      ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_kind_check;
      ALTER TABLE backup_schedules DROP CONSTRAINT IF EXISTS backup_schedules_kind_check;
      DROP INDEX IF EXISTS idx_agent_hub_listings_slug_unique;
      ALTER TABLE workspace_agents
        DROP CONSTRAINT IF EXISTS workspace_agents_workspace_id_agent_id_key;
      DROP INDEX IF EXISTS idx_workspace_agents_unique;
      CREATE TABLE llm_providers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(30) NOT NULL,
        api_key TEXT,
        model VARCHAR(100),
        config JSONB DEFAULT '{}',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const userResult = await migrationPool.query(
      `INSERT INTO users(email, role, name)
       VALUES($1, 'admin', 'Migration Test') RETURNING id`,
      [`migration-${Date.now()}@example.test`],
    );
    userId = userResult.rows[0].id;
    const agentResult = await migrationPool.query(
      `INSERT INTO agents(user_id, name) VALUES($1, 'Legacy agent') RETURNING id`,
      [userId],
    );
    const agentId = agentResult.rows[0].id;
    const workspaceResult = await migrationPool.query(
      `INSERT INTO workspaces(user_id, name) VALUES($1, 'Legacy workspace') RETURNING id`,
      [userId],
    );
    const workspaceId = workspaceResult.rows[0].id;

    await migrationPool.query(
      `INSERT INTO workspace_agents(workspace_id, agent_id, role)
       VALUES($1, $2, 'member'), ($1, $2, 'member')`,
      [workspaceId, agentId],
    );
    await migrationPool.query(
      `INSERT INTO backups(user_id, agent_id, kind, name, scope)
       VALUES
         ($1, NULL, 'legacy-full', 'Legacy installation', '{"installation": true}'::jsonb),
         ($1, $2, 'legacy-runtime', 'Legacy agent', '{}'::jsonb)`,
      [userId, agentId],
    );
    await migrationPool.query(
      `INSERT INTO backup_schedules(schedule_key, kind, user_id, agent_id)
       VALUES
         ('installation', 'legacy-full', $1, NULL),
         ('legacy-agent', 'legacy-runtime', $1, $2)`,
      [userId, agentId],
    );
    await migrationPool.query(
      `INSERT INTO llm_providers(user_id, provider, api_key, model, is_default)
       VALUES
         ($1, 'demo', 'legacy-demo', 'nora-demo-1', false),
         ($1, 'openai', 'legacy-openai', 'gpt-5.5', false)`,
      [userId],
    );

    const snapshots = await migrationPool.query(
      `INSERT INTO snapshots(name, config)
       VALUES('Legacy listing A', '{}'::jsonb), ('Legacy listing B', '{}'::jsonb)
       RETURNING id`,
    );
    await migrationPool.query(
      `INSERT INTO agent_hub_listings(snapshot_id, name, slug)
       VALUES($1, 'Legacy listing A', 'duplicate-slug'),
             ($2, 'Legacy listing B', 'duplicate-slug')`,
      [snapshots.rows[0].id, snapshots.rows[1].id],
    );

    process.env.ENCRYPTION_KEY ||= "a".repeat(64);
    ({ migrateDB } = require("../server").__test);
  });

  afterAll(async () => {
    await migrationPool?.end();
    if (adminConnected && schemaName) {
      await adminClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    if (adminConnected) await adminClient.end();
  });

  it("repairs a pre-ledger schema and is idempotent on a second real PostgreSQL run", async () => {
    const firstRun = await migrateDB(migrationPool, {
      DB_MIGRATION_LOCK_TIMEOUT_MS: "10000",
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
    });

    expect(firstRun.total).toBeGreaterThan(100);
    expect(firstRun.applied).toBe(firstRun.total);

    const backupKinds = await migrationPool.query(
      `SELECT name, kind FROM backups WHERE name LIKE 'Legacy %' ORDER BY name`,
    );
    expect(backupKinds.rows).toEqual([
      { name: "Legacy agent", kind: "agent" },
      { name: "Legacy installation", kind: "installation" },
    ]);

    const scheduleKinds = await migrationPool.query(
      `SELECT schedule_key, kind FROM backup_schedules
       WHERE schedule_key IN ('installation', 'legacy-agent') ORDER BY schedule_key`,
    );
    expect(scheduleKinds.rows).toEqual([
      { schedule_key: "installation", kind: "installation" },
      { schedule_key: "legacy-agent", kind: "agent" },
    ]);

    const duplicateAssignments = await migrationPool.query(
      `SELECT workspace_id, agent_id, COUNT(*)::int AS count
         FROM workspace_agents
        GROUP BY workspace_id, agent_id
       HAVING COUNT(*) > 1`,
    );
    expect(duplicateAssignments.rows).toEqual([]);

    const duplicateSlugs = await migrationPool.query(
      `SELECT slug, COUNT(*)::int AS count
         FROM agent_hub_listings
        WHERE slug IS NOT NULL
        GROUP BY slug
       HAVING COUNT(*) > 1`,
    );
    expect(duplicateSlugs.rows).toEqual([]);

    const providerDefaults = await migrationPool.query(
      `SELECT provider, is_default
         FROM llm_providers
        WHERE user_id = $1
        ORDER BY provider`,
      [userId],
    );
    expect(providerDefaults.rows).toEqual([
      { provider: "demo", is_default: false },
      { provider: "openai", is_default: true },
    ]);

    const ledger = await migrationPool.query(
      "SELECT COUNT(*)::int AS count FROM schema_migrations",
    );
    expect(ledger.rows[0].count).toBe(firstRun.total);

    await expect(
      migrateDB(migrationPool, {
        DB_MIGRATION_LOCK_TIMEOUT_MS: "10000",
        DB_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
      }),
    ).resolves.toEqual({ total: firstRun.total, applied: 0 });
  });
});

// Logging control plane (Phase 1): schema foundation for log_segments,
// agent_spans, workspace_log_settings, agent_log_cursors,
// log_segment_legacy_copies, deleted_log_owners, storage_migration_jobs, and
// the new events indexes. See
// plans/logging_control_plane/logging-control-plane-manifest.md ("Data Model
// Inventory") for the full column rationale.
describeWithPostgres("PostgreSQL logging control plane schema (Phase 1)", () => {
  jest.setTimeout(120_000);

  const NEW_TABLES = [
    "log_segments",
    "agent_spans",
    "workspace_log_settings",
    "agent_log_cursors",
    "log_segment_legacy_copies",
    "deleted_log_owners",
    "storage_migration_jobs",
  ];

  let adminClient;
  let adminConnected = false;
  let migrateDB;
  let freshSchemaName;
  let freshPool;
  let existingSchemaName;
  let existingPool;

  async function tableColumns(pool, schema, table) {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [schema, table],
    );
    return result.rows;
  }

  async function indexNames(pool, schema, table) {
    const result = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [schema, table],
    );
    return result.rows.map((row) => row.indexname);
  }

  beforeAll(async () => {
    const schemaSql = fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8");
    const suffix = `${process.pid}_${Date.now()}`;

    adminClient = new Client({ connectionString: TEST_POSTGRES_URL });
    await adminClient.connect();
    adminConnected = true;

    // "Fresh install" path: db_schema.sql only, migrateDB never runs.
    freshSchemaName = `nora_logs_fresh_${suffix}`;
    await adminClient.query(`CREATE SCHEMA ${freshSchemaName}`);
    freshPool = new Pool({
      connectionString: TEST_POSTGRES_URL,
      options: `-c search_path=${freshSchemaName},public`,
    });
    await freshPool.query(schemaSql);

    // "Existing installation" path: base schema already present (as an
    // installation that predates this phase would have), then the full
    // migrateDB array — including the Phase 1 statements appended at the
    // tail — brings it up to date. Dropping the new tables/indexes after
    // loading db_schema.sql simulates an install that has every table this
    // phase does NOT touch, but none of the ones it adds.
    existingSchemaName = `nora_logs_existing_${suffix}`;
    await adminClient.query(`CREATE SCHEMA ${existingSchemaName}`);
    existingPool = new Pool({
      connectionString: TEST_POSTGRES_URL,
      options: `-c search_path=${existingSchemaName},public`,
    });
    await existingPool.query(schemaSql);
    await existingPool.query(`
      DROP TABLE IF EXISTS storage_migration_jobs CASCADE;
      DROP TABLE IF EXISTS deleted_log_owners CASCADE;
      DROP TABLE IF EXISTS log_segment_legacy_copies CASCADE;
      DROP TABLE IF EXISTS agent_log_cursors CASCADE;
      DROP TABLE IF EXISTS workspace_log_settings CASCADE;
      DROP TABLE IF EXISTS agent_spans CASCADE;
      DROP TABLE IF EXISTS log_segments CASCADE;
      DROP INDEX IF EXISTS idx_events_created_at;
      DROP INDEX IF EXISTS idx_events_type;
      DROP INDEX IF EXISTS idx_events_metadata_gin;
    `);

    process.env.ENCRYPTION_KEY ||= "a".repeat(64);
    ({ migrateDB } = require("../server").__test);
  });

  afterAll(async () => {
    await freshPool?.end();
    await existingPool?.end();
    if (adminConnected) {
      if (freshSchemaName) await adminClient.query(`DROP SCHEMA IF EXISTS ${freshSchemaName} CASCADE`);
      if (existingSchemaName) {
        await adminClient.query(`DROP SCHEMA IF EXISTS ${existingSchemaName} CASCADE`);
      }
      await adminClient.end();
    }
  });

  it("boots a pre-Phase-1 existing installation cleanly and idempotently across two boots", async () => {
    const firstRun = await migrateDB(existingPool, {
      DB_MIGRATION_LOCK_TIMEOUT_MS: "10000",
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
    });
    expect(firstRun.applied).toBeGreaterThan(0);

    for (const table of NEW_TABLES) {
      const columns = await tableColumns(existingPool, existingSchemaName, table);
      expect(columns.length).toBeGreaterThan(0);
    }

    const secondRun = await migrateDB(existingPool, {
      DB_MIGRATION_LOCK_TIMEOUT_MS: "10000",
      DB_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
    });
    expect(secondRun).toEqual({ total: firstRun.total, applied: 0 });
  });

  it("produces the same logging-control-plane table shapes from a fresh db_schema.sql install as from migrateDB reconstructing them", async () => {
    for (const table of NEW_TABLES) {
      const freshColumns = await tableColumns(freshPool, freshSchemaName, table);
      const migratedColumns = await tableColumns(existingPool, existingSchemaName, table);
      expect(migratedColumns).toEqual(freshColumns);
    }
  });

  it("adds the events indexes required by the new Operator lens", async () => {
    const names = await indexNames(freshPool, freshSchemaName, "events");
    expect(names).toEqual(
      expect.arrayContaining(["idx_events_created_at", "idx_events_type", "idx_events_metadata_gin"]),
    );
    const migratedNames = await indexNames(existingPool, existingSchemaName, "events");
    expect(migratedNames).toEqual(
      expect.arrayContaining(["idx_events_created_at", "idx_events_type", "idx_events_metadata_gin"]),
    );
  });

  describe("data-shape behaviour", () => {
    let userId;
    let agentId;

    beforeAll(async () => {
      const userResult = await freshPool.query(
        `INSERT INTO users(email, role, name) VALUES($1, 'admin', 'Logs Test') RETURNING id`,
        [`logs-schema-${Date.now()}@example.test`],
      );
      userId = userResult.rows[0].id;
      const agentResult = await freshPool.query(
        `INSERT INTO agents(user_id, name) VALUES($1, 'Logged agent') RETURNING id`,
        [userId],
      );
      agentId = agentResult.rows[0].id;
    });

    it("conflicts on a bare duplicate storage_key insert and upserts in place instead", async () => {
      const key = `ws_test/agent_${agentId}/runtime/2026-01-01/0000-0015.ndjson.zst.enc`;
      const insertOne = () =>
        freshPool.query(
          `INSERT INTO log_segments
             (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, encryption_key_id, lines)
           VALUES ($1, 'runtime', NOW(), NOW(), $2, 'local', 'key-1', 10)`,
          [agentId, key],
        );

      await insertOne();
      await expect(insertOne()).rejects.toMatchObject({ code: "23505" });

      const upsert = await freshPool.query(
        `INSERT INTO log_segments
           (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, encryption_key_id, lines)
         VALUES ($1, 'runtime', NOW(), NOW(), $2, 'local', 'key-1', 25)
         ON CONFLICT (storage_key) DO UPDATE SET lines = EXCLUDED.lines
         RETURNING lines`,
        [agentId, key],
      );
      expect(upsert.rows[0].lines).toBe(25);

      const count = await freshPool.query(
        `SELECT COUNT(*)::int AS count FROM log_segments WHERE storage_key = $1`,
        [key],
      );
      expect(count.rows[0].count).toBe(1);
    });

    it("does not cascade-delete log_segments or agent_spans when the owning agent row is deleted", async () => {
      const deletableAgent = await freshPool.query(
        `INSERT INTO agents(user_id, name) VALUES($1, 'Deletable agent') RETURNING id`,
        [userId],
      );
      const deletableAgentId = deletableAgent.rows[0].id;

      const segment = await freshPool.query(
        `INSERT INTO log_segments
           (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, encryption_key_id)
         VALUES ($1, 'runtime', NOW(), NOW(), $2, 'local', 'key-1')
         RETURNING id`,
        [deletableAgentId, `ws_test/agent_${deletableAgentId}/runtime/2026-01-01/0015-0030.ndjson.zst.enc`],
      );
      const segmentId = segment.rows[0].id;

      const span = await freshPool.query(
        `INSERT INTO agent_spans (trace_id, span_id, agent_id, name, started_at)
         VALUES ('trace-1', 'span-1', $1, 'openclaw.run', NOW())
         RETURNING id`,
        [deletableAgentId],
      );
      const spanId = span.rows[0].id;

      await freshPool.query(`DELETE FROM agents WHERE id = $1`, [deletableAgentId]);

      const agentRow = await freshPool.query(`SELECT id FROM agents WHERE id = $1`, [deletableAgentId]);
      expect(agentRow.rows).toEqual([]);

      const segmentRow = await freshPool.query(`SELECT id, agent_id FROM log_segments WHERE id = $1`, [
        segmentId,
      ]);
      expect(segmentRow.rows).toEqual([{ id: segmentId, agent_id: deletableAgentId }]);

      const spanRow = await freshPool.query(`SELECT id, agent_id FROM agent_spans WHERE id = $1`, [
        spanId,
      ]);
      expect(spanRow.rows).toEqual([{ id: spanId, agent_id: deletableAgentId }]);

      // Retrievable via deleted_log_owners (application-level recovery path),
      // not via a join against agents, since the agents row is really gone.
      const owner = await freshPool.query(
        `INSERT INTO deleted_log_owners
           (kind, source_id, display_name, owner_user_id, retention_days, deleted_by_user_id)
         VALUES ('agent', $1, 'Deletable agent', $2, 14, $2)
         RETURNING id`,
        [deletableAgentId, userId],
      );
      expect(owner.rows[0].id).toBeTruthy();

      const recovered = await freshPool.query(
        `SELECT s.id AS segment_id, o.display_name, o.retention_days
           FROM log_segments s
           JOIN deleted_log_owners o ON o.source_id = s.agent_id AND o.kind = 'agent'
          WHERE s.id = $1`,
        [segmentId],
      );
      expect(recovered.rows).toEqual([
        { segment_id: segmentId, display_name: "Deletable agent", retention_days: 14 },
      ]);
    });

    it("keeps a legacy copy's snapshotted ts_to independent of the current log_segments row's ts_to", async () => {
      const originalTsTo = "2026-01-01T00:15:00.000Z";
      const laterTsTo = "2026-06-01T00:00:00.000Z";

      const segment = await freshPool.query(
        `INSERT INTO log_segments
           (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, encryption_key_id)
         VALUES ($1, 'runtime', '2026-01-01T00:00:00.000Z', $2, $3, 's3', 'key-1')
         RETURNING id`,
        [agentId, originalTsTo, `ws_test/agent_${agentId}/runtime/2026-01-01/legacy.ndjson.zst.enc`],
      );
      const segmentId = segment.rows[0].id;

      const legacy = await freshPool.query(
        `INSERT INTO log_segment_legacy_copies (log_segment_id, storage_backend, ts_to)
         VALUES ($1, 'local', $2)
         RETURNING id`,
        [segmentId, originalTsTo],
      );
      const legacyId = legacy.rows[0].id;

      // The current log_segments row moves on (e.g. repointed again by a
      // later migration); the legacy copy's own ts_to must not follow it.
      await freshPool.query(`UPDATE log_segments SET ts_to = $1 WHERE id = $2`, [
        laterTsTo,
        segmentId,
      ]);

      const legacyRow = await freshPool.query(
        `SELECT ts_to FROM log_segment_legacy_copies WHERE id = $1`,
        [legacyId],
      );
      const currentRow = await freshPool.query(`SELECT ts_to FROM log_segments WHERE id = $1`, [
        segmentId,
      ]);

      expect(new Date(legacyRow.rows[0].ts_to).toISOString()).toBe(
        new Date(originalTsTo).toISOString(),
      );
      expect(new Date(currentRow.rows[0].ts_to).toISOString()).toBe(
        new Date(laterTsTo).toISOString(),
      );
      expect(legacyRow.rows[0].ts_to).not.toEqual(currentRow.rows[0].ts_to);

      // Deleting the current log_segments row (e.g. retention expiry) must
      // not take the legacy copy down with it — no FK ties them together.
      await freshPool.query(`DELETE FROM log_segments WHERE id = $1`, [segmentId]);
      const survivingLegacy = await freshPool.query(
        `SELECT id FROM log_segment_legacy_copies WHERE id = $1`,
        [legacyId],
      );
      expect(survivingLegacy.rows).toEqual([{ id: legacyId }]);
    });

    it("supports resuming a storage_migration_jobs row from its checkpoint instead of reprocessing migrated segments", async () => {
      const segmentIds = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await freshPool.query(
          `INSERT INTO log_segments
             (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, encryption_key_id, created_at)
           VALUES ($1, 'runtime', NOW(), NOW(), $2, 'local', 'key-1', NOW() + ($3 || ' seconds')::interval)
           RETURNING id`,
          [
            agentId,
            `ws_test/agent_${agentId}/runtime/2026-02-01/checkpoint-${i}.ndjson.zst.enc`,
            i,
          ],
        );
        segmentIds.push(result.rows[0].id);
      }

      const checkpointId = segmentIds[1]; // pretend the first two were migrated

      const job = await freshPool.query(
        `INSERT INTO storage_migration_jobs
           (from_backend, to_backend, keep_source, status, segments_total, segments_migrated, checkpoint)
         VALUES ('local', 's3', true, 'running', $1, 2, $2)
         RETURNING id, checkpoint, segments_migrated, segments_total`,
        [segmentIds.length, checkpointId],
      );
      expect(job.rows[0].checkpoint).toBe(checkpointId);

      // Resumability: the job can look up where the checkpoint segment sits
      // in the write order and find only the segments after it, rather than
      // rescanning everything from the start.
      const remaining = await freshPool.query(
        `SELECT id FROM log_segments
          WHERE created_at > (SELECT created_at FROM log_segments WHERE id = $1)
            AND id = ANY($2::uuid[])
          ORDER BY created_at ASC`,
        [checkpointId, segmentIds],
      );
      expect(remaining.rows.map((row) => row.id)).toEqual(segmentIds.slice(2));

      // A capacity pause is representable and distinct from failure.
      await freshPool.query(`UPDATE storage_migration_jobs SET status = 'paused' WHERE id = $1`, [
        job.rows[0].id,
      ]);
      const paused = await freshPool.query(`SELECT status FROM storage_migration_jobs WHERE id = $1`, [
        job.rows[0].id,
      ]);
      expect(paused.rows[0].status).toBe("paused");
    });
  });
});
