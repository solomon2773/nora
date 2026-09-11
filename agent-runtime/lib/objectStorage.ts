// @ts-nocheck
// Shared object-storage primitives used by backend-api (managed backups) and
// worker-provisioner (log retention, once that lands). This module is
// deliberately DB- and HTTP-agnostic: every function takes its storage
// config as an explicit parameter and throws a plain StorageError (never an
// HTTP-shaped error) so it works the same inside a background worker as it
// does behind an Express route.
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

// `agent-runtime/` is mounted read-only into backend-api and worker-provisioner
// (see CLAUDE.md's "Shared runtime contracts") and has no node_modules of its
// own — every other file here sticks to Node builtins for exactly that reason.
// ssh2 is a real third-party dependency of both consuming services, but
// Node's module resolution walks up from *this* file's directory
// (/agent-runtime/lib in both containers), which is not an ancestor of
// either service's node_modules. Resolve it lazily, falling back to the
// consuming service's own node_modules (always at `${process.cwd()}/node_modules`
// in every supported run mode: Docker WORKDIR=/app, or host `npm start`/`npm test`
// run from that service's own directory) so only SSH-backend usage — not
// module load — depends on this working.
let cachedSshClient = null;
function loadSshClient() {
  if (cachedSshClient) return cachedSshClient;
  try {
    cachedSshClient = require("ssh2").Client;
  } catch (error) {
    const resolved = require.resolve("ssh2", {
      paths: [path.join(process.cwd(), "node_modules")],
    });
    cachedSshClient = require(resolved).Client;
  }
  return cachedSshClient;
}


/**
 * Backend-neutral storage failure. Callers that need HTTP semantics (e.g.
 * backend-api's backups module) translate `code` into their own status
 * codes rather than relying on this error carrying one.
 */
class StorageError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

function throwIfAborted(signal, where = "operation") {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error(`${where} aborted`);
    if (!reason.statusCode) reason.statusCode = 499;
    throw reason;
  }
}

/**
 * Normalize a raw storage settings object (whatever field names the caller
 * happens to use — legacy backup-flavored `s3Bucket`/`s3Region`/... or the
 * canonical `bucket`/`region`/...) into the canonical shape every function
 * in this module expects. Idempotent: normalizing an already-normalized
 * config is a no-op.
 *
 * @param {Object} [raw={}] - Storage settings in either naming convention.
 * @returns {Object} Canonical storage config.
 */
function normalizeStorageConfig(raw = {}) {
  return {
    storageBackend: raw.storageBackend || "local",
    localPath: raw.localPath || "",
    bucket: raw.bucket || raw.s3Bucket || "",
    region: raw.region || raw.s3Region || "",
    endpoint: raw.endpoint || raw.s3Endpoint || "",
    accessKeyId: raw.accessKeyId || raw.s3AccessKeyId || "",
    secretAccessKey: raw.secretAccessKey || raw.s3SecretAccessKey || "",
    sessionToken: raw.sessionToken || raw.s3SessionToken || "",
    sshHost: raw.sshHost || "",
    sshPort: raw.sshPort || 22,
    sshUsername: raw.sshUsername || "",
    sshPrivateKey: raw.sshPrivateKey || "",
    sshPassword: raw.sshPassword || "",
    sshRemotePath: raw.sshRemotePath || "",
  };
}

// Local filesystem storage

function assertLocalStoragePath(storageKey, config = {}) {
  const root = path.resolve(config.localPath || "/var/lib/nora-backups");
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new StorageError("Invalid storage key", "STORAGE_INVALID_KEY");
  }
  return resolved;
}

function localStorageRoot(config = {}) {
  return path.resolve(config.localPath || "/var/lib/nora-backups");
}

async function putLocalObject(storageKey, buffer, config = {}, { signal } = {}) {
  throwIfAborted(signal, "storage write");
  const target = assertLocalStoragePath(storageKey, config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { mode: 0o600, signal });
}

async function getLocalObject(storageKey, config = {}, { signal } = {}) {
  throwIfAborted(signal, "storage read");
  return fs.readFile(assertLocalStoragePath(storageKey, config), { signal });
}

