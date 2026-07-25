// @ts-nocheck
// Shared PostgreSQL/Redis connection normalization. The backend and workers
// intentionally consume the same helper so production TLS, URLs, credentials,
// and timeout behavior cannot drift between processes.

const fs = require("fs");

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPem(env, valueKey, fileKey) {
  const inline = String(env[valueKey] || "").trim();
  if (inline) return inline.replace(/\\n/g, "\n");

  const filePath = String(env[fileKey] || "").trim();
  if (!filePath) return undefined;
  return fs.readFileSync(filePath, "utf8");
}

function postgresSslMode(env = process.env) {
  const rawMode = String(env.DB_SSL_MODE || "")
    .trim()
    .toLowerCase();
  const mode = rawMode || (parseBoolean(env.DB_SSL) ? "require" : "disable");
  if (["", "disable", "disabled", "off", "false", "0"].includes(mode)) return "disable";
  if (!["require", "verify-ca", "verify-full"].includes(mode)) {
    throw new Error(
      `Unsupported DB_SSL_MODE "${mode}"; expected disable, require, verify-ca, or verify-full`,
    );
  }
  return mode;
}

function hasExplicitPostgresSslMode(env = process.env) {
  return (
    String(env.DB_SSL_MODE || "").trim() !== "" ||
    (env.DB_SSL !== undefined && env.DB_SSL !== null && String(env.DB_SSL).trim() !== "")
  );
}

const POSTGRES_SSL_URL_KEYS = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslcertmode",
  "sslkey",
  "sslpassword",
  "sslcrl",
  "sslcrldir",
  "sslsni",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "sslnegotiation",
  "requiressl",
];

function normalizePostgresConnectionString(env = process.env) {
  const raw = String(env.DATABASE_URL || env.DB_URL || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL/DB_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL/DB_URL must use the postgres or postgresql scheme");
  }
  // pg merges parsed connection-string values after explicit config. Strip
  // URL TLS knobs when DB_SSL_MODE/DB_SSL is explicitly set so the operator's
  // fail-closed policy cannot be downgraded by a conflicting query parameter.
  if (hasExplicitPostgresSslMode(env)) {
    for (const key of POSTGRES_SSL_URL_KEYS) parsed.searchParams.delete(key);
  } else if (parsed.searchParams.has("ssl")) {
    // node-postgres accepts a non-standard `ssl` URL parameter, while libpq
    // tools such as pg_dump reject it. Normalize the portable boolean forms to
    // sslmode so the application pool and backup CLI consume the same URL.
    const rawSsl = String(parsed.searchParams.get("ssl") || "")
      .trim()
      .toLowerCase();
    if (!parsed.searchParams.has("sslmode")) {
      if (["1", "true"].includes(rawSsl)) {
        parsed.searchParams.set("sslmode", "verify-full");
      } else if (["0", "false"].includes(rawSsl)) {
        parsed.searchParams.set("sslmode", "disable");
      } else {
        throw new Error(
          "DATABASE_URL/DB_URL ssl must be true, false, 1, or 0; use DB_SSL_MODE for other TLS policies",
        );
      }
    }
    parsed.searchParams.delete("ssl");
  }
  return parsed.toString();
}

