// @ts-nocheck
// Remote-host registry for Nora's Bring-Your-Own-Compute path.
//
// Mirrors kubernetesClusters.ts: personal and platform-owned remote machines
// (normally Linux Docker servers, VPSes, or cloud VMs) surface as concrete
// `remote:<id>` execution targets. SSH credentials are encrypted at rest with
// the shared AES-256-GCM helper.
//
// The module owns registration, access, trust-on-first-use testing, and
// credential loading; deploy, gateway, lifecycle, and backup callers consume
// these checks through its exported authorization helpers.

const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const { Client } = require("pg");
const { buildPostgresConfig } = require("./lib/connectionConfig");
const dns = require("node:dns").promises;
const net = require("node:net");
const { PRIVATE_IP_RE } = require("./networkSafety");

const AUTH_MODES = new Set(["key", "password"]);
const MANAGEMENT_SCOPES = new Set(["user", "platform"]);
const DEFAULT_SSH_PORT = 22;
const DEFAULT_TEST_TIMEOUT_MS = 10000;
const DEFAULT_MUTATION_LOCK_TIMEOUT_MS = 15000;
const MUTATION_LOCK_POLL_MS = 50;
const DOCKER_VERSION_PROBE = "docker version --format '{{.Server.Version}}'";
const REMOTE_HOSTNAME_RE = /^[A-Za-z0-9._-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_HOST_MUTATION_LOCK_PREFIX = "nora:remote-host-mutation:";

let sshClientCtor = null;

function getSshClientCtor() {
  if (!sshClientCtor) {
    sshClientCtor = require("ssh2").Client;
  }
  return sshClientCtor;
}

// Input normalization and profile serialization

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPaaSMode() {
  return (
    String(process.env.PLATFORM_MODE || "selfhosted")
      .trim()
      .toLowerCase() === "paas"
  );
}

function assertRemoteHostsSupported() {
  if (!isPaaSMode()) return;
  const error = new Error(
    "Remote Docker hosts are disabled in hosted mode because agent runtime traffic is not end-to-end encrypted; use a self-hosted Nora control plane on the same private network",
  );
  error.statusCode = 403;
  error.code = "REMOTE_HOSTS_DISABLED_IN_PAAS";
  throw error;
}

function normalizeRemoteAddress(value, label) {
  const host = normalizeText(value);
  if (!host) return "";
  if (host.length > 253 || (!net.isIP(host) && !REMOTE_HOSTNAME_RE.test(host))) {
    const error = new Error(
      `${label} must be a plain hostname or IP address without a scheme or port`,
    );
    error.statusCode = 400;
    throw error;
  }
  return host;
}

function isUnroutableRemoteAddress(address) {
  const normalized = String(address || "")
    .trim()
    .toLowerCase();
  if (PRIVATE_IP_RE.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (net.isIP(normalized) === 4) {
    const first = Number.parseInt(normalized.split(".")[0], 10);
    return first >= 224;
  }
  return false;
}

async function resolveRemoteAddressForRuntime(value, label, { publicOnly = isPaaSMode() } = {}) {
  const host = normalizeRemoteAddress(value, label);
  if (!host) return "";
  if (net.isIP(host)) {
    if (publicOnly && isUnroutableRemoteAddress(host)) {
      const error = new Error(`${label} must use a public address in hosted mode`);
      error.statusCode = 400;
      throw error;
    }
    return host;
  }
  if (!publicOnly) return host;

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    const validationError = new Error(
      `${label} hostname ${host} could not be resolved (${error.code || error.message})`,
    );
    validationError.statusCode = 400;
    throw validationError;
  }
  const unsafe = addresses.find((entry) => isUnroutableRemoteAddress(entry.address));
  if (unsafe) {
    const error = new Error(
      `${label} must resolve only to public addresses in hosted mode (${unsafe.address} is private or unroutable)`,
    );
    error.statusCode = 400;
    throw error;
  }
  if (!addresses[0]?.address) {
    const error = new Error(`${label} hostname ${host} did not resolve to an address`);
    error.statusCode = 400;
    throw error;
  }
  // Hosted-mode callers use the validated IP directly, closing the DNS
  // rebinding window between registry lookup and SSH/readiness/proxy traffic.
  return addresses[0].address;
}

async function resolveRemoteHostRuntimeProfile(profile) {
  if (!profile) return null;
  const rawSshHost = profile.sshHost;
  const rawGatewayHost = profile.gatewayHost || profile.sshHost;
  const [sshHost, gatewayHost] = await Promise.all([
    resolveRemoteAddressForRuntime(rawSshHost, "Remote SSH host"),
    resolveRemoteAddressForRuntime(rawGatewayHost, "Remote gateway address"),
  ]);
  return { ...profile, rawSshHost, rawGatewayHost, sshHost, gatewayHost };
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

function requireRemoteHostOwnerUserId(value) {
  const ownerUserId = normalizeText(value);
  if (ownerUserId) return ownerUserId;
  const error = new Error("Remote host owner is required");
  error.statusCode = 400;
  error.code = "REMOTE_HOST_OWNER_REQUIRED";
  throw error;
}

function normalizeManagementScope(value, fallback = "user") {
  const normalized = normalizeText(value).toLowerCase();
  return MANAGEMENT_SCOPES.has(normalized) ? normalized : fallback;
}

function createPlatformRemoteHostNotFoundError() {
  const error = createRemoteHostNotFoundError();
  error.code = "PLATFORM_REMOTE_HOST_NOT_FOUND";
  return error;
}

function createRemoteHostIdRetiredError(hostId) {
  const error = new Error(
    `Remote host id "${normalizeHostId(hostId)}" was permanently retired after deletion; choose a new id`,
  );
  error.statusCode = 409;
  error.code = "REMOTE_HOST_ID_RETIRED";
  return error;
}

function createRemoteHostNotFoundError() {
  const error = new Error("Remote host not found");
  error.statusCode = 404;
  return error;
}

function remoteHostMutationLockKey(hostId) {
  return `${REMOTE_HOST_MUTATION_LOCK_PREFIX}${normalizeHostId(hostId)}`;
}

function remoteHostMutationLockTimeoutMs() {
  const configured = Number.parseInt(process.env.REMOTE_HOST_MUTATION_LOCK_TIMEOUT_MS || "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MUTATION_LOCK_TIMEOUT_MS;
}

function waitForMutationLockPoll(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRemoteHostMutationClient() {
  const {
    max: _max,
    min: _min,
    idleTimeoutMillis: _idleTimeoutMillis,
    ...clientConfig
  } = buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: "nora-backend-remote-host-mutation",
  });
  return new Client(clientConfig);
}

async function withRemoteHostMutationLock(hostId, operation) {
  const lockKey = remoteHostMutationLockKey(hostId);
  const client = createRemoteHostMutationClient();
  let connected = false;
  let lockHeld = false;
  try {
    await client.connect();
    connected = true;
    const timeoutMs = remoteHostMutationLockTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    while (!lockHeld) {
      const acquired = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [lockKey],
      );
      lockHeld = Boolean(acquired.rows[0]?.locked);
      if (lockHeld) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = new Error(
          `Another remote host operation is still active for ${normalizeHostId(hostId)}`,
        );
        error.statusCode = 409;
        error.code = "REMOTE_HOST_MUTATION_LOCK_TIMEOUT";
        throw error;
      }
      await waitForMutationLockPoll(Math.min(MUTATION_LOCK_POLL_MS, remaining));
    }
    return await operation();
  } finally {
    if (lockHeld) {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch((error) =>
          console.warn(
            `[remoteHosts] advisory unlock failed for host ${normalizeHostId(hostId)}: ${error.message}`,
          ),
        );
    }
    if (connected) {
      await client
        .end()
        .catch((error) =>
          console.warn(
            `[remoteHosts] mutation lock connection close failed for host ${normalizeHostId(hostId)}: ${error.message}`,
          ),
        );
    }
  }
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

function isRemoteDockerAgent(agent = {}) {
  return [
    agent.deploy_target,
    agent.deployTarget,
    agent.backend_type,
    agent.backendType,
    agent.execution_target_id,
    agent.executionTargetId,
  ].some((value) => isRemoteDockerTarget(value));
}

function createRemoteHostAccessRevokedError() {
  const error = new Error(
    "Remote Docker host access has been revoked; stop or delete the agent, or ask the host owner to share the host again",
  );
  error.statusCode = 403;
  error.code = "REMOTE_HOST_ACCESS_REVOKED";
  return error;
}

function createRemoteHostRetestRequiredError(host) {
  const error = new Error(
    `${host?.label || "Remote Docker host"} must pass Test before Nora can use it again`,
  );
  error.statusCode = 409;
  error.code = "REMOTE_HOST_RETEST_REQUIRED";
  return error;
}

function createRemoteHostCleanupPinRequiredError(host) {
  const error = new Error(
    `Cannot safely clean up Remote Docker runtime on ${host?.label || host?.id || "the registered host"}: ` +
      "the SSH host-key pin is missing. Nora refused the connection because accepting an unknown key " +
      "could send cleanup credentials or destructive Docker commands to an impersonated host. The " +
      "runtime may still be running; verify the host out of band, restore a trusted pin with Test where " +
      "available, or remove the runtime manually on the verified host.",
  );
  error.statusCode = 409;
  error.code = "REMOTE_HOST_CLEANUP_PIN_REQUIRED";
  error.orphanRisk = true;
  return error;
}

function toPublicRemoteHostAuthorizationError(error) {
  if (
    isRemoteHostAccessRevokedError(error) ||
    error?.code === "REMOTE_HOST_RETEST_REQUIRED" ||
    error?.code === "REMOTE_HOST_AUTH_CHECK_FAILED"
  ) {
    return error;
  }
  const publicError = new Error("Unable to verify Remote Docker host access");
  publicError.statusCode = 503;
  publicError.code = "REMOTE_HOST_AUTH_CHECK_FAILED";
  if (error) publicError.cause = error;
  return publicError;
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

/**
 * Convert a remote-host row into its provisioning profile and derived availability state.
 * Secrets remain masked unless explicitly requested by a trusted internal caller.
 *
 * @param {Object} row - Remote-host database row.
 * @param {Object} [options={}] - Profile serialization options.
 * @returns {Object|null} Normalized remote-host profile.
 */
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
  const hasHostKeyPin = Boolean(normalizeText(row.ssh_host_key));
  // A legacy `last_test_status=ok` row without the key captured by that test is
  // not a trusted connection. Treat it exactly like a host that needs a fresh
  // Test so ordinary lifecycle/runtime traffic never falls back to TOFU.
  const testedOk = row.last_test_status === "ok" && hasHostKeyPin;
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
        : row.last_test_status === "ok"
          ? "Remote host must pass Test again so Nora can pin its SSH host key."
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
    managementScope: normalizeManagementScope(row.management_scope),
    ownerUserId: row.owner_user_id || null,
    ownerEmail: row.owner_email || row.ownerEmail || null,
    ownerName: row.owner_name || row.ownerName || null,
    createdByUserId: row.created_by_user_id || null,
    createdByEmail: row.created_by_email || row.createdByEmail || null,
    createdByName: row.created_by_name || row.createdByName || null,
    availableToAll: row.available_to_all === true,
    accessVersion: Number(row.access_version || 1),
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

/**
 * Mask a host for a platform-admin listing. A platform-owned host is returned
 * fully masked like any other; a personal host is reduced to identity and
 * status fields only, so the operator's network address, credentials, host-key
 * pin, and probe diagnostics stay private to the owner who registered it.
 *
 * @param {Object} row - Remote-host database row.
 * @returns {Object} Admin-safe host profile.
 */
function maskAdminHost(row) {
  const host = maskHost(row);
  if (host.managementScope === "platform") return host;
  // Platform admins may inventory personal hosts and their owning account, but
  // personal network identity, credentials, pins, and probe diagnostics remain
  // private to the operator who registered the host.
  return {
    id: host.id,
    executionTargetId: host.executionTargetId,
    adapter: host.adapter,
    deployTarget: host.deployTarget,
    managementScope: host.managementScope,
    ownerUserId: host.ownerUserId,
    ownerEmail: host.ownerEmail,
    ownerName: host.ownerName,
    createdByUserId: host.createdByUserId,
    createdByEmail: host.createdByEmail,
    createdByName: host.createdByName,
    availableToAll: false,
    label: host.label,
    shortLabel: host.shortLabel,
    enabled: host.enabled,
    isDefault: host.isDefault,
    configured: host.configured,
    connected: host.connected,
    available: host.available,
    lastTestStatus: host.lastTestStatus,
    lastTestedAt: host.lastTestedAt,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
    operationalMetadataRedacted: true,
  };
}

/**
 * Normalize create or update input, encrypting new SSH credentials and honoring explicit clears.
 *
 * @param {Object} [input={}] - Requested remote-host fields.
 * @param {Object|null} [existing=null] - Existing row whose omitted values should be preserved.
 * @returns {Object} Database-facing host fields with encrypted credential material.
 */
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
    sshHost: normalizeRemoteAddress(
      input.sshHost ?? input.ssh_host ?? existing?.ssh_host,
      "Remote SSH host",
    ),
    sshPort: parsePort(input.sshPort ?? input.ssh_port, existing?.ssh_port ?? DEFAULT_SSH_PORT),
    sshUser: normalizeText(input.sshUser ?? input.ssh_user ?? existing?.ssh_user),
    sshAuthMode: authMode,
    sshPrivateKeyEncrypted: privateKeyEncrypted,
    sshPasswordEncrypted: passwordEncrypted,
    sshPassphraseEncrypted: passphraseEncrypted,
    gatewayHost: normalizeRemoteAddress(
      input.gatewayHost ?? input.gateway_host ?? existing?.gateway_host,
      "Remote gateway address",
    ),
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
    normalizeText(existing.gateway_host) !== host.gatewayHost ||
    normalizeText(existing.docker_host) !== host.dockerHost
  );
}

