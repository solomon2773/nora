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
