// @ts-nocheck

const {
  buildPostgresCliConfig,
  buildPostgresConfig,
  buildPostgresSsl,
  buildRedisConfig,
  normalizePostgresConnectionString,
} = require("../lib/connectionConfig");
const ConnectionParameters = require("pg/lib/connection-parameters");

describe("connectionConfig", () => {
  it("builds bounded PostgreSQL pool settings and supports DATABASE_URL", () => {
    expect(
      buildPostgresConfig({
        DATABASE_URL: "postgres://nora:secret@db.example/nora",
        DB_POOL_MAX: "500",
        DB_CONNECTION_TIMEOUT_MS: "15000",
      }),
    ).toEqual(
      expect.objectContaining({
        connectionString: "postgres://nora:secret@db.example/nora",
        max: 200,
        connectionTimeoutMillis: 15000,
      }),
    );
  });

  it("requires a CA for PostgreSQL verification modes", () => {
    expect(() => buildPostgresSsl({ DB_SSL_MODE: "verify-full" })).toThrow(/requires DB_SSL_CA/);
    expect(
      buildPostgresSsl({
        DB_SSL_MODE: "verify-full",
        DB_SSL_CA: "line-1\\nline-2",
      }),
    ).toEqual({ rejectUnauthorized: true, ca: "line-1\nline-2" });
    expect(
      buildPostgresSsl({
        DB_SSL_MODE: "verify-ca",
        DB_SSL_CA: "ca",
      }).checkServerIdentity,
    ).toEqual(expect.any(Function));
  });

  it("prevents DATABASE_URL query parameters from downgrading explicit TLS policy", () => {
    const config = buildPostgresConfig({
      DATABASE_URL:
        "postgres://nora:secret@db.example/nora?ssl=0&sslmode=disable&sslrootcert=%2Ftmp%2Fevil-ca",
      DB_SSL_MODE: "verify-full",
      DB_SSL_CA: "trusted-ca",
    });
    expect(config.connectionString).not.toMatch(/[?&]ssl(?:mode|rootcert|)=/);
    const effective = new ConnectionParameters(config);
    expect(effective.ssl).toEqual(
      expect.objectContaining({ rejectUnauthorized: true, ca: "trusted-ca" }),
    );
  });

  it("normalizes URL-only ssl booleans for pg and pg_dump parity", () => {
    const tlsUrl =
      "postgres://nora:secret@db.example/nora?ssl=true&target_session_attrs=read-write";
    const tlsConfig = buildPostgresConfig({ DATABASE_URL: tlsUrl });
    const normalizedTlsUrl = new URL(tlsConfig.connectionString);
    expect(normalizedTlsUrl.searchParams.get("ssl")).toBeNull();
    expect(normalizedTlsUrl.searchParams.get("sslmode")).toBe("verify-full");
    expect(normalizedTlsUrl.searchParams.get("target_session_attrs")).toBe("read-write");
    expect(new ConnectionParameters(tlsConfig).ssl).toBeTruthy();

    const tlsCli = buildPostgresCliConfig({ DATABASE_URL: tlsUrl });
    const cliUrl = new URL(tlsCli.args.at(-1));
    expect(cliUrl.searchParams.get("ssl")).toBeNull();
    expect(cliUrl.searchParams.get("sslmode")).toBe("verify-full");
    expect(tlsCli.env).not.toHaveProperty("PGSSLMODE");

    const plaintextConfig = buildPostgresConfig({
      DATABASE_URL: "postgres://nora:secret@db.example/nora?ssl=0",
    });
    expect(new URL(plaintextConfig.connectionString).searchParams.get("sslmode")).toBe("disable");
    expect(new ConnectionParameters(plaintextConfig).ssl).toBe(false);
  });

  it("rejects ambiguous URL-only ssl values", () => {
    expect(() =>
      normalizePostgresConnectionString({
        DATABASE_URL: "postgres://nora:secret@db.example/nora?ssl=no-verify",
      }),
    ).toThrow(/ssl must be true, false, 1, or 0/);
  });

  it("builds a credential-safe pg_dump contract from DATABASE_URL and inline TLS", () => {
    const result = buildPostgresCliConfig({
      DATABASE_URL:
        "postgres://nora:p%40ss@db.example:5433/nora?sslmode=disable&sslrootcert=%2Ftmp%2Fevil&target_session_attrs=read-write",
      DB_SSL_MODE: "verify-full",
      DB_SSL_CA: "ca-line-1\\nca-line-2",
      DB_SSL_CERT_FILE: "/run/secrets/client.crt",
      DB_CONNECTION_TIMEOUT_MS: "15500",
    });

    expect(result.args).toEqual(
      expect.arrayContaining([
        "--dbname",
        "postgres://nora@db.example:5433/nora?target_session_attrs=read-write",
      ]),
    );
    expect(result.args.join(" ")).not.toContain("p%40ss");
    expect(result.env).toEqual(
      expect.objectContaining({
        PGPASSWORD: "p@ss",
        PGSSLMODE: "verify-full",
        PGSSLCERT: "/run/secrets/client.crt",
        PGCONNECT_TIMEOUT: "16",
      }),
    );
    expect(result.tlsFiles).toEqual([
      { envKey: "PGSSLROOTCERT", filename: "root.crt", contents: "ca-line-1\nca-line-2" },
    ]);
  });

  it("supports authenticated TLS Redis URLs", () => {
    expect(
      buildRedisConfig({
        REDIS_URL: "rediss://cache.example:6380/2",
        REDIS_USERNAME: "nora",
        REDIS_PASSWORD: "secret",
        REDIS_TLS: "true",
        REDIS_TLS_CA: "ca-data",
      }),
    ).toEqual({
      url: "rediss://cache.example:6380/2",
      options: expect.objectContaining({
        username: "nora",
        password: "secret",
        tls: { rejectUnauthorized: true, ca: "ca-data" },
      }),
    });
  });

  it("keeps local Redis defaults simple when TLS is disabled", () => {
    expect(buildRedisConfig({})).toEqual({
      url: null,
      options: expect.objectContaining({ host: "redis", port: 6379 }),
    });
  });
});
