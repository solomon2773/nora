// @ts-nocheck

const {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  boundedTimeoutMs,
  migrationChecksum,
  normalizeMigrations,
  runVersionedMigrations,
} = require("../lib/migrationRunner");

function mockPool(appliedRows = []) {
  const client = {
    query: jest.fn(async (sql) => {
      if (String(sql).startsWith("SELECT version")) return { rows: appliedRows };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { client, pool: { query: jest.fn(), connect: jest.fn(async () => client) } };
}

describe("migrationRunner", () => {
  it("normalizes migrations into stable append-only versions", () => {
    expect(normalizeMigrations(["SELECT 1", { name: "second", sql: "SELECT 2" }])).toEqual([
      expect.objectContaining({ version: 1, name: "legacy-reconciliation-0001" }),
      expect.objectContaining({ version: 2, name: "second" }),
    ]);
  });

  it("keeps migration timeouts positive and bounded", () => {
    expect(boundedTimeoutMs("invalid", 1234)).toBe(1234);
    expect(boundedTimeoutMs("0", 1234)).toBe(1000);
    expect(boundedTimeoutMs("9999999", 1234)).toBe(3600000);
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS).toBe(60000);
    expect(DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS).toBe(600000);
  });

  it("applies missing migrations in one transaction and records checksums", async () => {
    const { client, pool } = mockPool([]);
    await expect(
      runVersionedMigrations(
        pool,
        ["CREATE TABLE example(id int)", "ALTER TABLE example ADD x int"],
        {
          logger: {},
        },
      ),
    ).resolves.toEqual({ total: 2, applied: 2 });

    const sql = client.query.mock.calls.map(([statement]) => statement);
    expect(sql[0]).toBe("BEGIN");
    expect(sql).toContain("CREATE TABLE example(id int)");
    expect(sql).toContain("ALTER TABLE example ADD x int");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("applies option and environment timeouts before migration work", async () => {
    const { client, pool } = mockPool([]);
    await runVersionedMigrations(pool, ["SELECT 1"], {
      env: {
        DB_MIGRATION_LOCK_TIMEOUT_MS: "9000",
        DB_MIGRATION_STATEMENT_TIMEOUT_MS: "4500",
      },
      lockTimeoutMs: "2500",
      logger: {},
    });

    expect(client.query).toHaveBeenCalledWith("SELECT set_config('lock_timeout', $1, true)", [
      "2500ms",
    ]);
    expect(client.query).toHaveBeenCalledWith("SELECT set_config('statement_timeout', $1, true)", [
      "4500ms",
    ]);
    const sql = client.query.mock.calls.map(([statement]) => statement);
    expect(sql.indexOf("SELECT pg_advisory_xact_lock($1::bigint)")).toBeLessThan(
      sql.indexOf("SELECT 1"),
    );
  });

  it("runs idempotent compatibility repairs before positional migrations", async () => {
    const { client, pool } = mockPool([]);
    await runVersionedMigrations(pool, ["MIGRATION"], {
      compatibilityRepairs: [{ name: "repair-legacy-data", sql: "REPAIR" }],
      logger: {},
    });

    const sql = client.query.mock.calls.map(([statement]) => statement);
    const ledgerIndex = sql.findIndex((statement) =>
      String(statement).startsWith("CREATE TABLE IF NOT EXISTS schema_migrations"),
    );
    expect(ledgerIndex).toBeGreaterThan(-1);
    expect(sql.indexOf("REPAIR")).toBeGreaterThan(ledgerIndex);
    expect(sql.indexOf("REPAIR")).toBeLessThan(sql.indexOf("MIGRATION"));
  });

  it("rolls back and releases the client when the migration lock times out", async () => {
    const { client, pool } = mockPool([]);
    client.query.mockImplementation(async (sql) => {
      if (sql === "SELECT pg_advisory_xact_lock($1::bigint)") {
        const error = new Error("canceling statement due to lock timeout");
        error.code = "55P03";
        throw error;
      }
      return { rows: [] };
    });

    await expect(
      runVersionedMigrations(pool, ["SELECT 1"], { lockTimeoutMs: 2500, logger: {} }),
    ).rejects.toMatchObject({
      code: "55P03",
      message: "Timed out acquiring the database migration lock after 2500ms",
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain("SELECT 1");
    expect(client.release).toHaveBeenCalled();
  });

  it("skips applied migrations only when their checksums still match", async () => {
    const sql = "SELECT 1";
    const { client, pool } = mockPool([
      { version: 1, name: "legacy-reconciliation-0001", checksum: migrationChecksum(sql) },
    ]);
    await expect(runVersionedMigrations(pool, [sql], { logger: {} })).resolves.toEqual({
      total: 1,
      applied: 0,
    });
    expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain(sql);
  });

  it("rolls back and fails closed when an applied migration was edited", async () => {
    const { client, pool } = mockPool([
      { version: 1, name: "legacy-reconciliation-0001", checksum: "old-checksum" },
    ]);
    await expect(runVersionedMigrations(pool, ["SELECT 1"], { logger: {} })).rejects.toThrow(
      /modified after being applied/,
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("rolls back the full batch when a statement fails", async () => {
    const { client, pool } = mockPool([]);
    client.query.mockImplementation(async (sql) => {
      if (String(sql).startsWith("SELECT version")) return { rows: [] };
      if (sql === "BROKEN") {
        const error = new Error("canceling statement due to statement timeout");
        error.code = "57014";
        throw error;
      }
      return { rows: [] };
    });
    await expect(runVersionedMigrations(pool, ["BROKEN"], { logger: {} })).rejects.toMatchObject({
      code: "57014",
      message: expect.stringMatching(/Migration 1.*statement timeout/),
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      client.query.mock.calls.some(([statement]) =>
        String(statement).startsWith("INSERT INTO schema_migrations"),
      ),
    ).toBe(false);
  });
});