function sshHostIdentityChanged(existing, host) {
  if (!existing) return false;
  return (
    normalizeText(existing.ssh_host) !== host.sshHost ||
    parsePort(existing.ssh_port, DEFAULT_SSH_PORT) !== host.sshPort
  );
}

// Registry persistence

/**
 * List remote hosts with optional owner scoping and secret inclusion.
 * A missing registry table is treated as an empty installation during migrations.
 *
 * @param {Object} [options={}] - Disabled-row, owner, and secret visibility options.
 * @returns {Promise<Array>} Normalized host profiles.
 */
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
  if (isPaaSMode()) return [];
  if (options.ownerUserId) {
    const hosts = await listAccessibleRemoteHosts(options.ownerUserId);
    return hosts.filter((host) => host.available && host.canDeploy !== false);
  }
  const hosts = await listRemoteHosts({ ...options, includeDisabled: false });
  return hosts.filter((host) => host.available);
}

async function getHostRow(hostId) {
  const id = normalizeHostId(hostId);
  const result = await db.query("SELECT * FROM remote_hosts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function getPlatformHostRow(hostId, queryable = db, { forUpdate = false } = {}) {
  const id = normalizeHostId(hostId);
  const result = await queryable.query(
    `SELECT *
       FROM remote_hosts
      WHERE id = $1
        AND management_scope = 'platform'${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] || null;
}

async function listAdminRemoteHosts() {
  const result = await db.query(
    `SELECT rh.*,
            owner.email AS owner_email,
            owner.name AS owner_name,
            creator.email AS created_by_email,
            creator.name AS created_by_name
       FROM remote_hosts rh
       LEFT JOIN users owner ON owner.id = rh.owner_user_id
       LEFT JOIN users creator ON creator.id = rh.created_by_user_id
      ORDER BY CASE WHEN rh.management_scope = 'platform' THEN 0 ELSE 1 END,
               rh.is_default DESC,
               LOWER(rh.label),
               rh.id`,
  );
  return result.rows.map(maskAdminHost);
}

async function getAdminRemoteHost(hostId) {
  const id = normalizeHostId(hostId);
  const result = await db.query(
    `SELECT rh.*,
            owner.email AS owner_email,
            owner.name AS owner_name,
            creator.email AS created_by_email,
            creator.name AS created_by_name
       FROM remote_hosts rh
       LEFT JOIN users owner ON owner.id = rh.owner_user_id
       LEFT JOIN users creator ON creator.id = rh.created_by_user_id
      WHERE rh.id = $1`,
    [id],
  );
  return result.rows[0] ? maskAdminHost(result.rows[0]) : null;
}

async function getOwnedHostRow(hostId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const result = await db.query("SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2", [
    id,
    ownerUserId,
  ]);
  const row = result.rows[0] || null;
  // Platform rows are deliberately never manageable through owner/operator
  // helpers, even if corrupt legacy data happens to carry an owner id.
  return row && normalizeManagementScope(row.management_scope) === "user" ? row : null;
}

/**
 * Load a secret-bearing remote-host profile for trusted provisioning callers.
 * This lookup performs no user authorization or availability check and returns
 * null in hosted mode.
 *
 * @param {string} executionTargetId - Target in `remote:<id>` form.
 * @returns {Promise<Object|null>} Decrypted provisioning profile or `null`.
 */
async function getRemoteHostProfile(executionTargetId) {
  if (isPaaSMode()) return null;
  const normalized = normalizeRemoteExecutionTargetId(executionTargetId);
  if (!normalized) return null;
  const row = await getHostRow(normalized.slice("remote:".length));
  return resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
}

function createRemoteHostCleanupTargetError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = "REMOTE_HOST_CLEANUP_TARGET_INVALID";
  return error;
}

// Stop/destroy need one deliberately narrower escape hatch than ordinary
// Remote Docker use. It reads only the host named by the persisted agent's
// explicit execution target, including in PaaS mode, where registration and
// every active-use lookup remain disabled. Callers must not derive this target
// from deploy_target/backend_type because those identify only the adapter, not
// the exact machine that owns the runtime being retired.
async function getRemoteHostCleanupProfile(agent = {}) {
  const rawExecutionTargetId = normalizeText(
    agent.execution_target_id ?? agent.executionTargetId,
  ).toLowerCase();
  const executionTargetId = normalizeRemoteExecutionTargetId(rawExecutionTargetId);
  if (!executionTargetId || rawExecutionTargetId !== executionTargetId) {
    throw createRemoteHostCleanupTargetError(
      "Remote Docker cleanup requires the agent's exact remote:<host-id> execution target",
    );
  }

  const row = await getHostRow(executionTargetId.slice("remote:".length));
  if (!row) return null;

  // Verify the returned registry identity before decrypting credentials. The
  // equality is redundant with a healthy primary-key lookup but keeps this
  // privileged cleanup path fail-closed under corrupt/misrouted data access.
  const rowExecutionTargetId = `remote:${normalizeHostId(row.id)}`;
  if (rowExecutionTargetId !== executionTargetId) {
    throw createRemoteHostCleanupTargetError(
      "Remote Docker cleanup host does not match the agent execution target",
    );
  }

  // Cleanup deliberately bypasses the current workspace grant and Test status,
  // but it must never bypass machine identity. A retained pin lets stop/delete
  // target the exact previously trusted host after revocation or a failed
  // retest. Without one (legacy row, explicit reset, or host-address change),
  // fail with an orphan-risk warning before decrypting credentials.
  if (!normalizeText(row.ssh_host_key)) {
    throw createRemoteHostCleanupPinRequiredError({
      id: row.id,
      label: normalizeText(row.label),
    });
  }

  const profile = rowToProfile(row, { includeSecret: true });
  // Existing agents may reference private-network hosts registered before a
  // control plane switched to PaaS mode. Cleanup uses that immutable stored
  // address only; PaaS still blocks create/update/test/list/use paths, so this
  // cannot register or activate a new private target.
  const rawSshHost = profile.sshHost;
  const rawGatewayHost = profile.gatewayHost || profile.sshHost;
  const [sshHost, gatewayHost] = await Promise.all([
    resolveRemoteAddressForRuntime(rawSshHost, "Remote SSH host", { publicOnly: false }),
    resolveRemoteAddressForRuntime(rawGatewayHost, "Remote gateway address", {
      publicOnly: false,
    }),
  ]);
  return { ...profile, rawSshHost, rawGatewayHost, sshHost, gatewayHost };
}

// Masked single-host lookup by id (no secrets) — used by the route layer to
// enforce per-owner access before mutating.
async function getRemoteHost(hostId) {
  const row = await getHostRow(hostId);
  return row ? maskHost(row) : null;
}

/**
 * Load a masked host by execution target for address allowlisting without decrypting credentials.
 *
 * @param {string} executionTargetId - Target in `remote:<id>` form.
 * @returns {Promise<Object|null>} Masked host profile or `null`.
 */
async function getRemoteHostByExecutionTarget(executionTargetId) {
  if (isPaaSMode()) return null;
  const normalized = normalizeRemoteExecutionTargetId(executionTargetId);
  if (!normalized) return null;
  const host = await getRemoteHost(normalized.slice("remote:".length));
  return resolveRemoteHostRuntimeProfile(host);
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

async function createRemoteHostLocked(host) {
  const result = await db.query(
    `INSERT INTO remote_hosts(
       id, owner_user_id, label, enabled, is_default,
       ssh_host, ssh_port, ssh_user, ssh_auth_mode,
       ssh_private_key_encrypted, ssh_password_encrypted, ssh_passphrase_encrypted,
       gateway_host, docker_host
     )
     SELECT $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14
      WHERE NOT EXISTS (
        SELECT 1 FROM remote_host_id_tombstones WHERE remote_host_id = $1
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
  if (!result.rows[0]) throw createRemoteHostIdRetiredError(host.id);
  if (host.isDefault) await clearOtherDefaults(host.id, host.ownerUserId);
  return maskHost(result.rows[0]);
}

/**
 * Register an owner-scoped remote host under a per-host mutation lock, validating
 * its runtime addresses and encrypting supplied SSH credentials.
 *
 * @param {Object} [input={}] - Remote-host registration fields from a trusted caller.
 * @returns {Promise<Object>} Persisted masked host profile.
 */
async function createRemoteHost(input = {}) {
  assertRemoteHostsSupported();
  const host = normalizeHostInput(input);
  host.ownerUserId = requireRemoteHostOwnerUserId(host.ownerUserId);
  await resolveRemoteHostRuntimeProfile({
    sshHost: host.sshHost,
    gatewayHost: host.gatewayHost || host.sshHost,
  });
  return withRemoteHostMutationLock(host.id, () => createRemoteHostLocked(host));
}

/**
 * Register a platform-owned host under its mutation lock. A host id retired by
 * a prior deletion is never reused, and a requested default replaces any
 * existing platform default.
 *
 * @param {Object} [input={}] - Remote-host registration fields from a trusted caller.
 * @param {string|null} [createdByUserId=null] - Admin registering the host.
 * @returns {Promise<Object>} Persisted masked host profile.
 */
async function createPlatformRemoteHost(input = {}, createdByUserId = null) {
  assertRemoteHostsSupported();
  const host = normalizeHostInput(input);
  host.ownerUserId = null;
  await resolveRemoteHostRuntimeProfile({
    sshHost: host.sshHost,
    gatewayHost: host.gatewayHost || host.sshHost,
  });
  return withRemoteHostMutationLock(host.id, async () => {
    const result = await db.query(
      `INSERT INTO remote_hosts(
         id, management_scope, owner_user_id, created_by_user_id, available_to_all,
         label, enabled, is_default,
         ssh_host, ssh_port, ssh_user, ssh_auth_mode,
         ssh_private_key_encrypted, ssh_password_encrypted, ssh_passphrase_encrypted,
         gateway_host, docker_host
       )
       SELECT $1, 'platform', NULL, $2, false,
              $3, $4, $5,
              $6, $7, $8, $9,
              $10, $11, $12,
              $13, $14
        WHERE NOT EXISTS (
          SELECT 1 FROM remote_host_id_tombstones WHERE remote_host_id = $1
        )
       RETURNING *`,
      [
        host.id,
        createdByUserId || null,
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
    if (!result.rows[0]) throw createRemoteHostIdRetiredError(host.id);
    if (host.isDefault) {
      await db.query(
        `UPDATE remote_hosts
            SET is_default = false
          WHERE id <> $1
            AND management_scope = 'platform'`,
        [host.id],
      );
    }
    return maskHost(result.rows[0]);
  });
}

async function updateRemoteHostLocked(hostId, input = {}, expectedOwnerUserId) {
  assertRemoteHostsSupported();
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(hostId, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  const host = normalizeHostInput(input, existing);
  // Ownership is immutable. The expected owner comes from the authenticated
  // route, not from a request body that could try to reassign the row.
  host.ownerUserId = ownerUserId;
  const resetTest = connectionInputChanged(existing, host);
  const resetHostKey = sshHostIdentityChanged(existing, host);
  await resolveRemoteHostRuntimeProfile({
    sshHost: host.sshHost,
    gatewayHost: host.gatewayHost || host.sshHost,
  });
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
            -- The host-key pin belongs to the SSH network identity, not to the
            -- credential. Rotating a password/key must retain the pin; only an
            -- explicit SSH host/port change returns to trust-on-first-use.
            ssh_host_key = CASE WHEN $16 THEN NULL ELSE ssh_host_key END,
            updated_at = NOW()
      WHERE id = $1
        AND owner_user_id = $17
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
      resetHostKey,
      ownerUserId,
    ],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  if (host.isDefault) await clearOtherDefaults(existing.id, host.ownerUserId);
  return maskHost(result.rows[0]);
}

/**
 * Update an owner-scoped host under its mutation lock, invalidating the test
 * result for connection changes and the SSH pin only for host identity changes.
 *
 * @param {string} hostId - Remote host to update.
 * @param {Object} [input={}] - Replacement and credential-clear fields.
 * @param {Object} [options={}] - Required expected owner scope.
 * @returns {Promise<Object>} Updated masked host profile.
 */
async function updateRemoteHost(hostId, input = {}, options = {}) {
  assertRemoteHostsSupported();
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    updateRemoteHostLocked(hostId, input, expectedOwnerUserId),
  );
}

async function updatePlatformRemoteHostLocked(hostId, input = {}) {
  assertRemoteHostsSupported();
  const existing = await getPlatformHostRow(hostId);
  if (!existing) throw createPlatformRemoteHostNotFoundError();
  const host = normalizeHostInput(input, existing);
  host.ownerUserId = null;
  const resetTest = connectionInputChanged(existing, host);
  const resetHostKey = sshHostIdentityChanged(existing, host);
  await resolveRemoteHostRuntimeProfile({
    sshHost: host.sshHost,
    gatewayHost: host.gatewayHost || host.sshHost,
  });
  const result = await db.query(
    `UPDATE remote_hosts
        SET label = $2,
            enabled = $3,
            is_default = $4,
            ssh_host = $5,
            ssh_port = $6,
            ssh_user = $7,
            ssh_auth_mode = $8,
            ssh_private_key_encrypted = $9,
            ssh_password_encrypted = $10,
            ssh_passphrase_encrypted = $11,
            gateway_host = $12,
            docker_host = $13,
            last_test_status = CASE WHEN $14 THEN NULL ELSE last_test_status END,
            last_test_message = CASE WHEN $14 THEN NULL ELSE last_test_message END,
            last_tested_at = CASE WHEN $14 THEN NULL ELSE last_tested_at END,
            ssh_host_key = CASE WHEN $15 THEN NULL ELSE ssh_host_key END,
            updated_at = NOW()
      WHERE id = $1
        AND management_scope = 'platform'
      RETURNING *`,
    [
      existing.id,
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
      resetTest,
      resetHostKey,
    ],
  );
  if (!result.rows[0]) throw createPlatformRemoteHostNotFoundError();
  if (host.isDefault) {
    await db.query(
      `UPDATE remote_hosts
          SET is_default = false
        WHERE id <> $1
          AND management_scope = 'platform'`,
      [existing.id],
    );
  }
  return maskHost(result.rows[0]);
}

/**
 * Update a platform-owned host under its mutation lock, invalidating the test
 * result on any connection change and the SSH pin only when host identity changes.
 *
 * @param {string} hostId - Platform remote host to update.
 * @param {Object} [input={}] - Replacement and credential-clear fields.
 * @returns {Promise<Object>} Updated masked host profile.
 */
async function updatePlatformRemoteHost(hostId, input = {}) {
  assertRemoteHostsSupported();
  return withRemoteHostMutationLock(hostId, () => updatePlatformRemoteHostLocked(hostId, input));
}

function assertHostKeyPinResetConfirmation(existing, confirmation) {
  const provided = normalizeText(confirmation);
  const label = normalizeText(existing?.label);
  const id = normalizeHostId(existing?.id || existing?.host_id || label);
  if (provided && (provided === label || provided === id)) return;

  const error = new Error(`Type the remote host label "${label}" or id "${id}" to confirm`);
  error.statusCode = 400;
  error.code = "REMOTE_HOST_PIN_RESET_CONFIRMATION_INVALID";
  throw error;
}

// Explicit recovery for an intentionally rebuilt host at the same SSH address.
// This is deliberately separate from ordinary edits: credentials and network
// identity stay untouched, while clearing the pin also invalidates the previous
// Test result so active use remains fail-closed until a fresh successful probe
// observes and pins the replacement SSH key.
async function resetRemoteHostHostKeyPinLocked(hostId, confirmation, expectedOwnerUserId) {
  assertRemoteHostsSupported();
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(hostId, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  assertHostKeyPinResetConfirmation(existing, confirmation);

  const result = await db.query(
    `UPDATE remote_hosts
        SET ssh_host_key = NULL,
            last_test_status = NULL,
            last_test_message = NULL,
            last_tested_at = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND owner_user_id = $2
      RETURNING *`,
    [existing.id, ownerUserId],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  return maskHost(result.rows[0]);
}

async function resetRemoteHostHostKeyPin(hostId, confirmation, options = {}) {
  assertRemoteHostsSupported();
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    resetRemoteHostHostKeyPinLocked(hostId, confirmation, expectedOwnerUserId),
  );
}

/**
 * Clear a platform host's pinned SSH key after explicit confirmation, for
 * recovering an intentionally rebuilt host at the same SSH address. Credentials
 * and network identity are untouched; clearing the pin also invalidates the
 * prior test result so use stays fail-closed until a fresh probe re-pins.
 *
 * @param {string} hostId - Platform remote host to reset.
 * @param {string} confirmation - Host label or id, required to confirm the reset.
 * @returns {Promise<Object>} Updated masked host profile.
 */
async function resetPlatformRemoteHostHostKeyPin(hostId, confirmation) {
  assertRemoteHostsSupported();
  return withRemoteHostMutationLock(hostId, async () => {
    const existing = await getPlatformHostRow(hostId);
    if (!existing) throw createPlatformRemoteHostNotFoundError();
    assertHostKeyPinResetConfirmation(existing, confirmation);
    const result = await db.query(
      `UPDATE remote_hosts
          SET ssh_host_key = NULL,
              last_test_status = NULL,
              last_test_message = NULL,
              last_tested_at = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND management_scope = 'platform'
        RETURNING *`,
      [existing.id],
    );
    if (!result.rows[0]) throw createPlatformRemoteHostNotFoundError();
    return maskHost(result.rows[0]);
  });
}

async function deleteRemoteHostLocked(hostId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(id, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  const executionTargetId = `remote:${id}`;
  const usage = await db.query(
    "SELECT COUNT(*)::int AS count FROM agents WHERE execution_target_id = $1 AND status IS DISTINCT FROM 'deleted'",
    [executionTargetId],
  );
  if ((usage.rows[0]?.count || 0) > 0) {
    const error = new Error("Cannot delete a remote host while agents still reference it");
    error.statusCode = 409;
    throw error;
  }
  const result = await db.query(
    `WITH retired AS (
       INSERT INTO remote_host_id_tombstones(remote_host_id, management_scope, deleted_by_user_id)
       VALUES($1, 'user', $2)
       ON CONFLICT (remote_host_id) DO NOTHING
       RETURNING remote_host_id
     )
     DELETE FROM remote_hosts
      WHERE id = $1
        AND owner_user_id = $2
        AND EXISTS (SELECT 1 FROM retired)
      RETURNING *`,
    [id, ownerUserId],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  return maskHost(result.rows[0]);
}

/**
 * Delete an owner-scoped host under its mutation lock only when no non-deleted
 * agent still references its execution target.
 *
 * @param {string} hostId - Remote host to delete.
 * @param {Object} [options={}] - Required expected owner scope.
 * @returns {Promise<Object>} Deleted masked host profile.
 */
async function deleteRemoteHost(hostId, options = {}) {
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    deleteRemoteHostLocked(hostId, expectedOwnerUserId),
  );
}

/**
 * Delete a platform-owned host under its mutation lock, refusing while any
 * non-deleted agent still references its execution target. The id is
 * tombstoned so it is never reused by a later registration.
 *
 * @param {string} hostId - Platform remote host to delete.
 * @param {Object} [options={}] - Deleting-admin attribution.
 * @returns {Promise<Object>} Deleted masked host profile.
 */
async function deletePlatformRemoteHost(hostId, options = {}) {
  assertRemoteHostsSupported();
  return withRemoteHostMutationLock(hostId, async () => {
    const id = normalizeHostId(hostId);
    const existing = await getPlatformHostRow(id);
    if (!existing) throw createPlatformRemoteHostNotFoundError();
    const usage = await db.query(
      "SELECT COUNT(*)::int AS count FROM agents WHERE execution_target_id = $1 AND status IS DISTINCT FROM 'deleted'",
      [`remote:${id}`],
    );
    if ((usage.rows[0]?.count || 0) > 0) {
      const error = new Error("Cannot delete a remote host while agents still reference it");
      error.statusCode = 409;
      error.code = "REMOTE_HOST_IN_USE";
      throw error;
    }
    const result = await db.query(
      `WITH retired AS (
         INSERT INTO remote_host_id_tombstones(remote_host_id, management_scope, deleted_by_user_id)
         VALUES($1, 'platform', $2)
         ON CONFLICT (remote_host_id) DO NOTHING
         RETURNING remote_host_id
       )
       DELETE FROM remote_hosts
        WHERE id = $1
          AND management_scope = 'platform'
          AND EXISTS (SELECT 1 FROM retired)
        RETURNING *`,
      [id, options.deletedByUserId || null],
    );
    if (!result.rows[0]) throw createPlatformRemoteHostNotFoundError();
    return maskHost(result.rows[0]);
  });
}

// SSH connectivity verification

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

/**
 * Probe Docker over SSH while enforcing any pinned host key and capturing a first-use key.
 * Expected connection and command failures resolve as structured results for persistence.
 *
 * @param {Object} profile - Secret-bearing remote-host profile.
 * @param {Object} [options={}] - Probe timeout options.
 * @returns {Promise<Object>} Probe status, message, and optional presented host key.
 */
function runRemoteDockerProbe(profile, { timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const Client = getSshClientCtor();
    const conn = new Client();
    let settled = false;
    // Capture the presented host key (base64) and detect a mismatch vs the pin.
    const expectedHostKey = normalizeText(profile.sshHostKey);
    let capturedHostKey = null;
    let hostKeyMismatch = false;
    const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TEST_TIMEOUT_MS);
    let probeTimer = null;
    const onHostKey = (presented) => {
      capturedHostKey = presented;
      if (expectedHostKey && presented !== expectedHostKey) hostKeyMismatch = true;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (probeTimer) clearTimeout(probeTimer);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    probeTimer = setTimeout(() => {
      finish({
        ok: false,
        message: `Remote Docker probe timed out after ${boundedTimeoutMs}ms.`,
      });
    }, boundedTimeoutMs);
    probeTimer.unref?.();

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
            "man-in-the-middle, or the host was rebuilt). Use the explicit host-key pin reset only after independently verifying an expected rebuild or key rotation.",
        });
        return;
      }
      finish({ ok: false, message: err?.message || "SSH connection failed." });
    });

    try {
      conn.connect(buildSshConnectConfig(profile, boundedTimeoutMs, { onHostKey }));
    } catch (err) {
      finish({ ok: false, message: err?.message || "SSH connection could not be started." });
    }
  });
}