function buildPostgresSsl(env = process.env) {
  const mode = postgresSslMode(env);
  if (mode === "disable") return undefined;

  const ca = readPem(env, "DB_SSL_CA", "DB_SSL_CA_FILE");
  const cert = readPem(env, "DB_SSL_CERT", "DB_SSL_CERT_FILE");
  const key = readPem(env, "DB_SSL_KEY", "DB_SSL_KEY_FILE");
  const verify = mode === "verify-ca" || mode === "verify-full";

  if (verify && !ca) {
    throw new Error(`${mode} requires DB_SSL_CA or DB_SSL_CA_FILE`);
  }

  return {
    rejectUnauthorized: verify,
    ...(mode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
  };
}

function decodeUrlCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Builds the libpq/pg_dump connection contract from the same environment used
// by the Node pg pool. Inline TLS material is returned as descriptors so the
// caller can place it in a private temporary directory without leaking PEM
// contents into argv or process listings.
function buildPostgresCliConfig(env = process.env) {
  const connectionString = normalizePostgresConnectionString(env);
  const urlControlsSsl = connectionString
    ? POSTGRES_SSL_URL_KEYS.some((key) => new URL(connectionString).searchParams.has(key))
    : false;
  const args = ["--no-owner", "--no-privileges", "--clean", "--if-exists"];
  const cliEnv = {
    PGAPPNAME: String(env.DB_APPLICATION_NAME || "nora-control-plane-backup"),
    PGCONNECT_TIMEOUT: String(
      Math.max(1, Math.ceil(parseInteger(env.DB_CONNECTION_TIMEOUT_MS, 10000) / 1000)),
    ),
    ...(hasExplicitPostgresSslMode(env) || !urlControlsSsl
      ? { PGSSLMODE: postgresSslMode(env) }
      : {}),
  };

  if (connectionString) {
    const parsed = new URL(connectionString);
    if (parsed.password) {
      cliEnv.PGPASSWORD = decodeUrlCredential(parsed.password);
      parsed.password = "";
    }
    args.push("--dbname", parsed.toString());
  } else {
    args.push(
      "-h",
      env.DB_HOST || "postgres",
      "-p",
      String(parseInteger(env.DB_PORT, 5432, { min: 1, max: 65535 })),
      "-U",
      env.DB_USER || "nora",
      env.DB_NAME || "nora",
    );
    cliEnv.PGPASSWORD = env.DB_PASSWORD || "nora";
  }

  const tlsFiles = [];
  for (const descriptor of [
    {
      envKey: "PGSSLROOTCERT",
      inlineKey: "DB_SSL_CA",
      fileKey: "DB_SSL_CA_FILE",
      filename: "root.crt",
    },
    {
      envKey: "PGSSLCERT",
      inlineKey: "DB_SSL_CERT",
      fileKey: "DB_SSL_CERT_FILE",
      filename: "client.crt",
    },
    {
      envKey: "PGSSLKEY",
      inlineKey: "DB_SSL_KEY",
      fileKey: "DB_SSL_KEY_FILE",
      filename: "client.key",
    },
  ]) {
    const filePath = String(env[descriptor.fileKey] || "").trim();
    if (filePath) {
      cliEnv[descriptor.envKey] = filePath;
      continue;
    }
    const inline = String(env[descriptor.inlineKey] || "").trim();
    if (inline) {
      tlsFiles.push({
        envKey: descriptor.envKey,
        filename: descriptor.filename,
        contents: inline.replace(/\\n/g, "\n"),
      });
    }
  }

  if (["verify-ca", "verify-full"].includes(cliEnv.PGSSLMODE)) {
    const hasCa = cliEnv.PGSSLROOTCERT || tlsFiles.some((file) => file.envKey === "PGSSLROOTCERT");
    if (!hasCa) {
      throw new Error(`${cliEnv.PGSSLMODE} requires DB_SSL_CA or DB_SSL_CA_FILE`);
    }
  }

  return { args, env: cliEnv, tlsFiles };
}

function buildPostgresConfig(env = process.env) {
  const connectionString = normalizePostgresConnectionString(env);
  const ssl = buildPostgresSsl(env);
  const common = {
    application_name: String(env.DB_APPLICATION_NAME || "nora-control-plane"),
    max: parseInteger(env.DB_POOL_MAX, 20, { min: 1, max: 200 }),
    idleTimeoutMillis: parseInteger(env.DB_IDLE_TIMEOUT_MS, 30000, {
      min: 1000,
      max: 3600000,
    }),
    connectionTimeoutMillis: parseInteger(env.DB_CONNECTION_TIMEOUT_MS, 10000, {
      min: 1000,
      max: 300000,
    }),
    statement_timeout: parseInteger(env.DB_STATEMENT_TIMEOUT_MS, 0, {
      min: 0,
      max: 86400000,
    }),
    ...(ssl ? { ssl } : {}),
  };

  if (connectionString) return { connectionString, ...common };

  return {
    user: env.DB_USER || "nora",
    password: env.DB_PASSWORD || "nora",
    host: env.DB_HOST || "postgres",
    database: env.DB_NAME || "nora",
    port: parseInteger(env.DB_PORT, 5432, { min: 1, max: 65535 }),
    ...common,
  };
}

function buildRedisTls(env = process.env) {
  if (!parseBoolean(env.REDIS_TLS)) return undefined;
  const ca = readPem(env, "REDIS_TLS_CA", "REDIS_TLS_CA_FILE");
  const cert = readPem(env, "REDIS_TLS_CERT", "REDIS_TLS_CERT_FILE");
  const key = readPem(env, "REDIS_TLS_KEY", "REDIS_TLS_KEY_FILE");
  return {
    rejectUnauthorized: !parseBoolean(env.REDIS_TLS_INSECURE_SKIP_VERIFY),
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
  };
}

function buildRedisConfig(env = process.env, overrides = {}) {
  const url = String(env.REDIS_URL || "").trim() || null;
  const tls = buildRedisTls(env);
  const options = {
    ...(url
      ? {}
      : {
          host: env.REDIS_HOST || "redis",
          port: parseInteger(env.REDIS_PORT, 6379, { min: 1, max: 65535 }),
        }),
    ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    ...(env.REDIS_DB ? { db: parseInteger(env.REDIS_DB, 0, { min: 0, max: 255 }) } : {}),
    ...(tls ? { tls } : {}),
    connectTimeout: parseInteger(env.REDIS_CONNECT_TIMEOUT_MS, 10000, {
      min: 1000,
      max: 300000,
    }),
    enableReadyCheck: true,
    ...overrides,
  };

  return { url, options };
}

function createRedisClient(IORedis, env = process.env, overrides = {}) {
  const { url, options } = buildRedisConfig(env, overrides);
  return url ? new IORedis(url, options) : new IORedis(options);
}

module.exports = {
  buildPostgresCliConfig,
  buildPostgresConfig,
  buildPostgresSsl,
  buildRedisConfig,
  buildRedisTls,
  createRedisClient,
  hasExplicitPostgresSslMode,
  normalizePostgresConnectionString,
  parseBoolean,
  parseInteger,
  postgresSslMode,
};
