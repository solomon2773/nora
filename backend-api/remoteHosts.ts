// @ts-nocheck
// Remote-host registry — Phase A of the Bring-Your-Own-Compute epic.
//
// Mirrors kubernetesClusters.ts: a registry of operator-owned remote machines
// (Mac/Windows/VPS/cloud) that Nora can reach over SSH to run the Docker
// adapter. A registered host surfaces as the execution target `remote:<id>`,
// the same way a Kubernetes cluster surfaces as `k8s:<id>`. SSH credentials are
// encrypted at rest with the shared AES-256-GCM helper.
//
// This module is intentionally self-contained (db + crypto only): it does not
// touch the shared backendCatalog selection logic. Wiring `remote-docker` into
// the deploy path and the gateway allowlist lands in later Phase A PRs.

const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");

const AUTH_MODES = new Set(["key", "password"]);
const DEFAULT_SSH_PORT = 22;
const DEFAULT_TEST_TIMEOUT_MS = 10000;
const DOCKER_VERSION_PROBE = "docker version --format '{{.Server.Version}}'";

let sshClientCtor = null;

function getSshClientCtor() {
  if (!sshClientCtor) {
    sshClientCtor = require("ssh2").Client;
  }
  return sshClientCtor;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSlug(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function normalizeHostId(value, fallbackLabel = "") {
  const normalized = normalizeSlug(value) || normalizeSlug(fallbackLabel);
  if (!normalized) {
    const error = new Error("Remote host id is required");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
    const error = new Error("Remote host id must be 2-64 lowercase letters, numbers, or dashes");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

// `remote:<id>` execution-target identifiers. Self-contained so this module
// does not depend on backendCatalog recognizing the `remote-docker` target yet.
function normalizeRemoteExecutionTargetId(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (!normalized.startsWith("remote:")) return null;
  const hostId = normalizeSlug(normalized.slice("remote:".length));
  return hostId ? `remote:${hostId}` : null;
}

function isRemoteDockerTarget(value) {
  const normalized = normalizeText(value).toLowerCase();
  return (
    normalized === "remote-docker" || normalized === "remote" || normalized.startsWith("remote:")
  );
}

function normalizeAuthMode(value, fallback = "key") {
  const normalized = normalizeText(value).toLowerCase();
  return AUTH_MODES.has(normalized) ? normalized : fallback;
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePort(value, fallback = null) {
  const parsed = parseInteger(value, null);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function normalizeBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function sshTargetLabel(profile) {
  const user = profile.sshUser ? `${profile.sshUser}@` : "";
  const port = profile.sshPort && profile.sshPort !== DEFAULT_SSH_PORT ? `:${profile.sshPort}` : "";
  return `${user}${profile.sshHost}${port}`;
}

function rowToProfile(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const id = normalizeHostId(row.id || row.host_id || row.label || "host");
  const executionTargetId = `remote:${id}`;
  const authMode = normalizeAuthMode(row.ssh_auth_mode);
  const sshHost = normalizeText(row.ssh_host);
  const sshUser = normalizeText(row.ssh_user);
  const label = normalizeText(row.label) || sshHost || id;
  const hasPrivateKey = Boolean(row.ssh_private_key_encrypted);
  const hasPassword = Boolean(row.ssh_password_encrypted);
  const hasCredential = authMode === "password" ? hasPassword : hasPrivateKey;
  const configured = Boolean(sshHost) && Boolean(sshUser) && hasCredential;
  const testedOk = row.last_test_status === "ok";
  const issue = !configured
    ? !sshHost
      ? "Remote host requires an SSH host address."
      : !sshUser
        ? "Remote host requires an SSH username."
        : authMode === "password"
          ? "Remote host requires an SSH password."
          : "Remote host requires an SSH private key."
    : !testedOk
      ? row.last_test_status === "failed"
        ? row.last_test_message || "Remote host connection test failed."
        : "Remote host must pass the connection test before deployment."
      : null;

  let sshPrivateKey = null;
  let sshPassword = null;
  let sshPassphrase = null;
  if (includeSecret) {
    if (row.ssh_private_key_encrypted) sshPrivateKey = decrypt(row.ssh_private_key_encrypted);
    if (row.ssh_password_encrypted) sshPassword = decrypt(row.ssh_password_encrypted);
    if (row.ssh_passphrase_encrypted) sshPassphrase = decrypt(row.ssh_passphrase_encrypted);
  }

  return {
    id,
    executionTargetId,
    adapter: "remote-docker",
    deployTarget: "remote-docker",
    ownerUserId: row.owner_user_id || null,
    label,
    shortLabel: label,
    enabled: row.enabled !== false,
    isDefault: row.is_default === true,
    sshHost,
    sshPort: parsePort(row.ssh_port, DEFAULT_SSH_PORT),
    sshUser,
    sshAuthMode: authMode,
    sshPrivateKey,
    sshPassword,
    sshPassphrase,
    gatewayHost: normalizeText(row.gateway_host) || sshHost,
    dockerHost: normalizeText(row.docker_host),
    sshHostKey: normalizeText(row.ssh_host_key),
    configured,
    connected: testedOk,
    available: row.enabled !== false && configured && testedOk,
    issue,
    lastTestStatus: row.last_test_status || null,
    lastTestMessage: row.last_test_message || null,
    lastTestedAt: row.last_tested_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function maskHost(row) {
  const profile = rowToProfile(row, { includeSecret: false });
  return {
    ...profile,
    hasSshPrivateKey: Boolean(row?.ssh_private_key_encrypted),
    hasSshPassword: Boolean(row?.ssh_password_encrypted),
    hasSshPassphrase: Boolean(row?.ssh_passphrase_encrypted),
    sshPrivateKey: undefined,
    sshPassword: undefined,
    sshPassphrase: undefined,
  };
}

function normalizeHostInput(input = {}, existing = null) {
  const label = normalizeText(input.label ?? existing?.label);
  const id = existing
    ? normalizeHostId(existing.id)
    : normalizeHostId(input.id || input.hostId, label);
  const authMode = normalizeAuthMode(
    input.sshAuthMode ?? input.ssh_auth_mode,
    existing?.ssh_auth_mode || "key",
  );

  const privateKeyInput = normalizeText(input.sshPrivateKey ?? input.ssh_private_key);
  const passwordInput = normalizeText(input.sshPassword ?? input.ssh_password);
  const passphraseInput = normalizeText(input.sshPassphrase ?? input.ssh_passphrase);
  const clearPrivateKey = normalizeBool(input.clearSshPrivateKey ?? input.clear_ssh_private_key);
  const clearPassword = normalizeBool(input.clearSshPassword ?? input.clear_ssh_password);
  const clearPassphrase = normalizeBool(input.clearSshPassphrase ?? input.clear_ssh_passphrase);

  if (privateKeyInput || passwordInput || passphraseInput) {
    ensureEncryptionConfigured("Remote host SSH credential storage");
  }

  let privateKeyEncrypted = existing?.ssh_private_key_encrypted || null;
  if (clearPrivateKey) privateKeyEncrypted = null;
  if (privateKeyInput) privateKeyEncrypted = encrypt(privateKeyInput);

  let passwordEncrypted = existing?.ssh_password_encrypted || null;
  if (clearPassword) passwordEncrypted = null;
  if (passwordInput) passwordEncrypted = encrypt(passwordInput);

  let passphraseEncrypted = existing?.ssh_passphrase_encrypted || null;
  if (clearPassphrase) passphraseEncrypted = null;
  if (passphraseInput) passphraseEncrypted = encrypt(passphraseInput);

  const ownerUserId = input.ownerUserId ?? input.owner_user_id ?? existing?.owner_user_id ?? null;

  return {
    id,
    ownerUserId: ownerUserId || null,
    label: label || id,
    enabled: normalizeBool(input.enabled, existing?.enabled ?? true),
    isDefault: normalizeBool(input.isDefault ?? input.is_default, existing?.is_default ?? false),
    sshHost: normalizeText(input.sshHost ?? input.ssh_host ?? existing?.ssh_host),
    sshPort: parsePort(input.sshPort ?? input.ssh_port, existing?.ssh_port ?? DEFAULT_SSH_PORT),
    sshUser: normalizeText(input.sshUser ?? input.ssh_user ?? existing?.ssh_user),
    sshAuthMode: authMode,
    sshPrivateKeyEncrypted: privateKeyEncrypted,
    sshPasswordEncrypted: passwordEncrypted,
    sshPassphraseEncrypted: passphraseEncrypted,
    gatewayHost: normalizeText(input.gatewayHost ?? input.gateway_host ?? existing?.gateway_host),
    dockerHost: normalizeText(input.dockerHost ?? input.docker_host ?? existing?.docker_host),
  };
}

function connectionInputChanged(existing, host) {
  if (!existing) return false;
  return (
    normalizeText(existing.ssh_host) !== host.sshHost ||
    parsePort(existing.ssh_port, DEFAULT_SSH_PORT) !== host.sshPort ||
    normalizeText(existing.ssh_user) !== host.sshUser ||
    normalizeText(existing.ssh_auth_mode) !== host.sshAuthMode ||
    normalizeText(existing.ssh_private_key_encrypted) !==
      normalizeText(host.sshPrivateKeyEncrypted) ||
    normalizeText(existing.ssh_password_encrypted) !== normalizeText(host.sshPasswordEncrypted) ||
    normalizeText(existing.ssh_passphrase_encrypted) !==
      normalizeText(host.sshPassphraseEncrypted) ||
    normalizeText(existing.docker_host) !== host.dockerHost
  );
}

async function listRemoteHosts(options = {}) {
  const includeDisabled = options.includeDisabled !== false;
  const includeSecret = options.includeSecret === true;
  const ownerUserId = options.ownerUserId || null;
  const conditions = [];
  const params = [];
  if (!includeDisabled) conditions.push("enabled = true");
  if (ownerUserId) {
    params.push(ownerUserId);
    conditions.push(`owner_user_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await db.query(
      `SELECT *
         FROM remote_hosts
        ${where}
        ORDER BY is_default DESC, label ASC, id ASC`,
      params,
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return rows.map((row) =>
      includeSecret ? rowToProfile(row, { includeSecret: true }) : maskHost(row),
    );
  } catch (error) {
    if (error?.code === "42P01") return []; // table not migrated yet
    throw error;
  }
}

async function listRemoteHostExecutionTargets(options = {}) {
  const hosts = await listRemoteHosts({ ...options, includeDisabled: false });
  return hosts.filter((host) => host.available);
}

async function getHostRow(hostId) {
  const id = normalizeHostId(hostId);
  const result = await db.query("SELECT * FROM remote_hosts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function getRemoteHostProfile(executionTargetId) {
  const normalized = normalizeRemoteExecutionTargetId(executionTargetId);
  if (!normalized) return null;
  const row = await getHostRow(normalized.slice("remote:".length));
  return rowToProfile(row, { includeSecret: true });
}

// Masked single-host lookup by id (no secrets) — used by the route layer to
// enforce per-owner access before mutating.
async function getRemoteHost(hostId) {
  const row = await getHostRow(hostId);
  return row ? maskHost(row) : null;
}

// Masked lookup by execution target ("remote:<id>"), no secret decryption —
// used by the gateway proxy to learn a remote host's advertised address.
async function getRemoteHostByExecutionTarget(executionTargetId) {
  const normalized = normalizeRemoteExecutionTargetId(executionTargetId);
  if (!normalized) return null;
  return getRemoteHost(normalized.slice("remote:".length));
}

async function clearOtherDefaults(hostId, ownerUserId) {
  await db.query(
    `UPDATE remote_hosts
        SET is_default = false
      WHERE id <> $1
        AND owner_user_id IS NOT DISTINCT FROM $2`,
    [hostId, ownerUserId || null],
  );
}

async function createRemoteHost(input = {}) {
  const host = normalizeHostInput(input);
  const result = await db.query(
    `INSERT INTO remote_hosts(
       id, owner_user_id, label, enabled, is_default,
       ssh_host, ssh_port, ssh_user, ssh_auth_mode,
       ssh_private_key_encrypted, ssh_password_encrypted, ssh_passphrase_encrypted,
       gateway_host, docker_host
     ) VALUES(
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12,
       $13, $14
     )
     RETURNING *`,
    [
      host.id,
      host.ownerUserId,
      host.label,
      host.enabled,
      host.isDefault,
      host.sshHost,
      host.sshPort,
      host.sshUser,
      host.sshAuthMode,
      host.sshPrivateKeyEncrypted,
      host.sshPasswordEncrypted,
      host.sshPassphraseEncrypted,
      host.gatewayHost,
      host.dockerHost,
    ],
  );
  if (host.isDefault) await clearOtherDefaults(host.id, host.ownerUserId);
  return maskHost(result.rows[0]);
}

async function updateRemoteHost(hostId, input = {}) {
  const existing = await getHostRow(hostId);
  if (!existing) {
    const error = new Error("Remote host not found");
    error.statusCode = 404;
    throw error;
  }
  const host = normalizeHostInput(input, existing);
  const resetTest = connectionInputChanged(existing, host);
  const result = await db.query(
    `UPDATE remote_hosts
        SET label = $2,
            owner_user_id = $3,
            enabled = $4,
            is_default = $5,
            ssh_host = $6,
            ssh_port = $7,
            ssh_user = $8,
            ssh_auth_mode = $9,
            ssh_private_key_encrypted = $10,
            ssh_password_encrypted = $11,
            ssh_passphrase_encrypted = $12,
            gateway_host = $13,
            docker_host = $14,
            last_test_status = CASE WHEN $15 THEN NULL ELSE last_test_status END,
            last_test_message = CASE WHEN $15 THEN NULL ELSE last_test_message END,
            last_tested_at = CASE WHEN $15 THEN NULL ELSE last_tested_at END,
            -- Clear the host-key pin too when connection inputs change, so the
            -- next test re-pins (trust-on-first-use) the now-different host. A
            -- key change WITHOUT a connection-input change keeps the pin, so a
            -- silent MITM on the same target still fails closed.
            ssh_host_key = CASE WHEN $15 THEN NULL ELSE ssh_host_key END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      existing.id,
      host.label,
      host.ownerUserId,
      host.enabled,
      host.isDefault,
      host.sshHost,
      host.sshPort,
      host.sshUser,
      host.sshAuthMode,
      host.sshPrivateKeyEncrypted,
      host.sshPasswordEncrypted,
      host.sshPassphraseEncrypted,
      host.gatewayHost,
      host.dockerHost,
      resetTest,
    ],
  );
  if (host.isDefault) await clearOtherDefaults(existing.id, host.ownerUserId);
  return maskHost(result.rows[0]);
}

async function deleteRemoteHost(hostId) {
  const id = normalizeHostId(hostId);
  const executionTargetId = `remote:${id}`;
  const usage = await db.query(
    "SELECT COUNT(*)::int AS count FROM agents WHERE execution_target_id = $1 AND status <> 'deleted'",
    [executionTargetId],
  );
  if ((usage.rows[0]?.count || 0) > 0) {
    const error = new Error("Cannot delete a remote host while agents still reference it");
    error.statusCode = 409;
    throw error;
  }
  const result = await db.query("DELETE FROM remote_hosts WHERE id = $1 RETURNING *", [id]);
  if (!result.rows[0]) {
    const error = new Error("Remote host not found");
    error.statusCode = 404;
    throw error;
  }
  return maskHost(result.rows[0]);
}

function buildSshConnectConfig(profile, timeoutMs, { onHostKey } = {}) {
  const config = {
    host: profile.sshHost,
    port: profile.sshPort || DEFAULT_SSH_PORT,
    username: profile.sshUser,
    readyTimeout: timeoutMs,
  };
  if (profile.sshAuthMode === "password") {
    config.password = profile.sshPassword || "";
  } else {
    config.privateKey = profile.sshPrivateKey || "";
    if (profile.sshPassphrase) config.passphrase = profile.sshPassphrase;
  }
  // Host-key pinning: capture the presented key (base64) for the caller, and —
  // when a key is already pinned — reject a mismatch (MITM / changed host).
  const expected = normalizeText(profile.sshHostKey);
  config.hostVerifier = (key) => {
    const presented = Buffer.isBuffer(key) ? key.toString("base64") : String(key || "");
    if (typeof onHostKey === "function") {
      try {
        onHostKey(presented);
      } catch {
        /* capture is best-effort */
      }
    }
    if (expected) return presented === expected;
    return true; // trust-on-first-use: no pin yet
  };
  return config;
}

// Connect over SSH and confirm the Docker daemon is reachable. Resolves to
// { ok, message } and never rejects so callers can persist the result.
function runRemoteDockerProbe(profile, { timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const Client = getSshClientCtor();
    const conn = new Client();
    let settled = false;
    // Capture the presented host key (base64) and detect a mismatch vs the pin.
    const expectedHostKey = normalizeText(profile.sshHostKey);
    let capturedHostKey = null;
    let hostKeyMismatch = false;
    const onHostKey = (presented) => {
      capturedHostKey = presented;
      if (expectedHostKey && presented !== expectedHostKey) hostKeyMismatch = true;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    conn.on("ready", () => {
      conn.exec(DOCKER_VERSION_PROBE, (err, stream) => {
        if (err) {
          finish({ ok: false, message: `Remote command failed: ${err.message}` });
          return;
        }
        let stdout = "";
        let stderr = "";
        stream
          .on("close", (code) => {
            const version = stdout.trim();
            if (code === 0 && version) {
              finish({
                ok: true,
                message: `Docker ${version} is reachable over SSH at ${sshTargetLabel(profile)}.`,
                hostKey: capturedHostKey,
              });
            } else {
              finish({
                ok: false,
                message:
                  stderr.trim() ||
                  `Docker is not available on ${profile.sshHost || "the remote host"} (exit ${code}).`,
              });
            }
          })
          .on("data", (chunk) => {
            stdout += chunk.toString();
          })
          .stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
      });
    });

    conn.on("error", (err) => {
      if (hostKeyMismatch) {
        finish({
          ok: false,
          hostKeyMismatch: true,
          message:
            "Remote host key does not match the pinned key — connection refused (possible " +
            "man-in-the-middle, or the host was rebuilt). Delete and re-register the host if this is expected.",
        });
        return;
      }
      finish({ ok: false, message: err?.message || "SSH connection failed." });
    });

    try {
      conn.connect(buildSshConnectConfig(profile, timeoutMs, { onHostKey }));
    } catch (err) {
      finish({ ok: false, message: err?.message || "SSH connection could not be started." });
    }
  });
}

async function testRemoteHost(hostId, options = {}) {
  const profile = await getRemoteHostProfile(`remote:${hostId}`);
  if (!profile) {
    const error = new Error("Remote host not found");
    error.statusCode = 404;
    throw error;
  }
  let status = "ok";
  let message = "Docker is reachable over SSH.";
  let pinHostKey = null;
  if (!profile.configured) {
    status = "failed";
    message = profile.issue || "Remote host is not configured.";
  } else {
    const probe = await runRemoteDockerProbe(profile, options);
    status = probe.ok ? "ok" : "failed";
    message = probe.message;
    // Trust-on-first-use: pin the host key on the first successful test. Once
    // pinned it's never overwritten here — a changed key fails the probe above
    // (hostKeyMismatch), so re-pinning requires an explicit re-register.
    if (probe.ok && probe.hostKey && !normalizeText(profile.sshHostKey)) {
      pinHostKey = probe.hostKey;
    }
  }
  const result = await db.query(
    `UPDATE remote_hosts
        SET last_test_status = $2,
            last_test_message = $3,
            ssh_host_key = COALESCE(ssh_host_key, $4),
            last_tested_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [profile.id, status, message, pinHostKey],
  );
  return maskHost(result.rows[0]);
}

// Deploy-path gate, mirroring assertKubernetesExecutionTargetAvailable. Wiring
// this into the deploy queue happens in a later Phase A PR; it lives here now so
// the contract is defined alongside the registry.
// Workspace roles (editor and above) that may USE a shared remote host — deploy
// agents to it and reach them through the gateway. Mirrors WORKSPACE_ROLE_RANK in
// middleware/ownership.ts (viewer:0, editor:1, admin:2, owner:3). Viewer can see a
// shared host (visibility) but not deploy to it. Host config stays owner-only.
const HOST_USE_ROLES = Object.freeze(["editor", "admin", "owner"]);

// True if the user owns the host OR it's shared into a workspace where they hold an
// editor+ role. Positive grant check — used to widen the owner-only deploy/reach
// gates to shared hosts without ever broadening cross-tenant SSRF.
async function userCanUseRemoteHost(userId, hostId) {
  if (!userId || !hostId) return false;
  const owned = await db.query(
    "SELECT 1 FROM remote_hosts WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
    [hostId, userId],
  );
  if (owned.rows[0]) return true;
  try {
    const shared = await db.query(
      `SELECT 1
         FROM workspace_remote_hosts wrh
         JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
        WHERE wrh.remote_host_id = $1
          AND wm.user_id = $2
          AND wm.role = ANY($3)
        LIMIT 1`,
      [hostId, userId, HOST_USE_ROLES],
    );
    return Boolean(shared.rows[0]);
  } catch (error) {
    if (error?.code === "42P01") return false; // grants table not migrated yet
    throw error;
  }
}

// Hosts a user can see: owned (full management) + shared into any workspace they
// belong to (read-only). Each entry is masked (no secrets) and annotated with the
// access kind + whether the user may deploy (editor+).
async function listAccessibleRemoteHosts(userId) {
  const owned = (await listRemoteHosts({ ownerUserId: userId, includeDisabled: true })).map(
    (host) => ({
      ...host,
      access: "owned",
      canDeploy: true,
    }),
  );
  const ownedIds = new Set(owned.map((host) => host.id));
  const shared = [];
  try {
    const rows = await db.query(
      `SELECT wrh.remote_host_id AS host_id,
              MAX(CASE wm.role
                    WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'editor' THEN 1 ELSE 0
                  END) AS rank
         FROM workspace_remote_hosts wrh
         JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
        WHERE wm.user_id = $1
        GROUP BY wrh.remote_host_id`,
      [userId],
    );
    for (const row of rows.rows) {
      if (ownedIds.has(row.host_id)) continue;
      const host = await getRemoteHost(row.host_id);
      if (!host) continue;
      shared.push({ ...host, access: "shared", canDeploy: Number(row.rank) >= 1 });
    }
  } catch (error) {
    if (error?.code !== "42P01") throw error; // grants table not migrated yet
  }
  return [...owned, ...shared];
}

// Share a host into a workspace (idempotent). Ownership + workspace-membership are
// enforced by the caller (route layer).
async function shareRemoteHost(hostId, workspaceId, byUserId) {
  await db.query(
    `INSERT INTO workspace_remote_hosts (workspace_id, remote_host_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, remote_host_id) DO NOTHING`,
    [workspaceId, hostId, byUserId || null],
  );
}

async function unshareRemoteHost(hostId, workspaceId) {
  await db.query(
    "DELETE FROM workspace_remote_hosts WHERE remote_host_id = $1 AND workspace_id = $2",
    [hostId, workspaceId],
  );
}

async function listRemoteHostShares(hostId) {
  try {
    const rows = await db.query(
      `SELECT wrh.workspace_id AS "workspaceId", w.name AS "workspaceName", wrh.created_at AS "createdAt"
         FROM workspace_remote_hosts wrh
         JOIN workspaces w ON w.id = wrh.workspace_id
        WHERE wrh.remote_host_id = $1
        ORDER BY w.name`,
      [hostId],
    );
    return rows.rows;
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

async function assertRemoteHostExecutionTargetAvailable(runtimeFields = {}, options = {}) {
  if (!isRemoteDockerTarget(runtimeFields.deploy_target ?? runtimeFields.deployTarget)) {
    return null;
  }
  const executionTargetId = normalizeRemoteExecutionTargetId(
    runtimeFields.execution_target_id || runtimeFields.executionTargetId,
  );
  if (!executionTargetId) {
    const error = new Error(
      "Remote-docker deployments require a registered host target such as remote:my-laptop.",
    );
    error.statusCode = 400;
    throw error;
  }
  const profile = await getRemoteHostProfile(executionTargetId);
  const ownerUserId = options.ownerUserId || null;
  // Owner-scoped, widened for sharing (C3): a host the user neither owns nor has an
  // editor+ grant on is treated as unknown (don't leak its existence, never deploy
  // cross-tenant). The grant check is positive — only explicit shares to a
  // workspace the user belongs to as editor+ unlock it.
  if (!profile) {
    const error = new Error(`Unknown remote host execution target: ${executionTargetId}`);
    error.statusCode = 400;
    throw error;
  }
  // Fail closed: a host the caller doesn't own — INCLUDING one with a null owner
  // (orphaned/corrupt) — is only reachable via an explicit editor+ grant, never by
  // the owner check short-circuiting on a null owner.
  if (ownerUserId && profile.ownerUserId !== ownerUserId) {
    const allowed = await userCanUseRemoteHost(ownerUserId, profile.id);
    if (!allowed) {
      const error = new Error(`Unknown remote host execution target: ${executionTargetId}`);
      error.statusCode = 400;
      throw error;
    }
  }
  if (!profile.enabled) {
    const error = new Error(`${profile.label} is disabled for new deployments.`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.configured) {
    const error = new Error(profile.issue || `${profile.label} is not configured.`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.connected) {
    const error = new Error(
      profile.issue || `${profile.label} must pass the connection test before deployment.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return profile;
}

module.exports = {
  assertRemoteHostExecutionTargetAvailable,
  createRemoteHost,
  deleteRemoteHost,
  getRemoteHost,
  getRemoteHostByExecutionTarget,
  getRemoteHostProfile,
  isRemoteDockerTarget,
  listRemoteHosts,
  listAccessibleRemoteHosts,
  listRemoteHostExecutionTargets,
  normalizeRemoteExecutionTargetId,
  rowToProfile,
  testRemoteHost,
  updateRemoteHost,
  userCanUseRemoteHost,
  shareRemoteHost,
  unshareRemoteHost,
  listRemoteHostShares,
};
