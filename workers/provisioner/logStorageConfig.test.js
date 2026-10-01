// Phase 5's log storage destination resolver — regression guard for a real
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