async function deleteLocalObject(storageKey, config = {}, { signal } = {}) {
  throwIfAborted(signal, "storage delete");
  try {
    await fs.unlink(assertLocalStoragePath(storageKey, config));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * Recursively walk the local storage root, returning every object whose
 * posix-style relative key starts with `prefix`.
 */
async function listLocalObjects(prefix, config = {}, { signal } = {}) {
  throwIfAborted(signal, "storage list");
  const root = localStorageRoot(config);
  const results = [];

  async function walk(directory) {
    throwIfAborted(signal, "storage list");
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = path.relative(root, fullPath).split(path.sep).join("/");
      if (prefix && !key.startsWith(prefix)) continue;
      const stat = await fs.stat(fullPath);
      results.push({ key, size: stat.size, lastModified: stat.mtime });
    }
  }

  await walk(root);
  results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return results;
}

/**
 * Delete each of `keys` individually, collecting per-key failures instead
 * of aborting the whole batch on the first error.
 */
async function deleteLocalObjects(keys, config = {}, { signal } = {}) {
  let deleted = 0;
  const errors = [];
  for (const key of keys) {
    try {
      await deleteLocalObject(key, config, { signal });
      deleted += 1;
    } catch (error) {
      errors.push({ key, message: error?.message || String(error) });
    }
  }
  return { deleted, errors };
}

// S3-compatible storage (also covers Cloudflare R2)

function hmac(key, value, encoding = null) {
  const digest = crypto.createHmac("sha256", key).update(value, "utf8");
  return encoding ? digest.digest(encoding) : digest.digest();
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function s3Config(config = {}) {
  const bucket = config.bucket;
  const region =
    config.storageBackend === "r2" && (!config.region || config.region === "us-east-1")
      ? "auto"
      : config.region || "us-east-1";
  const accessKeyId = config.accessKeyId;
  const secretAccessKey = config.secretAccessKey;
  const sessionToken = config.sessionToken;
  const endpoint = String(config.endpoint || "").replace(/\/+$/, "");
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new StorageError("S3 storage is not fully configured", "STORAGE_S3_NOT_CONFIGURED");
  }
  return { bucket, region, accessKeyId, secretAccessKey, sessionToken, endpoint };
}

function encodeS3Key(key) {
  return String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Build an AWS-compliant canonical query string: percent-encode every key
 * and value, then sort by key. This must match exactly what is sent on the
 * wire, or SigV4 verification fails — see s3Request's `query` handling.
 */
function canonicalQueryString(query = {}) {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key] ?? "")}`)
    .join("&");
}

/**
 * Sign and send a single S3-compatible request. `query` is a plain object
 * of query-string parameters (e.g. `{ "list-type": "2", prefix: "logs/" }`)
 * — passing it here (rather than a caller-built string) guarantees the
 * canonical query string used for the signature exactly matches the one
 * sent on the wire. `headers` lets callers add request headers (e.g.
 * `content-md5` for batch delete) that also get folded into the signature.
 */
async function s3Request(
  method,
  storageKey,
  body = null,
  rawConfig = {},
  { signal, query = null, headers: extraHeaders = {}, dispatcher = undefined } = {},
) {
  throwIfAborted(signal, "S3 request");
  const config = s3Config(rawConfig);
  const payload = body || Buffer.alloc(0);
  const encodedKey = storageKey ? encodeS3Key(storageKey) : "";
  const pathStyle = Boolean(config.endpoint);
  const baseUrl = config.endpoint || `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  const parsedBase = new URL(baseUrl);
  const canonicalUri = pathStyle
    ? `/${config.bucket}${encodedKey ? `/${encodedKey}` : "/"}`
    : `/${encodedKey}`;
  const queryString = query ? canonicalQueryString(query) : "";
  const url = new URL(canonicalUri + (queryString ? `?${queryString}` : ""), baseUrl);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers = {
    host: parsedBase.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  if ((method === "PUT" || method === "POST") && !headers["content-type"]) {
    headers["content-type"] = "application/octet-stream";
  }

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method,
    headers,
    signal,
    // Phase 6 (logging control plane): search/export fetch candidate
    // segments at high configured concurrency (default 64). Node's fetch is
    // undici under the hood, and undici's default global Agent applies a
    // per-origin connection cap that can silently serialize requests back
    // down to a much smaller effective concurrency than the caller asked
    // for — passing an explicit `dispatcher` (an `undici.Agent`/`Pool` sized
    // to the caller's concurrency) is how a caller guarantees the requested
    // fan-out actually happens over the wire. `undefined` here is a no-op —
    // every other caller of this function (backups, segment writes/deletes)
    // is unaffected and keeps using the default global dispatcher.
    ...(dispatcher !== undefined ? { dispatcher } : {}),
    ...(method === "PUT" || method === "POST" ? { body: payload } : {}),
  });
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    const rawBody = await response.text().catch(() => "");
    const parsed = parseS3ErrorBody(rawBody);
    const displayMessage = parsed
      ? parsed.message && parsed.code
        ? `${parsed.message} (${parsed.code})`
        : parsed.message || parsed.code
      : rawBody || `S3 storage request failed with ${response.status}`;
    const error = new StorageError(displayMessage, "STORAGE_REQUEST_FAILED");
    // The specific S3 error code (e.g. "SignatureDoesNotMatch"), separate
    // from `displayMessage` above, so a caller can branch on it — e.g. to
    // map it onto an even shorter plain-language message — without having
    // to re-parse it back out of the message string.
    if (parsed?.code) error.remoteCode = parsed.code;
    throw error;
  }
  if (method === "GET" || method === "POST") return response;
  return null;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function xmlUnescape(text = "") {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlEscape(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? xmlUnescape(match[1]) : null;
}

/**
 * S3's error responses are an XML body shaped like
 * `<Error><Code>SignatureDoesNotMatch</Code><Message>...</Message>
 * <RequestId>...</RequestId><HostId>...</HostId></Error>` — useful for AWS
 * support tickets, useless (and actively confusing) surfaced verbatim to an
 * operator. Pulls out `Code`/`Message` as separate fields so a caller can
 * either show them as-is (still far more readable than the raw XML) or map
 * `code` onto a short, plain-language message for well-known cases (see
 * `FRIENDLY_S3_ERROR_MESSAGES` in observability.ts's probe handler).
 * Returns `null` for a response that isn't this shape at all, e.g. a
 * non-AWS S3-compatible service returning plain text or JSON.
 */
function parseS3ErrorBody(bodyText) {
  if (!bodyText || !bodyText.includes("<Error>")) return null;
  const code = xmlTag(bodyText, "Code");
  const message = xmlTag(bodyText, "Message");
  if (!code && !message) return null;
  return { code, message };
}

/**
 * Parse an S3 ListObjectsV2 XML response into the flat shape this module's
 * callers use. Hand-rolled rather than pulling in an XML dependency: the
 * ListBucketResult schema this reads is flat and well-known.
 */
function parseListObjectsResponse(xml) {
  const objects = [];
  const contentsBlocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
  for (const block of contentsBlocks) {
    const key = xmlTag(block, "Key");
    if (key == null) continue;
    const sizeText = xmlTag(block, "Size");
    const lastModifiedText = xmlTag(block, "LastModified");
    objects.push({
      key,
      size: sizeText != null ? Number.parseInt(sizeText, 10) : 0,
      lastModified: lastModifiedText ? new Date(lastModifiedText) : null,
    });
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  const nextContinuationToken = xmlTag(xml, "NextContinuationToken");
  return { objects, isTruncated, nextContinuationToken };
}

/**
 * List every S3/R2 object whose key starts with `prefix`, following
 * NextContinuationToken to exhaustion.
 */
async function listS3Objects(prefix, config, { signal } = {}) {
  const results = [];
  let continuationToken = null;
  for (;;) {
    throwIfAborted(signal, "storage list");
    const query = { "list-type": "2", prefix: prefix || "" };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const response = await s3Request("GET", "", null, config, { signal, query });
    const xml = await response.text();
    const parsed = parseListObjectsResponse(xml);
    results.push(...parsed.objects);
    if (!parsed.isTruncated || !parsed.nextContinuationToken) break;
    continuationToken = parsed.nextContinuationToken;
  }
  return results;
}

function parseDeleteResultXml(xml) {
  const errors = [];
  const errorBlocks = xml.match(/<Error>[\s\S]*?<\/Error>/g) || [];
  for (const block of errorBlocks) {
    errors.push({
      key: xmlTag(block, "Key"),
      code: xmlTag(block, "Code"),
      message: xmlTag(block, "Message"),
    });
  }
  return errors;
}

const S3_DELETE_CHUNK_SIZE = 1000;

/**
 * Batch-delete S3/R2 keys, chunked at S3's 1000-keys-per-request API limit.
 * Each chunk needs a `Content-MD5` of the XML body per the S3 Delete Objects
 * API contract.
 */
async function deleteS3Objects(keys, config, { signal } = {}) {
  let deleted = 0;
  const errors = [];
  for (let i = 0; i < keys.length; i += S3_DELETE_CHUNK_SIZE) {
    throwIfAborted(signal, "storage batch delete");
    const chunk = keys.slice(i, i + S3_DELETE_CHUNK_SIZE);
    const body = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Delete>${chunk
        .map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`)
        .join("")}</Delete>`,
      "utf8",
    );
    const contentMd5 = crypto.createHash("md5").update(body).digest("base64");
    const response = await s3Request("POST", "", body, config, {
      signal,
      query: { delete: "" },
      headers: { "content-type": "application/xml", "content-md5": contentMd5 },
    });
    const xml = await response.text();
    const chunkErrors = parseDeleteResultXml(xml);
    errors.push(...chunkErrors);
    deleted += chunk.length - chunkErrors.length;
  }
  return { deleted, errors };
}

// SSH/SFTP storage

function sshRemoteObjectPath(config = {}, storageKey = "") {
  const base = path.posix.normalize(String(config.sshRemotePath || "/backups/nora").replace(/\/+$/, ""));
  const normalizedKey = String(storageKey).replace(/^\/+/, "");
  const resolved = path.posix.normalize(path.posix.join(base, normalizedKey));
  if (base !== "/" && resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new StorageError("Invalid storage key", "STORAGE_INVALID_KEY");
  }
  return resolved;
}

function connectSsh(config = {}, { signal } = {}) {
  if (!config.sshHost || !config.sshUsername) {
    throw new StorageError("SSH storage requires a host and username", "STORAGE_SSH_NOT_CONFIGURED", {
      detail: "host",
    });
  }
  if (!config.sshPrivateKey && !config.sshPassword) {
    throw new StorageError(
      "SSH storage requires a private key or password",
      "STORAGE_SSH_NOT_CONFIGURED",
      { detail: "credential" },
    );
  }
  throwIfAborted(signal, "SSH connect");

  return new Promise((resolve, reject) => {
    const SshClient = loadSshClient();
    const client = new SshClient();
    let onAbort;
    if (signal) {
      onAbort = () => {
        try {
          client.end();
        } catch {
          /* best effort */
        }
        const reason = signal.reason instanceof Error ? signal.reason : new Error("SSH aborted");
        if (!reason.statusCode) reason.statusCode = 499;
        reject(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const settle = (fn) => (arg) => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };
    client
      .once("ready", () => settle(resolve)(client))
      .once("error", settle(reject))
      .connect({
        host: config.sshHost,
        port: config.sshPort || 22,
        username: config.sshUsername,
        ...(config.sshPrivateKey ? { privateKey: config.sshPrivateKey } : {}),
        ...(config.sshPassword ? { password: config.sshPassword } : {}),
        readyTimeout: 30000,
      });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error);
      resolve(sftp);
    });
  });
}

function sftpMkdir(sftp, directory) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(directory, { mode: 0o700 }, (error) => {
      if (error && error.code !== 4) return reject(error);
      resolve();
    });
  });
}