async function testRemoteHostLocked(hostId, options = {}) {
  assertRemoteHostsSupported();
  const ownerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  const row = await getOwnedHostRow(hostId, ownerUserId);
  if (!row) throw createRemoteHostNotFoundError();
  const profile = await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
  let status = "ok";
  let message = "Docker is reachable over SSH.";
  let pinHostKey = null;
  if (!profile.configured) {
    status = "failed";
    message = profile.issue || "Remote host is not configured.";
  } else {
    const probe = await runRemoteDockerProbe(profile, options);
    const presentedHostKey = normalizeText(probe.hostKey);
    status = probe.ok && presentedHostKey ? "ok" : "failed";
    message =
      probe.ok && !presentedHostKey
        ? "SSH connected, but Nora could not verify and pin the presented host key; the host remains unavailable."
        : probe.message;
    // Trust-on-first-use: pin the host key on the first successful test. Once
    // pinned it's never overwritten here — a changed key fails the probe above
    // (hostKeyMismatch), so re-pinning requires the explicit reset flow.
    if (status === "ok" && !normalizeText(profile.sshHostKey)) {
      pinHostKey = presentedHostKey;
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
        AND owner_user_id = $5
      RETURNING *`,
    [profile.id, status, message, pinHostKey, ownerUserId],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  return maskHost(result.rows[0]);
}

/**
 * Test an owner-scoped host under its mutation lock, persist the result, and
 * pin its SSH host key on first success.
 *
 * @param {string} hostId - Remote host to test.
 * @param {Object} [options={}] - Required owner scope and SSH probe options.
 * @returns {Promise<Object>} Updated masked host profile with the stored result.
 */
async function testRemoteHost(hostId, options = {}) {
  assertRemoteHostsSupported();
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    testRemoteHostLocked(hostId, { ...options, expectedOwnerUserId }),
  );
}

/**
 * Test a platform-owned host under its mutation lock, persist the result, and
 * pin its SSH host key on first success.
 *
 * @param {string} hostId - Platform remote host to test.
 * @param {Object} [options={}] - SSH probe timeout options.
 * @returns {Promise<Object>} Updated masked host profile with the stored result.
 */
async function testPlatformRemoteHost(hostId, options = {}) {
  assertRemoteHostsSupported();
  return withRemoteHostMutationLock(hostId, async () => {
    const row = await getPlatformHostRow(hostId);
    if (!row) throw createPlatformRemoteHostNotFoundError();
    const profile = await resolveRemoteHostRuntimeProfile(
      rowToProfile(row, { includeSecret: true }),
    );
    let status = "ok";
    let message = "Docker is reachable over SSH.";
    let pinHostKey = null;
    if (!profile.configured) {
      status = "failed";
      message = profile.issue || "Remote host is not configured.";
    } else {
      const probe = await runRemoteDockerProbe(profile, options);
      const presentedHostKey = normalizeText(probe.hostKey);
      status = probe.ok && presentedHostKey ? "ok" : "failed";
      message =
        probe.ok && !presentedHostKey
          ? "SSH connected, but Nora could not verify and pin the presented host key; the host remains unavailable."
          : probe.message;
      if (status === "ok" && !normalizeText(profile.sshHostKey)) pinHostKey = presentedHostKey;
    }
    const result = await db.query(
      `UPDATE remote_hosts
          SET last_test_status = $2,
              last_test_message = $3,
              ssh_host_key = COALESCE(ssh_host_key, $4),
              last_tested_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND management_scope = 'platform'
        RETURNING *`,
      [profile.id, status, message, pinHostKey],
    );
    if (!result.rows[0]) throw createPlatformRemoteHostNotFoundError();
    return maskHost(result.rows[0]);
  });
}

// Workspace grants and deployment eligibility — the deploy-path gate below
// mirrors assertKubernetesExecutionTargetAvailable.

// Workspace roles (editor and above) that may USE a shared remote host — deploy
// agents to it and reach them through the gateway. Mirrors WORKSPACE_ROLE_RANK in
// middleware/ownership.ts (viewer:0, editor:1, admin:2, owner:3). Viewer can see a
// shared host (visibility) but not deploy to it. Host config stays owner-only.
const HOST_USE_ROLES = Object.freeze(["editor", "admin", "owner"]);

// Return the exact registry row authorized by the same PostgreSQL statement.
// This prevents an id from being deleted/recreated between checking a grant and
// loading/decrypting the profile for a different tenant's replacement row.
async function getAuthorizedRemoteHostRow(userId, hostId) {
  if (!userId || !hostId) return null;
  try {
    const result = await db.query(
      `SELECT rh.*
         FROM remote_hosts rh
        WHERE rh.id = $1
          AND (
            (
              rh.management_scope = 'user'
              AND (
                rh.owner_user_id = $2
                OR EXISTS (
                  SELECT 1
                    FROM workspace_remote_hosts wrh
                    JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
                   WHERE wrh.remote_host_id = rh.id
                     AND wm.user_id = $2
                     AND wm.role = ANY($3)
                )
              )
            )
            OR (
              rh.management_scope = 'platform'
              AND (
                rh.available_to_all = true
                OR EXISTS (
                  SELECT 1 FROM users actor
                   WHERE actor.id = $2
                     AND actor.role = 'admin'
                )
                OR EXISTS (
                  SELECT 1
                    FROM remote_host_user_grants uhg
                   WHERE uhg.remote_host_id = rh.id
                     AND uhg.user_id = $2
                )
                OR EXISTS (
                  SELECT 1
                    FROM remote_host_group_grants ghg
                    JOIN user_group_members ugm ON ugm.group_id = ghg.group_id
                   WHERE ghg.remote_host_id = rh.id
                     AND ugm.user_id = $2
                )
                OR EXISTS (
                  SELECT 1
                    FROM workspace_remote_hosts wrh
                    JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
                   WHERE wrh.remote_host_id = rh.id
                     AND wm.user_id = $2
                     AND wm.role = ANY($3)
                )
              )
            )
          )
        LIMIT 1`,
      [hostId, userId, HOST_USE_ROLES],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (!["42P01", "42703"].includes(error?.code)) throw error;
    // During a rolling migration, platform grants do not exist yet. Keep only
    // the pre-migration user-owner/workspace semantics, still from one row
    // snapshot, and fail closed for every new grant kind.
    try {
      const legacy = await db.query(
        `SELECT rh.*
           FROM remote_hosts rh
          WHERE rh.id = $1
            AND (
              rh.owner_user_id = $2
              OR EXISTS (
                SELECT 1
                  FROM workspace_remote_hosts wrh
                  JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
                 WHERE wrh.remote_host_id = rh.id
                   AND wm.user_id = $2
                   AND wm.role = ANY($3)
              )
            )
          LIMIT 1`,
        [hostId, userId, HOST_USE_ROLES],
      );
      return legacy.rows[0] || null;
    } catch (legacyError) {
      if (legacyError?.code !== "42P01") throw legacyError;
      const owned = await db.query(
        "SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2",
        [hostId, userId],
      );
      return owned.rows[0] || null;
    }
  }
}

/**
 * Check whether a user owns a host or has an editor-or-higher workspace grant to use it.
 * Missing grant tables fail closed for shared access.
 *
 * @param {string} userId - User requesting deployment or gateway reachability.
 * @param {string} hostId - Remote host being used.
 * @returns {Promise<boolean>} Whether an explicit qualifying grant exists.
 */
async function userCanUseRemoteHost(userId, hostId) {
  if (!userId || !hostId) return false;
  return Boolean(await getAuthorizedRemoteHostRow(userId, hostId));
}

// Active Remote Docker operations must re-check the CURRENT positive grant.
// Agent ownership is intentionally separate from host ownership: keeping an
// agent row after a workspace share is removed must not let Nora keep using the
// former host owner's decrypted SSH/Docker credentials as a confused deputy.
// Stop/destroy cleanup paths bypass this guard explicitly in containerManager;
// all normal runtime access, queued work, proxying, and backups call it.
async function assertRemoteHostAgentUse(agent = {}, options = {}) {
  if (!isRemoteDockerAgent(agent)) return null;
  try {
    if (isPaaSMode()) throw createRemoteHostAccessRevokedError();
    const executionTargetId = normalizeRemoteExecutionTargetId(
      agent.execution_target_id || agent.executionTargetId,
    );
    const userId = agent.user_id || agent.userId || agent.ownerUserId || null;
    if (!executionTargetId || !userId) {
      throw createRemoteHostAccessRevokedError();
    }

    const hostId = executionTargetId.slice("remote:".length);
    const row = await getAuthorizedRemoteHostRow(userId, hostId);
    if (!row) throw createRemoteHostAccessRevokedError();
    const host = await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: false }));
    if (!host.connected) throw createRemoteHostRetestRequiredError(host);

    if (options.includeProfile === false) return host;

    // Decrypt the SAME owner/grant-verified row; never reload by global id.
    return await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
  } catch (error) {
    throw toPublicRemoteHostAuthorizationError(error);
  }
}

function isRemoteHostAccessRevokedError(error) {
  return error?.code === "REMOTE_HOST_ACCESS_REVOKED";
}

/**
 * List masked hosts a user owns or can see through workspace sharing.
 * Shared entries include whether the user's highest workspace role permits deployment.
 *
 * @param {string} userId - User whose accessible hosts should be listed.
 * @returns {Promise<Array>} Owned and shared profiles annotated with access rights.
 */
async function listAccessibleRemoteHosts(userId) {
  if (isPaaSMode()) return [];
  if (!userId) return [];
  try {
    const result = await db.query(
      `WITH actor AS (
         SELECT EXISTS (
           SELECT 1 FROM users WHERE id = $1 AND role = 'admin'
         ) AS is_admin
       ), workspace_access AS (
         SELECT wrh.remote_host_id,
                BOOL_OR(wm.role = ANY($2)) AS can_deploy
           FROM workspace_remote_hosts wrh
           JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
          WHERE wm.user_id = $1
          GROUP BY wrh.remote_host_id
       ), direct_access AS (
         SELECT remote_host_id
           FROM remote_host_user_grants
          WHERE user_id = $1
       ), group_access AS (
         SELECT DISTINCT ghg.remote_host_id
           FROM remote_host_group_grants ghg
           JOIN user_group_members ugm ON ugm.group_id = ghg.group_id
          WHERE ugm.user_id = $1
       )
       SELECT rh.*,
              CASE
                WHEN rh.management_scope = 'user' AND rh.owner_user_id = $1 THEN 'owned'
                WHEN rh.management_scope = 'platform' AND actor.is_admin THEN 'platform_admin'
                WHEN rh.management_scope = 'platform' AND rh.available_to_all THEN 'global'
                WHEN rh.management_scope = 'platform' AND direct_access.remote_host_id IS NOT NULL THEN 'direct'
                WHEN rh.management_scope = 'platform' AND group_access.remote_host_id IS NOT NULL THEN 'group'
                ELSE 'shared'
              END AS __access,
              CASE
                WHEN rh.management_scope = 'user' AND rh.owner_user_id = $1 THEN true
                WHEN rh.management_scope = 'platform' AND (
                  actor.is_admin
                  OR rh.available_to_all
                  OR direct_access.remote_host_id IS NOT NULL
                  OR group_access.remote_host_id IS NOT NULL
                ) THEN true
                ELSE COALESCE(workspace_access.can_deploy, false)
              END AS __can_deploy
         FROM remote_hosts rh
         CROSS JOIN actor
         LEFT JOIN workspace_access ON workspace_access.remote_host_id = rh.id
         LEFT JOIN direct_access ON direct_access.remote_host_id = rh.id
         LEFT JOIN group_access ON group_access.remote_host_id = rh.id
        WHERE (
          rh.management_scope = 'user'
          AND (rh.owner_user_id = $1 OR workspace_access.remote_host_id IS NOT NULL)
        ) OR (
          rh.management_scope = 'platform'
          AND (
            actor.is_admin
            OR rh.available_to_all
            OR direct_access.remote_host_id IS NOT NULL
            OR group_access.remote_host_id IS NOT NULL
            OR workspace_access.remote_host_id IS NOT NULL
          )
        )
        ORDER BY rh.is_default DESC, LOWER(rh.label), rh.id`,
      [userId, HOST_USE_ROLES],
    );
    return result.rows.map((row) => ({
      ...maskHost(row),
      access: row.__access,
      canDeploy: row.__can_deploy === true,
    }));
  } catch (error) {
    if (!["42P01", "42703"].includes(error?.code)) throw error;
  }

  // Rolling-upgrade fallback: only the established user-owner/workspace model
  // is visible until every platform grant table and scope column exists.
  const owned = (await listRemoteHosts({ ownerUserId: userId, includeDisabled: true })).map(
    (host) => ({ ...host, access: "owned", canDeploy: true }),
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
      if (!host || host.managementScope !== "user") continue;
      shared.push({ ...host, access: "shared", canDeploy: Number(row.rank) >= 1 });
    }
  } catch (error) {
    if (error?.code !== "42P01") throw error;
  }
  return [...owned, ...shared];
}

// Share a host into a workspace (idempotent). Both host ownership and current
// workspace membership are rechecked inside the per-host lock by the same SQL
// statement that creates the grant.
async function shareRemoteHostLocked(hostId, workspaceId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(id, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  const result = await db.query(
    `WITH authorized AS (
       SELECT rh.id AS remote_host_id,
              wm.workspace_id,
              w.name AS workspace_name
         FROM remote_hosts rh
         JOIN workspace_members wm
           ON wm.workspace_id = $1
          AND wm.user_id = $3
         JOIN workspaces w ON w.id = wm.workspace_id
        WHERE rh.id = $2
          AND rh.owner_user_id = $3
     ), inserted AS (
       INSERT INTO workspace_remote_hosts (workspace_id, remote_host_id, created_by)
       SELECT workspace_id, remote_host_id, $3
         FROM authorized
        WHERE TRUE
       ON CONFLICT (workspace_id, remote_host_id) DO NOTHING
       RETURNING workspace_id
     )
     SELECT authorized.workspace_id AS "workspaceId",
            authorized.workspace_name AS "workspaceName",
            EXISTS (SELECT 1 FROM inserted) AS "inserted"
       FROM authorized`,
    [workspaceId, id, ownerUserId],
  );
  if (!result.rows[0]) {
    const error = new Error("Workspace not found");
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

/**
 * Idempotently share an owner-scoped host after atomically rechecking current
 * host ownership and workspace membership under the per-host lock.
 *
 * @param {string} hostId - Remote host to share.
 * @param {string} workspaceId - Workspace receiving visibility and role-based use.
 * @param {string} expectedOwnerUserId - Expected host owner and current workspace member.
 * @returns {Promise<Object>} Workspace metadata and whether a new grant was inserted.
 */
async function shareRemoteHost(hostId, workspaceId, expectedOwnerUserId) {
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    shareRemoteHostLocked(hostId, workspaceId, ownerUserId),
  );
}

async function unshareRemoteHostLocked(hostId, workspaceId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(id, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  await db.query(
    `DELETE FROM workspace_remote_hosts wrh
      USING remote_hosts rh
      WHERE wrh.remote_host_id = $1
        AND wrh.workspace_id = $2
        AND rh.id = wrh.remote_host_id
        AND rh.owner_user_id = $3`,
    [id, workspaceId, ownerUserId],
  );
}

async function unshareRemoteHost(hostId, workspaceId, expectedOwnerUserId) {
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    unshareRemoteHostLocked(hostId, workspaceId, ownerUserId),
  );
}

async function listRemoteHostShares(hostId, options = {}) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  try {
    const rows = await db.query(
      `SELECT wrh.workspace_id AS "workspaceId", w.name AS "workspaceName", wrh.created_at AS "createdAt"
         FROM workspace_remote_hosts wrh
         JOIN workspaces w ON w.id = wrh.workspace_id
         JOIN remote_hosts rh ON rh.id = wrh.remote_host_id
        WHERE wrh.remote_host_id = $1
          AND rh.owner_user_id = $2
        ORDER BY w.name`,
      [id, ownerUserId],
    );
    return rows.rows;
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

/**
 * Normalize a requested grant list, accepting raw id strings or objects
 * carrying the id under any of `keys`.
 *
 * @param {Array|undefined|null} value - Requested grant entries; `undefined`/`null` means none.
 * @param {string} fieldName - Field name used in validation error messages.
 * @param {Array<string>} keys - Object keys checked, in order, for the id.
 * @returns {Array<string>} Deduplicated, lowercased grant ids.
 */
function normalizeGrantIds(value, fieldName, keys) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    const error = new Error(`${fieldName} must be an array`);
    error.statusCode = 400;
    throw error;
  }
  const ids = value.map((entry) => {
    let raw = entry;
    if (entry && typeof entry === "object") {
      raw = keys.map((key) => entry[key]).find((candidate) => candidate != null);
    }
    const id = normalizeText(raw).toLowerCase();
    if (!UUID_RE.test(id)) {
      const error = new Error(`${fieldName} must contain valid ids`);
      error.statusCode = 400;
      throw error;
    }
    return id;
  });
  return [...new Set(ids)];
}

async function readPlatformRemoteHostAccess(queryable, host) {
  const id = normalizeHostId(host.id);
  const users = await queryable.query(
    `SELECT u.id AS "userId", u.email, u.name
         FROM remote_host_user_grants grant_row
         JOIN users u ON u.id = grant_row.user_id
        WHERE grant_row.remote_host_id = $1
        ORDER BY LOWER(u.email), u.id`,
    [id],
  );
  const groups = await queryable.query(
    `SELECT ug.id AS "groupId", ug.name
         FROM remote_host_group_grants grant_row
         JOIN user_groups ug ON ug.id = grant_row.group_id
        WHERE grant_row.remote_host_id = $1
        ORDER BY LOWER(ug.name), ug.id`,
    [id],
  );
  const workspaces = await queryable.query(
    `SELECT w.id AS "workspaceId", w.name
         FROM workspace_remote_hosts grant_row
         JOIN workspaces w ON w.id = grant_row.workspace_id
        WHERE grant_row.remote_host_id = $1
        ORDER BY LOWER(w.name), w.id`,
    [id],
  );
  return {
    version: Number(host.access_version || 1),
    availableToAll: host.available_to_all === true,
    users: users.rows.map((row) => ({
      userId: row.userId ?? row.user_id,
      email: row.email || "",
      name: row.name || null,
    })),
    groups: groups.rows.map((row) => ({
      groupId: row.groupId ?? row.group_id,
      name: row.name,
    })),
    workspaces: workspaces.rows.map((row) => ({
      workspaceId: row.workspaceId ?? row.workspace_id,
      name: row.name,
    })),
  };
}

/**
 * Read a platform host's current access grants from a consistent snapshot,
 * alongside the access version callers must echo back to
 * `replacePlatformRemoteHostAccess`.
 *
 * @param {string} hostId - Platform remote host to read.
 * @returns {Promise<Object>} Access version, `availableToAll`, and granted users/groups/workspaces.
 */
async function listPlatformRemoteHostAccess(hostId) {
  const id = normalizeHostId(hostId);
  const client = await db.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const host = await getPlatformHostRow(id, client);
    if (!host) throw createPlatformRemoteHostNotFoundError();
    const access = await readPlatformRemoteHostAccess(client, host);
    await client.query("COMMIT");
    transactionOpen = false;
    return access;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function normalizeExpectedVersion(value, label) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    const error = new Error(`${label} expectedVersion is required`);
    error.statusCode = 400;
    error.code = "EXPECTED_VERSION_REQUIRED";
    throw error;
  }
  return version;
}

async function validateGrantIds(client, table, ids, fieldName) {
  if (ids.length === 0) return;
  const result = await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  const found = new Set(result.rows.map((row) => String(row.id).toLowerCase()));
  const missing = ids.find((id) => !found.has(id));
  if (!missing) return;
  const error = new Error(`Unknown ${fieldName} id: ${missing}`);
  error.statusCode = 400;
  error.code = "REMOTE_HOST_ACCESS_PRINCIPAL_NOT_FOUND";
  throw error;
}

/**
 * Replace a platform host's entire set of access grants under optimistic
 * concurrency; this is a full replace, not a merge. Fails with a
 * version-conflict 409 when `expectedVersion` no longer matches the persisted
 * access version. All referenced users, groups, and workspaces must already exist.
 *
 * @param {string} hostId - Platform remote host whose access should be replaced.
 * @param {Object} [input={}] - Complete desired grants and `availableToAll` flag.
 * @param {string|null} [createdByUserId=null] - Admin performing the replacement.
 * @returns {Promise<Object>} Updated access version and granted users/groups/workspaces.
 */
async function replacePlatformRemoteHostAccess(hostId, input = {}, createdByUserId = null) {
  assertRemoteHostsSupported();
  const id = normalizeHostId(hostId);
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion, "Remote host access");
  const userIds = normalizeGrantIds(input.users, "users", ["userId", "user_id", "id"]);
  const groupIds = normalizeGrantIds(input.groups, "groups", ["groupId", "group_id", "id"]);
  const workspaceIds = normalizeGrantIds(input.workspaces, "workspaces", [
    "workspaceId",
    "workspace_id",
    "id",
  ]);
  const availableToAll = normalizeBool(input.availableToAll ?? input.available_to_all, false);

  return withRemoteHostMutationLock(id, async () => {
    const client = await db.connect();
    let transactionOpen = false;
    let access = null;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const host = await getPlatformHostRow(id, client, { forUpdate: true });
      if (!host) throw createPlatformRemoteHostNotFoundError();
      if (Number(host.access_version || 1) !== expectedVersion) {
        const error = new Error(
          "Remote host access changed since it was loaded; refresh and try again",
        );
        error.statusCode = 409;
        error.code = "REMOTE_HOST_ACCESS_VERSION_CONFLICT";
        throw error;
      }

      await validateGrantIds(client, "users", userIds, "user");
      await validateGrantIds(client, "user_groups", groupIds, "group");
      await validateGrantIds(client, "workspaces", workspaceIds, "workspace");

      const updated = await client.query(
        `UPDATE remote_hosts
            SET available_to_all = $2,
                access_version = access_version + 1,
                updated_at = NOW()
          WHERE id = $1
            AND management_scope = 'platform'
            AND access_version = $3
        RETURNING *`,
        [id, availableToAll, expectedVersion],
      );
      if (!updated.rows[0]) {
        const error = new Error(
          "Remote host access changed since it was loaded; refresh and try again",
        );
        error.statusCode = 409;
        error.code = "REMOTE_HOST_ACCESS_VERSION_CONFLICT";
        throw error;
      }
      await client.query("DELETE FROM remote_host_user_grants WHERE remote_host_id = $1", [id]);
      await client.query("DELETE FROM remote_host_group_grants WHERE remote_host_id = $1", [id]);
      await client.query("DELETE FROM workspace_remote_hosts WHERE remote_host_id = $1", [id]);

      if (userIds.length > 0) {
        await client.query(
          `INSERT INTO remote_host_user_grants(remote_host_id, user_id, created_by_user_id)
           SELECT $1, ids.grant_id, $3
             FROM UNNEST($2::uuid[]) AS ids(grant_id)`,
          [id, userIds, createdByUserId || null],
        );
      }
      if (groupIds.length > 0) {
        await client.query(
          `INSERT INTO remote_host_group_grants(remote_host_id, group_id, created_by_user_id)
           SELECT $1, ids.grant_id, $3
             FROM UNNEST($2::uuid[]) AS ids(grant_id)`,
          [id, groupIds, createdByUserId || null],
        );
      }
      if (workspaceIds.length > 0) {
        await client.query(
          `INSERT INTO workspace_remote_hosts(workspace_id, remote_host_id, created_by)
           SELECT ids.grant_id, $1, $3
             FROM UNNEST($2::uuid[]) AS ids(grant_id)`,
          [id, workspaceIds, createdByUserId || null],
        );
      }
      access = await readPlatformRemoteHostAccess(client, updated.rows[0]);
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return access;
  });
}

/**
 * Validate a remote-docker target before deployment and return its secret-bearing profile.
 * When an owner id is supplied, unowned and ungranted hosts are reported as unknown.
 *
 * @param {Object} [runtimeFields={}] - Runtime selection containing the remote execution target.
 * @param {Object} [options={}] - Optional owner scope for cross-tenant authorization.
 * @returns {Promise<Object|null>} Available provisioning profile, or `null` for other targets.
 */
async function assertRemoteHostExecutionTargetAvailable(runtimeFields = {}, options = {}) {
  if (!isRemoteDockerTarget(runtimeFields.deploy_target ?? runtimeFields.deployTarget)) {
    return null;
  }
  assertRemoteHostsSupported();
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
  const hostId = executionTargetId.slice("remote:".length);
  const ownerUserId = options.ownerUserId || null;
  // When a user owns the deployment, authorize and return the host row in one
  // statement. The admin path has no tenant owner and uses the direct row.
  const row = ownerUserId
    ? await getAuthorizedRemoteHostRow(ownerUserId, hostId)
    : await getHostRow(hostId);
  const host = row ? rowToProfile(row, { includeSecret: false }) : null;
  if (!host) {
    const error = new Error(`Unknown remote host execution target: ${executionTargetId}`);
    error.statusCode = 400;
    throw error;
  }
  if (!host.enabled) {
    const error = new Error(`${host.label} is disabled for new deployments.`);
    error.statusCode = 400;
    throw error;
  }
  if (!host.configured) {
    const error = new Error(host.issue || `${host.label} is not configured.`);
    error.statusCode = 400;
    throw error;
  }
  if (!host.connected) {
    const error = new Error(
      host.issue || `${host.label} must pass the connection test before deployment.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
}

module.exports = {
  assertRemoteHostAgentUse,
  assertRemoteHostExecutionTargetAvailable,
  assertRemoteHostsSupported,
  createPlatformRemoteHost,
  createRemoteHost,
  deletePlatformRemoteHost,
  deleteRemoteHost,
  getAdminRemoteHost,
  getRemoteHost,
  getRemoteHostByExecutionTarget,
  getRemoteHostCleanupProfile,
  getRemoteHostProfile,
  isRemoteDockerTarget,
  isRemoteDockerAgent,
  isRemoteHostAccessRevokedError,
  listAdminRemoteHosts,
  listRemoteHosts,
  listAccessibleRemoteHosts,
  listPlatformRemoteHostAccess,
  listRemoteHostExecutionTargets,
  normalizeRemoteExecutionTargetId,
  resolveRemoteAddressForRuntime,
  resolveRemoteHostRuntimeProfile,
  replacePlatformRemoteHostAccess,
  resetPlatformRemoteHostHostKeyPin,
  resetRemoteHostHostKeyPin,
  rowToProfile,
  testPlatformRemoteHost,
  testRemoteHost,
  toPublicRemoteHostAuthorizationError,
  updatePlatformRemoteHost,
  updateRemoteHost,
  userCanUseRemoteHost,
  shareRemoteHost,
  unshareRemoteHost,
  listRemoteHostShares,
};
