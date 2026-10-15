// The log storage destination resolver — regression guard for a real
// bug: `logStorageConfig()` built its S3/SSH secret fields ONLY from the
// NORA_LOG_* env block, never from the `platform_settings` row's own
// `*_encrypted` columns, even though `PUT /admin/log-storage` correctly
// encrypts and stores them there. An admin who set S3 credentials purely
// through the settings UI (no env vars) got `bucket`/`region`/`endpoint`
// from the DB but empty `accessKeyId`/`secretAccessKey`, which
// objectStorage.ts's `s3Config()` then rejected as "S3 storage is not fully
// configured" — a storage migration to that destination fails on segment 1.
//
// Same `node --test` convention as segmentWriter.test.js/logCollector.test.js
// (see package.json's "test" script) — this file lives at the top level,
// not under __tests__/.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { logStorageConfig, readPlatformLogStorageRow } = require("./logs/logStorageConfig.ts");

function fakeDb(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

function fakeDecrypt(map) {
  return (encrypted) => {
    if (Object.prototype.hasOwnProperty.call(map, encrypted)) return map[encrypted];
    throw new Error(`fakeDecrypt: no mapping for ${encrypted}`);
  };
}

test("readPlatformLogStorageRow returns null when there's no row", async () => {
  const row = await readPlatformLogStorageRow({ db: fakeDb(null) });
  assert.equal(row, null);
});

test("logStorageConfig decrypts the DB-stored S3 credentials, not just env vars", async () => {
  const db = fakeDb({
    log_storage_backend: "s3",
    log_storage_s3_bucket: "nora-logs-local",
    log_storage_s3_region: "us-east-1",
    log_storage_s3_endpoint: "http://minio:9000",
    log_storage_s3_access_key_id_encrypted: "enc-access-key",
    log_storage_s3_secret_access_key_encrypted: "enc-secret-key",
    log_storage_ssh_host: null,
    log_storage_ssh_port: null,
    log_storage_ssh_username: null,
    log_storage_ssh_remote_path: null,
    log_storage_ssh_private_key_encrypted: null,
    log_storage_ssh_password_encrypted: null,
  });
  const decrypt = fakeDecrypt({
    "enc-access-key": "noraminio",
    "enc-secret-key": "noraminiosecret",
  });

  const config = await logStorageConfig({ db, decrypt });

  assert.equal(config.storageBackend, "s3");
  assert.equal(config.bucket, "nora-logs-local");
  assert.equal(config.accessKeyId, "noraminio");
  assert.equal(config.secretAccessKey, "noraminiosecret");
});

test("falls back to env credentials when the DB row has no encrypted secret set", async () => {
  const db = fakeDb({
    log_storage_backend: "s3",
    log_storage_s3_bucket: "from-db",
    log_storage_s3_region: "us-east-1",
    log_storage_s3_endpoint: "",
    log_storage_s3_access_key_id_encrypted: null,
    log_storage_s3_secret_access_key_encrypted: null,
    log_storage_ssh_host: null,
    log_storage_ssh_port: null,
    log_storage_ssh_username: null,
    log_storage_ssh_remote_path: null,
    log_storage_ssh_private_key_encrypted: null,
    log_storage_ssh_password_encrypted: null,
  });
  const originalEnv = {
    NORA_LOG_S3_ACCESS_KEY_ID: process.env.NORA_LOG_S3_ACCESS_KEY_ID,
    NORA_LOG_S3_SECRET_ACCESS_KEY: process.env.NORA_LOG_S3_SECRET_ACCESS_KEY,
  };
  process.env.NORA_LOG_S3_ACCESS_KEY_ID = "env-access-key";
  process.env.NORA_LOG_S3_SECRET_ACCESS_KEY = "env-secret-key";
  try {
    const config = await logStorageConfig({ db, decrypt: fakeDecrypt({}) });
    assert.equal(config.bucket, "from-db");
    assert.equal(config.accessKeyId, "env-access-key");
    assert.equal(config.secretAccessKey, "env-secret-key");
  } finally {
    process.env.NORA_LOG_S3_ACCESS_KEY_ID = originalEnv.NORA_LOG_S3_ACCESS_KEY_ID;
    process.env.NORA_LOG_S3_SECRET_ACCESS_KEY = originalEnv.NORA_LOG_S3_SECRET_ACCESS_KEY;
  }
});

test("an unreadable encrypted value (decrypt throws) falls back to env rather than propagating", async () => {
  const db = fakeDb({
    log_storage_backend: "s3",
    log_storage_s3_bucket: "from-db",
    log_storage_s3_region: "us-east-1",
    log_storage_s3_endpoint: "",
    log_storage_s3_access_key_id_encrypted: "unreadable",
    log_storage_s3_secret_access_key_encrypted: "unreadable",
    log_storage_ssh_host: null,
    log_storage_ssh_port: null,
    log_storage_ssh_username: null,
    log_storage_ssh_remote_path: null,
    log_storage_ssh_private_key_encrypted: null,
    log_storage_ssh_password_encrypted: null,
  });
  const decrypt = () => {
    throw new Error("bad key");
  };
  const originalKey = process.env.NORA_LOG_S3_ACCESS_KEY_ID;
  process.env.NORA_LOG_S3_ACCESS_KEY_ID = "env-fallback-key";
  try {
    const config = await logStorageConfig({ db, decrypt });
    assert.equal(config.accessKeyId, "env-fallback-key");
  } finally {
    process.env.NORA_LOG_S3_ACCESS_KEY_ID = originalKey;
  }
});

test("decrypts SSH credentials the same way as S3", async () => {
  const db = fakeDb({
    log_storage_backend: "ssh",
    log_storage_s3_bucket: null,
    log_storage_s3_region: null,
    log_storage_s3_endpoint: null,
    log_storage_s3_access_key_id_encrypted: null,
    log_storage_s3_secret_access_key_encrypted: null,
    log_storage_ssh_host: "sftp.example.com",
    log_storage_ssh_port: 22,
    log_storage_ssh_username: "nora",
    log_storage_ssh_remote_path: "/logs",
    log_storage_ssh_private_key_encrypted: "enc-private-key",
    log_storage_ssh_password_encrypted: null,
  });
  const decrypt = fakeDecrypt({ "enc-private-key": "-----BEGIN KEY-----..." });

  const config = await logStorageConfig({ db, decrypt });
  assert.equal(config.sshHost, "sftp.example.com");
  assert.equal(config.sshPrivateKey, "-----BEGIN KEY-----...");
});

test("passing deps bypasses the module-level cache — each call re-resolves", async () => {
  let calls = 0;
  const db = {
    query: async () => {
      calls += 1;
      return {
        rows: [
          {
            log_storage_backend: "s3",
            log_storage_s3_bucket: `bucket-${calls}`,
            log_storage_s3_region: "us-east-1",
            log_storage_s3_endpoint: "",
            log_storage_s3_access_key_id_encrypted: null,
            log_storage_s3_secret_access_key_encrypted: null,
            log_storage_ssh_host: null,
            log_storage_ssh_port: null,
            log_storage_ssh_username: null,
            log_storage_ssh_remote_path: null,
            log_storage_ssh_private_key_encrypted: null,
            log_storage_ssh_password_encrypted: null,
          },
        ],
      };
    },
  };
  const first = await logStorageConfig({ db, decrypt: fakeDecrypt({}) });
  const second = await logStorageConfig({ db, decrypt: fakeDecrypt({}) });
  assert.equal(first.bucket, "bucket-1");
  assert.equal(second.bucket, "bucket-2");
  assert.equal(calls, 2);
});

// ── destination cache ─────────────────────────────────────────────────────

test("the destination cache re-resolves after its TTL, so an admin change reaches a running worker", async () => {
  const { createCachedResolver } = require("./logs/logStorageConfig.ts");
  let destination = "old";
  let resolves = 0;
  let clock = 0;
  const resolver = createCachedResolver({
    resolve: async () => {
      resolves += 1;
      return destination;
    },
    ttlMs: 5_000,
    now: () => clock,
  });

  assert.equal(await resolver.get(), "old");
  destination = "new"; // the admin changes it in another process
  clock += 4_999;
  assert.equal(
    await resolver.get(),
    "old",
    "within the TTL it is reused, so flushes do not hit the database",
  );
  assert.equal(resolves, 1);

  clock += 1;
  assert.equal(
    await resolver.get(),
    "new",
    "once the TTL passes the change is picked up with no restart",
  );
  assert.equal(resolves, 2);
});

test("invalidate forces the next call to re-resolve immediately", async () => {
  const { createCachedResolver } = require("./logs/logStorageConfig.ts");
  let value = 1;
  const resolver = createCachedResolver({
    resolve: async () => value,
    ttlMs: 60_000,
    now: () => 0,
  });
  assert.equal(await resolver.get(), 1);
  value = 2;
  assert.equal(await resolver.get(), 1);
  resolver.invalidate();
  assert.equal(await resolver.get(), 2);
});

test("concurrent callers share one in-flight resolve", async () => {
  const { createCachedResolver } = require("./logs/logStorageConfig.ts");
  let resolves = 0;
  const resolver = createCachedResolver({
    resolve: async () => {
      resolves += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "x";
    },
    now: () => 0,
  });
  await Promise.all([resolver.get(), resolver.get(), resolver.get()]);
  assert.equal(resolves, 1);
});

test("a failed resolve is not cached: the next call tries again", async () => {
  const { createCachedResolver } = require("./logs/logStorageConfig.ts");
  let attempts = 0;
  const resolver = createCachedResolver({
    resolve: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("db hiccup");
      return "ok";
    },
    now: () => 0,
  });
  await assert.rejects(resolver.get(), /db hiccup/);
  assert.equal(await resolver.get(), "ok");
  assert.equal(attempts, 2);
});