async function ensureSftpDirectory(sftp, directory) {
  const normalized = path.posix.normalize(directory);
  const parts = normalized.split("/").filter(Boolean);
  let current = normalized.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    await sftpMkdir(sftp, current).catch(() => {});
  }
}

function sftpWriteFile(sftp, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, buffer, { mode: 0o600 }, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function sftpReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) return reject(error);
      resolve(Buffer.from(data));
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error && error.code !== 2) return reject(error);
      resolve();
    });
  });
}

function sftpReaddir(sftp, directory) {
  return new Promise((resolve, reject) => {
    sftp.readdir(directory, (error, entries) => {
      if (error) {
        if (error.code === 2) return resolve([]); // ENOENT-equivalent: no such directory
        return reject(error);
      }
      resolve(entries || []);
    });
  });
}

async function withSftp(config, callback, { signal } = {}) {
  const client = await connectSsh(config, { signal });
  let onAbort;
  if (signal) {
    onAbort = () => {
      try {
        client.end();
      } catch {
        /* best effort */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const sftp = await openSftp(client);
    return await callback(sftp);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    client.end();
  }
}

async function putSshObject(storageKey, buffer, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  await withSftp(
    config,
    async (sftp) => {
      await ensureSftpDirectory(sftp, path.posix.dirname(remotePath));
      await sftpWriteFile(sftp, remotePath, buffer);
    },
    { signal },
  );
}

async function getSshObject(storageKey, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  return withSftp(config, (sftp) => sftpReadFile(sftp, remotePath), { signal });
}

async function deleteSshObject(storageKey, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  return withSftp(config, (sftp) => sftpUnlink(sftp, remotePath), { signal });
}

/**
 * Recursively walk the SSH remote root under `config.sshRemotePath`,
 * returning every object whose key (relative to that root) starts with
 * `prefix`.
 */
async function listSshObjects(prefix, config = {}, { signal } = {}) {
  const base = path.posix.normalize(String(config.sshRemotePath || "/backups/nora").replace(/\/+$/, ""));
  const results = [];

  await withSftp(
    config,
    async (sftp) => {
      async function walk(directory) {
        throwIfAborted(signal, "storage list");
        const entries = await sftpReaddir(sftp, directory);
        for (const entry of entries) {
          if (entry.filename === "." || entry.filename === "..") continue;
          const fullPath = path.posix.join(directory, entry.filename);
          const isDirectory =
            typeof entry.attrs?.isDirectory === "function" ? entry.attrs.isDirectory() : false;
          if (isDirectory) {
            await walk(fullPath);
            continue;
          }
          const key = fullPath.startsWith(`${base}/`) ? fullPath.slice(base.length + 1) : fullPath;
          if (prefix && !key.startsWith(prefix)) continue;
          results.push({
            key,
            size: entry.attrs?.size ?? 0,
            lastModified: entry.attrs?.mtime ? new Date(entry.attrs.mtime * 1000) : null,
          });
        }
      }
      await walk(base);
    },
    { signal },
  );

  results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return results;
}

async function deleteSshObjects(keys, config = {}, { signal } = {}) {
  let deleted = 0;
  const errors = [];
  for (const key of keys) {
    try {
      await deleteSshObject(key, config, { signal });
      deleted += 1;
    } catch (error) {
      errors.push({ key, message: error?.message || String(error) });
    }
  }
  return { deleted, errors };
}

// Backend dispatch

function isS3Backend(config) {
  return config.storageBackend === "s3" || config.storageBackend === "r2";
}

async function putStorageObject(storageKey, buffer, config = {}, { signal } = {}) {
  const resolved = normalizeStorageConfig(config);
  if (isS3Backend(resolved)) return s3Request("PUT", storageKey, buffer, resolved, { signal });
  if (resolved.storageBackend === "ssh") return putSshObject(storageKey, buffer, resolved, { signal });
  return putLocalObject(storageKey, buffer, resolved, { signal });
}

async function getStorageObject(storageKey, config = {}, { signal, dispatcher } = {}) {
  const resolved = normalizeStorageConfig(config);
  if (isS3Backend(resolved)) {
    const response = await s3Request("GET", storageKey, null, resolved, { signal, dispatcher });
    return Buffer.from(await response.arrayBuffer());
  }
  if (resolved.storageBackend === "ssh") return getSshObject(storageKey, resolved, { signal });
  return getLocalObject(storageKey, resolved, { signal });
}

async function deleteStorageObject(storageKey, config = {}, { signal } = {}) {
  if (!storageKey) return;
  const resolved = normalizeStorageConfig(config);
  if (isS3Backend(resolved)) {
    await s3Request("DELETE", storageKey, null, resolved, { signal });
    return;
  }
  if (resolved.storageBackend === "ssh") return deleteSshObject(storageKey, resolved, { signal });
  return deleteLocalObject(storageKey, resolved, { signal });
}

/**
 * List every object under `prefix`, backend-neutral.
 *
 * @returns {Promise<{key: string, size: number, lastModified: Date|null}[]>}
 */
async function listStorageObjects(prefix, config = {}, { signal } = {}) {
  const resolved = normalizeStorageConfig(config);
  if (isS3Backend(resolved)) return listS3Objects(prefix, resolved, { signal });
  if (resolved.storageBackend === "ssh") return listSshObjects(prefix, resolved, { signal });
  return listLocalObjects(prefix, resolved, { signal });
}

/**
 * Delete every key in `keys`, backend-neutral.
 *
 * @returns {Promise<{deleted: number, errors: {key: string, message?: string, code?: string}[]}>}
 */
async function deleteStorageObjects(keys, config = {}, { signal } = {}) {
  const resolved = normalizeStorageConfig(config);
  if (!keys || keys.length === 0) return { deleted: 0, errors: [] };
  if (isS3Backend(resolved)) return deleteS3Objects(keys, resolved, { signal });
  if (resolved.storageBackend === "ssh") return deleteSshObjects(keys, resolved, { signal });
  return deleteLocalObjects(keys, resolved, { signal });
}

/**
 * Verify a storage config actually works — writes a small marker object,
 * reads it back to confirm round-trip integrity, then deletes it — instead
 * of trusting untested credentials. Exists so a caller can validate a
 * destination BEFORE committing to it (persisting it as the active
 * destination, or kicking off a migration against it), rather than only
 * discovering bad credentials/network/permissions when something that
 * actually matters (a live log flush, a migration job) fails against them.
 *
 * `local` is skipped — no remote credentials to validate, and its
 * writability/capacity are already covered by the caller's own
 * capacity-gate checks at actual write time, so a duplicate check here
 * would add nothing.
 *
 * Always attempts cleanup of the probe object, even when the write or
 * read-back failed partway through, so a failed probe never leaves litter
 * in the bucket/path being tested. Throws the same plain `StorageError` any
 * other operation in this module throws — never HTTP-shaped — letting the
 * caller decide how to surface it.
 *
 * @param {Object} config - a storage config, same shape as every other
 *   function in this module takes.
 * @returns {Promise<{ok: true}>}
 */
async function probeStorageDestination(config = {}, { signal } = {}) {
  const resolved = normalizeStorageConfig(config);
  if (resolved.storageBackend === "local") {
    return { ok: true };
  }

  const probeKey = `.nora-connectivity-probe-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const probeBody = Buffer.from("nora-log-storage-connectivity-probe");
  try {
    await putStorageObject(probeKey, probeBody, resolved, { signal });
    const readBack = await getStorageObject(probeKey, resolved, { signal });
    if (!Buffer.isBuffer(readBack) || !readBack.equals(probeBody)) {
      throw new StorageError(
        "Wrote a test object successfully, but reading it back returned different content.",
        "STORAGE_PROBE_READBACK_MISMATCH",
      );
    }
    return { ok: true };
  } finally {
    // Best-effort cleanup — a delete failure here must never mask (or
    // replace) whatever the write/read outcome above actually was.
    try {
      await deleteStorageObject(probeKey, resolved, { signal });
    } catch {
      // ignore
    }
  }
}

module.exports = {
  StorageError,
  normalizeStorageConfig,
  probeStorageDestination,
  throwIfAborted,
  // local
  putLocalObject,
  getLocalObject,
  deleteLocalObject,
  listLocalObjects,
  deleteLocalObjects,
  // s3/r2
  hmac,
  hashHex,
  s3Config,
  encodeS3Key,
  s3Request,
  listS3Objects,
  deleteS3Objects,
  // ssh
  sshRemoteObjectPath,
  connectSsh,
  openSftp,
  sftpMkdir,
  ensureSftpDirectory,
  sftpWriteFile,
  sftpReadFile,
  sftpUnlink,
  withSftp,
  putSshObject,
  getSshObject,
  deleteSshObject,
  listSshObjects,
  deleteSshObjects,
  // backend-neutral dispatch
  putStorageObject,
  getStorageObject,
  deleteStorageObject,
  listStorageObjects,
  deleteStorageObjects,
};
