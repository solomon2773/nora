// @ts-nocheck
// workers/provisioner/logs/segmentWriter.ts — Phase 3 of the logging control
// plane: buffers normalized log lines per (agent_id, stream) and flushes
// them as compressed, encrypted, immutable segments with a matching
// `log_segments` index row.
//
// Depends on:
//   - agent-runtime/lib/objectStorage.ts (Phase 0)   — putStorageObject
//   - backend-api/db_schema.sql `log_segments`       (Phase 1)
//   - agent-runtime/lib/logLine.ts line envelope      (Phase 2, no `ord`)
//
// Read the manifest's "Buffered lines survive a crash" and "Segments are
// immutable" sections, and the implementation plan's Phase 3 "Rationale &
// tradeoffs", before changing any of the timing/ordering decisions below —
// several of them look arbitrary in isolation but are load-bearing for the
// crash-replay and tenancy guarantees this module promises.

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");

const objectStorage = require("../../../agent-runtime/lib/objectStorage.ts");
const logStorageConfigModule = require("./logStorageConfig.ts");

// ── Tunables ─────────────────────────────────────────────────────────────
//
// Flush timer: 15 minutes (Design Decision 6 / Phase 3 item 2).
const DEFAULT_FLUSH_INTERVAL_MS = 15 * 60 * 1000;

// Per-buffer uncompressed-size flush threshold (Phase 3 items 8-9). This is
// an ESTIMATE, not an exact trigger: the Search Performance Model measures a
// typical segment at ~155 KB raw / ~19 KB compressed (~8:1). The 8 MB
// compressed target this threshold aims for is a safety valve for a
// crash-looping or unusually chatty agent, not the normal flush path — the
// 15-minute timer is what fires under typical volume. Node's zstd stream
// does not emit compressed output at anywhere near input rate (measured:
// ~1.4 MB in can sit behind ~20 KB emitted before a flush forces it out),
// which is exactly why this is tracked on uncompressed bytes rather than
// compressed bytes emitted so far — the latter would neither bound memory
// nor fire anywhere near the target size.
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Global resident bound across every open buffer combined (Phase 3 item
// 15). 50 agents x 2 streams x a per-buffer bound alone would admit
// hundreds of MB into a process that also drains the provisioning queue, so
// this is a separate, smaller, installation-wide ceiling. Tuned generously
// above one full per-buffer threshold so a single busy agent doesn't
// immediately trip the global bound on its own.
const DEFAULT_GLOBAL_MAX_BYTES = 256 * 1024 * 1024;

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

// Bounded local staging directory cap (Phase 3 item 16's "bounded"
// requirement). This is a coarse, best-effort cap on parked bytes.
const DEFAULT_STAGING_MAX_BYTES = 512 * 1024 * 1024;

// Phase 5: how often the capacity gate is re-checked independent of any
// flush attempt. This is what makes a capacity-paused stream resume
// automatically (Phase 5 item 7 / Phase 4 item 7) rather than staying
// wedged: a paused buffer that receives no new lines (because the collector
// already detached it) would otherwise never re-enter the per-flush capacity
// check inside flush(), since a buffer with zero pending lines returns early
// before that check ever ran in the original Phase 3 placeholder. Polling
// independently of flush activity, at a cadence comfortably faster than the
// collector's 30s reconcile tick, is what lets `isCapacityPaused` actually
// clear once usage drops back under the cap.
const DEFAULT_CAPACITY_POLL_INTERVAL_MS = 10 * 1000;

const LOG_ENCRYPTION_MAGIC = "NORA_LOG_SEGMENT_V1";

// ── Encryption (Phase 3 item 10 / function list) ────────────────────────
//
// Mirrors backend-api/backups.ts's encryptBackupBuffer/decryptBackupBuffer
// (magic string + IV + GCM auth tag), with one deliberate divergence: a key
// id is framed in the header. The backup format doesn't carry one, which is
// fine for a point-in-time archive; a 30-day log history that's read
// constantly is not, so NORA_LOG_ENCRYPTION_KEY must be rotatable without
// destroying every segment written under the previous key.
//
// Env format: comma-separated `keyId:hexkey` pairs, e.g.
// `k1:aaaa...,k2:bbbb...`. A bare 64-char hex value with no `keyId:` prefix
// is accepted for the common single-key case and assigned the id
// "default". The FIRST entry is "current" — used to encrypt new segments.
// Every entry is available for decryption. Rotation is: prepend a new
// `keyId:hexkey` pair (it becomes current), keep the old pair in the list
// until `SELECT 1 FROM log_segments WHERE encryption_key_id = $old LIMIT 1`
// returns no rows, then remove it.
function loadLogEncryptionKeys(env = process.env) {
  const raw = String(env.NORA_LOG_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error("NORA_LOG_ENCRYPTION_KEY is not configured");
  }
  const keys = new Map();
  let currentKeyId = null;
  for (const entry of raw.split(",")) {
    const part = entry.trim();
    if (!part) continue;
    let keyId;
    let hex;
    if (part.includes(":")) {
      const idx = part.indexOf(":");
      keyId = part.slice(0, idx).trim();
      hex = part.slice(idx + 1).trim();
    } else {
      keyId = "default";
      hex = part;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        `NORA_LOG_ENCRYPTION_KEY entry "${keyId}" is not a valid 64-char hex key`,
      );
    }
    keys.set(keyId, Buffer.from(hex, "hex"));
    if (currentKeyId === null) currentKeyId = keyId;
  }
  if (!keys.size) throw new Error("NORA_LOG_ENCRYPTION_KEY is not configured");
  return { keys, currentKeyId };
}

/**
 * Encrypt a compressed segment buffer with AES-256-GCM, framing a key id so
 * `decryptSegment` can select the right key after rotation.
 *
 * @param {Buffer} buffer - compressed (zstd) segment bytes.
 * @param {{keys: Map<string,Buffer>, currentKeyId: string}} [keyRing] -
 *   defaults to parsing NORA_LOG_ENCRYPTION_KEY.
 * @returns {{ buffer: Buffer, keyId: string }}
 */
function encryptSegment(buffer, keyRing) {
  const ring = keyRing || loadLogEncryptionKeys();
  const key = ring.keys.get(ring.currentKeyId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from(
    `${LOG_ENCRYPTION_MAGIC}\n${ring.currentKeyId}:${iv.toString("hex")}:${tag.toString("hex")}\n`,
    "utf8",
  );
  return { buffer: Buffer.concat([header, encrypted]), keyId: ring.currentKeyId };
}

/**
 * Authenticate and decrypt a segment framed by `encryptSegment`, selecting
 * the decryption key by the id carried in the header — this is what lets a
 * segment encrypted under a retired key still decrypt after a new key
 * becomes current.
 *
 * @param {Buffer} buffer
 * @param {{keys: Map<string,Buffer>}} [keyRing]
 * @returns {Buffer} decompressed-ready (still zstd-compressed) bytes.
 */
function decryptSegment(buffer, keyRing) {
  const ring = keyRing || loadLogEncryptionKeys();
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 256));
  if (!text.startsWith(`${LOG_ENCRYPTION_MAGIC}\n`)) {
    throw new Error("Log segment is not encrypted with the expected Nora format");
  }
  const firstNewline = buffer.indexOf(0x0a);
  const secondNewline = buffer.indexOf(0x0a, firstNewline + 1);
  const meta = buffer.toString("utf8", firstNewline + 1, secondNewline);
  const [keyId, ivHex, tagHex] = meta.split(":");
  const key = ring.keys.get(keyId);
  if (!key) {
    throw new Error(`Log segment references unknown encryption key id "${keyId}"`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(buffer.slice(secondNewline + 1)),
    decipher.final(),
  ]);
}

// ── ord assignment (Phase 3 items 12-13 / function list) ────────────────

/**
 * Sort a flush window's lines by `(COALESCE(ts, observed_ts), arrival order
 * within this flush)` and assign `ord` as the post-sort position.
 *
 * Called exactly once per flush, never per line at parse time. This MUST be
 * a pure function of `lines`' contents and array order — no wall clock, no
 * shared counter — because a parse-time counter's value depends on process
 * state that a crash-and-replay cannot reproduce, which would break the
 * "replay upserts the same storage_key with byte-identical content"
 * guarantee (item 14, and Phase 4 item 2a). `lines`' array order IS arrival
 * order within this flush by construction (the buffer only ever appends),
 * so replaying the identical set of lines in the identical order — true for
 * the runtime stream because Docker's json-file driver is an ordered,
 * append-only source and replay reads the same file — reproduces the
 * identical sort and therefore identical `ord` values.
 *
 * The same-timestamp tie-break (arrival order) is verified reproducible
 * only for the runtime stream. For the gateway stream, `logs.tail` is a
 * polled RPC, not a static file, and whether two same-millisecond lines
 * return in the same relative order across two independent poll sessions is
 * an assumption about OpenClaw's server-side ordering that has NOT been
 * verified against the actual `logs.tail` contract — that verification is
 * explicitly left to Phase 10 (see manifest "Line schema" section). Do not
 * read this function's use on the gateway stream as proof that question is
 * settled.
 */
function assignOrd(lines) {
  const withArrival = lines.map((line, arrival) => ({ line, arrival }));
  withArrival.sort((a, b) => {
    const ta = a.line.ts || a.line.observed_ts;
    const tb = b.line.ts || b.line.observed_ts;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.arrival - b.arrival;
  });
  return withArrival.map(({ line }, ord) => ({ ...line, ord }));
}

// ── Storage key layout (function list) ───────────────────────────────────

function twoDigit(n) {
  return String(n).padStart(2, "0");
}

/**
 * `ws_<workspaceId>/agent_<id>/<stream>/<date>/<HHMM>-<HHMM>.ndjson.zst.enc`,
 * or `user_<userId>/...` when the agent belongs to no workspace.
 *
 * Deliberately NOT a shared `unassigned/` pool: pooling every workspace-less
 * agent under one prefix would mix one noisy unowned agent's data into a
 * different user's data for both the manual-deletion surface and the
 * capacity-halt accounting, which both reason about a single owner's data.
 * `agents.user_id` is always populated (verified against db_schema.sql —
 * `user_id UUID REFERENCES users(id) ON DELETE CASCADE`, NOT NULL by every
 * caller that creates an agent row), so the owner is always resolvable.
 *
 * @param {{workspaceId?: string|null, ownerUserId?: string|null}} tenant
 * @param {string} agentId
 * @param {string} stream - "runtime" | "gateway"
 * @param {string|number|Date} tsFrom
 * @param {string|number|Date} tsTo
 */
function buildStorageKey(tenant, agentId, stream, tsFrom, tsTo) {
  const workspaceId = tenant && tenant.workspaceId;
  const ownerUserId = tenant && tenant.ownerUserId;
  if (!workspaceId && !ownerUserId) {
    throw new Error("buildStorageKey requires a workspaceId or ownerUserId");
  }
  const prefix = workspaceId ? `ws_${workspaceId}` : `user_${ownerUserId}`;
  const from = tsFrom instanceof Date ? tsFrom : new Date(tsFrom);
  const to = tsTo instanceof Date ? tsTo : new Date(tsTo);
  const date = from.toISOString().slice(0, 10);
  const hhmmFrom = `${twoDigit(from.getUTCHours())}${twoDigit(from.getUTCMinutes())}`;
  const hhmmTo = `${twoDigit(to.getUTCHours())}${twoDigit(to.getUTCMinutes())}`;
  return `${prefix}/agent_${agentId}/${stream}/${date}/${hhmmFrom}-${hhmmTo}.ndjson.zst.enc`;
}

// ── checkLocalCapacity (Phase 3 item 22 / function list) ────────────────
//
// Phase 5 owns the authoritative, installation-wide usage-tracking mechanism
// this gate delegates to: `localStorageUsage()` in retentionSweeper.ts, an
// O(1) `SELECT COALESCE(SUM(bytes),0) FROM log_segments WHERE
// storage_backend = 'local'` rather than a per-call disk walk. The
// `{ usedBytes, limitBytes, atCapacity }` contract this function returns is
// unchanged from Phase 3's original placeholder, so every call site written
// against that placeholder keeps working unmodified — only the body changed.
//
// Lazy-required (not `require`d at module load time) to avoid a load-order
// dependency between the two sibling modules — retentionSweeper.ts does not
// require this module back, so there is no real cycle, but requiring lazily
// here keeps that invariant enforced by construction rather than by
// convention.
async function checkLocalCapacity({
  limitBytes = Number(process.env.NORA_LOG_LOCAL_MAX_BYTES) || Infinity,
  localStorageUsage: usageFn,
} = {}) {
  const usage = usageFn || require("./retentionSweeper.ts").localStorageUsage;
  const usedBytes = await usage();
  return { usedBytes, limitBytes, atCapacity: usedBytes >= limitBytes };
}

// Bounded local **staging** directory size (Phase 3 item 16's "bounded"
// requirement for parked/failed remote uploads) — unrelated to the capacity
// gate above, which now tracks live `log_segments` usage in Postgres, not
// files on disk. Kept as a plain recursive disk walk since the staging
// directory holds a handful of not-yet-uploaded files at most, never the
// full retained history checkLocalCapacity used to scan.
function sumDirectorySizeSync(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += sumDirectorySizeSync(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // File removed between readdir and stat — ignore, best-effort.
      }
    }
  }
  return total;
}

// ── Buffer bookkeeping ────────────────────────────────────────────────

function bufferKey(agentId, stream) {
  return `${agentId}:${stream}`;
}

function lineByteSize(line) {
  return Buffer.byteLength(JSON.stringify(line), "utf8");
}

function sanitizeStagingName(storageKey) {
  return storageKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * @param {Object} [deps]
 * @param {Object} [deps.db] - pg-like `{ query(sql, params) }`. Defaults to
 *   the shared backend-api pool, matching how worker.ts already requires
 *   other backend-api modules directly (e.g. alertRules.ts, monitoring.ts).
 * @param {Function} [deps.putStorageObject] - defaults to
 *   objectStorage.putStorageObject.
 * @param {Function} [deps.logStorageConfig] - defaults to
 *   logStorageConfig.ts's `logStorageConfig()`.
 * @param {Function} [deps.now] - injectable clock, `() => number` (ms epoch).
 * @param {number} [deps.flushIntervalMs]
 * @param {number} [deps.maxBufferBytes]
 * @param {number} [deps.globalMaxBytes]
 * @param {{keys: Map, currentKeyId: string}} [deps.keyRing] - defaults to
 *   parsing NORA_LOG_ENCRYPTION_KEY lazily on first use.
 * @param {string} [deps.stagingDir]
 * @param {number} [deps.stagingMaxBytes]
 * @param {number[]} [deps.retryDelaysMs]
 * @param {Function} [deps.sleep]
 * @param {Function} [deps.checkLocalCapacity] - defaults to the module-level
 *   `checkLocalCapacity`.
 * @param {Function} [deps.setIntervalFn] / {Function} [deps.clearIntervalFn]
 *   - injectable timer functions for deterministic tests.
 * @param {Console} [deps.logger]
 * @returns {{ append: Function, flush: Function, flushAll: Function,
 *   shutdown: Function, deleteAgent: Function, retryParkedSegments: Function,
 *   isCapacityPaused: Function }}
 */
function createSegmentWriter(deps = {}) {
  const db = deps.db || require("../../../backend-api/db.ts");
  const putObj = deps.putStorageObject || objectStorage.putStorageObject;
  const resolveStorageConfig =
    deps.logStorageConfig || logStorageConfigModule.logStorageConfig;
  const now = deps.now || (() => Date.now());
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferBytes = deps.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const globalMaxBytes = deps.globalMaxBytes ?? DEFAULT_GLOBAL_MAX_BYTES;
  const stagingDir =
    deps.stagingDir ||
    path.join(process.env.NORA_LOG_DIR || "/var/lib/nora-logs", ".staging");
  const stagingMaxBytes = deps.stagingMaxBytes ?? DEFAULT_STAGING_MAX_BYTES;
  const retryDelaysMs = deps.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const checkCapacity = deps.checkLocalCapacity || checkLocalCapacity;
  const capacityPollIntervalMs = deps.capacityPollIntervalMs ?? DEFAULT_CAPACITY_POLL_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const logger = deps.logger || console;
  let keyRing = deps.keyRing || null;
  function ring() {
    if (!keyRing) keyRing = loadLogEncryptionKeys();
    return keyRing;
  }

  /** @type {Map<string, Object>} */
  const buffers = new Map();
  let totalBufferedBytes = 0;
  let shuttingDown = false;

  /**
   * Refresh every open buffer's `capacityPaused` flag from the shared
   * installation-wide capacity gate, independent of whether any buffer has
   * pending lines to flush right now. See DEFAULT_CAPACITY_POLL_INTERVAL_MS's
   * comment for why this exists as its own timer rather than piggybacking
   * solely on flush() — a paused stream the collector has already detached
   * (Phase 4 item 7) would otherwise never re-run the capacity check that
   * clears the flag, because flush() only reaches that check when the
   * buffer actually has lines to write.
   */
  async function pollCapacity() {
    if (buffers.size === 0) return;
    try {
      const config = await resolveStorageConfig();
      if (config.storageBackend !== "local") {
        // Capacity halts are local-driver-only (Design Decision 2c/manifest
        // "Object-storage drivers skip this step entirely") — clear any
        // stale flag left over from a prior local-driver period.
        for (const buffer of buffers.values()) buffer.capacityPaused = false;
        return;
      }
      const capacity = await checkCapacity();
      for (const buffer of buffers.values()) {
        buffer.capacityPaused = capacity.atCapacity;
      }
    } catch (error) {
      logger.warn(`[segmentWriter] capacity poll failed, leaving pause state unchanged: ${error.message}`);
    }
  }

  let capacityPollTimer = setIntervalFn(() => {
    pollCapacity().catch(() => {});
  }, capacityPollIntervalMs);
  if (typeof capacityPollTimer.unref === "function") capacityPollTimer.unref();
  // Don't make every caller wait a full poll interval for the first reading.
  pollCapacity().catch(() => {});

  function newBuffer(agentCtx) {
    const key = bufferKey(agentCtx.agentId, agentCtx.stream);
    const buffer = {
      key,
      agentId: agentCtx.agentId,
      stream: agentCtx.stream,
      workspaceId: agentCtx.workspaceId ?? null,
      ownerUserId: agentCtx.ownerUserId ?? null,
      lines: [],
      bytes: 0,
      droppedLines: 0,
      levelCounts: {},
      tsFrom: null,
      tsTo: null,
      capacityPaused: false,
      createdAtMs: now(),
      timer: null,
      flushing: null, // in-flight flush promise, so concurrent flush() calls join it
    };
    // Item 4: the flush timer runs from buffer creation and is NEVER reset
    // on reattach — this is what bounds a crash-looping agent at one
    // segment per interval instead of one per restart. Using a repeating
    // setInterval (rather than a one-shot re-armed after each flush) means
    // reattaching never touches the schedule at all.
    buffer.timer = setIntervalFn(() => {
      flush(key).catch((error) => {
        logger.error(`[segmentWriter] timer-triggered flush of ${key} failed: ${error.message}`);
      });
    }, flushIntervalMs);
    if (typeof buffer.timer.unref === "function") buffer.timer.unref();
    buffers.set(key, buffer);
    return buffer;
  }

  function getOrCreateBuffer(agentCtx) {
    const key = bufferKey(agentCtx.agentId, agentCtx.stream);
    const existing = buffers.get(key);
    if (existing) {
      // Reattach (Phase 3 item 3): keep using the same buffer/timer. A
      // mid-life workspace reassignment is picked up on reattach per Phase
      // 4 item 5 — earlier buffered lines keep whatever tenant they were
      // appended under, which only matters for the still-open window since
      // sealed segments already have their tenant baked into their key.
      existing.workspaceId = agentCtx.workspaceId ?? existing.workspaceId;
      existing.ownerUserId = agentCtx.ownerUserId ?? existing.ownerUserId;
      return existing;
    }
    return newBuffer(agentCtx);
  }

  function largestBuffer(excludeKey) {
    let largest = null;
    for (const buffer of buffers.values()) {
      if (buffer.key === excludeKey) continue;
      if (!largest || buffer.bytes > largest.bytes) largest = buffer;
    }
    return largest;
  }

  /**
   * Buffer a batch of already-normalized lines (Phase 2 envelope, no `ord`)
   * for `(agentCtx.agentId, agentCtx.stream)`.
   *
   * Global overflow handling (Phase 3 item 15): if admitting `lines` would
   * exceed the aggregate uncompressed-byte bound across every open buffer,
   * this first tries to free room by flushing the largest OTHER buffer
   * (preferring a flush to a drop). Only if that genuinely doesn't free
   * enough room are the offending lines dropped and `dropped_lines`
   * incremented on their own buffer — never silently on someone else's.
   */
  async function append(agentCtx, lines) {
    if (shuttingDown) return { appended: 0, dropped: lines.length };
    if (!lines || lines.length === 0) return { appended: 0, dropped: 0 };
    const buffer = getOrCreateBuffer(agentCtx);

    let appended = 0;
    let dropped = 0;
    for (const rawLine of lines) {
      const size = lineByteSize(rawLine);
      if (totalBufferedBytes + size > globalMaxBytes) {
        const victim = largestBuffer(buffer.key) || buffer;
        if (victim.lines.length > 0) {
          await flush(victim.key);
        }
        if (totalBufferedBytes + size > globalMaxBytes) {
          buffer.droppedLines += 1;
          dropped += 1;
          continue;
        }
      }
      buffer.lines.push(rawLine);
      buffer.bytes += size;
      totalBufferedBytes += size;
      const effectiveTs = rawLine.ts || rawLine.observed_ts;
      if (!buffer.tsFrom || effectiveTs < buffer.tsFrom) buffer.tsFrom = effectiveTs;
      if (!buffer.tsTo || effectiveTs > buffer.tsTo) buffer.tsTo = effectiveTs;
      const level = rawLine.level || "UNKNOWN";
      buffer.levelCounts[level] = (buffer.levelCounts[level] || 0) + 1;
      appended += 1;
    }

    if (buffer.bytes >= maxBufferBytes) {
      // Item 2: the uncompressed-size threshold flush trigger, independent
      // of the 15-minute timer.
      await flush(buffer.key);
    }

    return { appended, dropped };
  }

  function extractSnapshot(buffer) {
    const snapshot = {
      agentId: buffer.agentId,
      stream: buffer.stream,
      workspaceId: buffer.workspaceId,
      ownerUserId: buffer.ownerUserId,
      lines: buffer.lines,
      droppedLines: buffer.droppedLines,
      levelCounts: buffer.levelCounts,
      tsFrom: buffer.tsFrom,
      tsTo: buffer.tsTo,
    };
    totalBufferedBytes -= buffer.bytes;
    buffer.lines = [];
    buffer.bytes = 0;
    buffer.droppedLines = 0;
    buffer.levelCounts = {};
    buffer.tsFrom = null;
    buffer.tsTo = null;
    return snapshot;
  }

  function restoreSnapshot(buffer, snapshot) {
    // Local-driver failure path (item 21): put the un-flushed window back
    // ahead of whatever accumulated in the buffer since we extracted it, so
    // arrival order — and therefore assignOrd's tie-break — is preserved.
    const size = snapshot.lines.reduce((sum, line) => sum + lineByteSize(line), 0);
    buffer.lines = snapshot.lines.concat(buffer.lines);
    buffer.bytes += size;
    totalBufferedBytes += size;
    buffer.droppedLines += snapshot.droppedLines;
    for (const [level, count] of Object.entries(snapshot.levelCounts)) {
      buffer.levelCounts[level] = (buffer.levelCounts[level] || 0) + count;
    }
    if (!buffer.tsFrom || (snapshot.tsFrom && snapshot.tsFrom < buffer.tsFrom)) {
      buffer.tsFrom = snapshot.tsFrom;
    }
    if (!buffer.tsTo || (snapshot.tsTo && snapshot.tsTo > buffer.tsTo)) {
      buffer.tsTo = snapshot.tsTo;
    }
  }

  async function parkSegment(storageKey, encryptedBuffer, indexMeta) {
    await fsp.mkdir(stagingDir, { recursive: true });
    const existing = await (async () => {
      try {
        return sumDirectorySizeSync(stagingDir);
      } catch {
        return 0;
      }
    })();
    if (existing + encryptedBuffer.length > stagingMaxBytes) {
      logger.error(
        `[segmentWriter] staging directory at ${stagingDir} is at its bound ` +
          `(${stagingMaxBytes} bytes) — dropping segment ${storageKey} instead of parking it. ` +
          `This segment's lines are lost; raise NORA_LOG_LOCAL_MAX_BYTES/free the staging ` +
          `directory to prevent recurrence.`,
      );
      return false;
    }
    const base = sanitizeStagingName(storageKey);
    await fsp.writeFile(path.join(stagingDir, `${base}.seg`), encryptedBuffer, { mode: 0o600 });
    await fsp.writeFile(
      path.join(stagingDir, `${base}.json`),
      JSON.stringify({ storageKey, ...indexMeta }),
      { mode: 0o600 },
    );
    return true;
  }

  /**
   * Re-attempt uploading every segment parked to the staging directory
   * (Phase 3 item 16's "later re-upload"). Not itself scheduled by this
   * module — a later phase (or an operator-triggered admin action) is
   * expected to call this periodically; it is exposed on the writer so
   * tests and callers have a concrete entry point rather than an implicit
   * mechanism.
   */
  async function retryParkedSegments() {
    let entries;
    try {
      entries = await fsp.readdir(stagingDir);
    } catch (error) {
      if (error.code === "ENOENT") return { reuploaded: 0, remaining: 0 };
      throw error;
    }
    const sidecars = entries.filter((name) => name.endsWith(".json"));
    let reuploaded = 0;
    for (const sidecar of sidecars) {
      const base = sidecar.slice(0, -".json".length);
      const sidecarPath = path.join(stagingDir, sidecar);
      const segPath = path.join(stagingDir, `${base}.seg`);
      let meta;
      try {
        meta = JSON.parse(await fsp.readFile(sidecarPath, "utf8"));
        const payload = await fsp.readFile(segPath);
        const config = await resolveStorageConfig();
        await putObj(meta.storageKey, payload, config);
        await upsertIndexRow({
          storageKey: meta.storageKey,
          workspaceId: meta.workspaceId,
          agentId: meta.agentId,
          stream: meta.stream,
          tsFrom: meta.tsFrom,
          tsTo: meta.tsTo,
          bytes: meta.bytes,
          lines: meta.lines,
          droppedLines: meta.droppedLines,
          levelCounts: meta.levelCounts,
          storageBackend: config.storageBackend,
          storageConfigSnapshot: logStorageConfigModule.logStorageConfigSnapshot(config),
          encryptionKeyId: meta.encryptionKeyId,
        });
        await fsp.unlink(segPath).catch(() => {});
        await fsp.unlink(sidecarPath).catch(() => {});
        reuploaded += 1;
      } catch (error) {
        logger.warn(
          `[segmentWriter] re-upload of parked segment ${base} failed, will retry later: ${error.message}`,
        );
      }
    }
    const remainingEntries = await fsp.readdir(stagingDir).catch(() => []);
    return {
      reuploaded,
      remaining: remainingEntries.filter((name) => name.endsWith(".json")).length,
    };
  }

  async function upsertIndexRow(row) {
    await db.query(
      `INSERT INTO log_segments (
         workspace_id, agent_id, stream, ts_from, ts_to, storage_key,
         storage_backend, storage_config, encryption_key_id,
         bytes, lines, dropped_lines, level_counts
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (storage_key) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         ts_from = EXCLUDED.ts_from,
         ts_to = EXCLUDED.ts_to,
         storage_backend = EXCLUDED.storage_backend,
         storage_config = EXCLUDED.storage_config,
         encryption_key_id = EXCLUDED.encryption_key_id,
         bytes = EXCLUDED.bytes,
         lines = EXCLUDED.lines,
         dropped_lines = EXCLUDED.dropped_lines,
         level_counts = EXCLUDED.level_counts
       RETURNING id`,
      [
        row.workspaceId,
        row.agentId,
        row.stream,
        row.tsFrom,
        row.tsTo,
        row.storageKey,
        row.storageBackend,
        JSON.stringify(row.storageConfigSnapshot || {}),
        row.encryptionKeyId,
        row.bytes,
        row.lines,
        row.droppedLines,
        JSON.stringify(row.levelCounts || {}),
      ],
    );
  }

  /**
   * Flush the buffer for `key` (as produced by `bufferKey(agentId,
   * stream)`). No-op when the buffer doesn't exist or has nothing to flush.
   * Concurrent calls for the same key join the in-flight flush rather than
   * racing two uploads of overlapping windows.
   */
  async function flush(key) {
    const buffer = buffers.get(key);
    if (!buffer) return { skipped: true, reason: "no_buffer" };
    if (buffer.flushing) return buffer.flushing;

    const run = (async () => {
      const config = await resolveStorageConfig();
      const isLocal = config.storageBackend === "local";

      // Item 22: consult the capacity gate BEFORE admitting a flush on the
      // local driver, and BEFORE the empty-buffer early return below. This
      // ordering matters (Phase 5's fix to a Phase 3 deadlock): a
      // capacity-paused stream is detached by the collector (Phase 4 item
      // 7), so its buffer stops receiving new lines and would otherwise sit
      // at `lines.length === 0` forever, never reaching this check again to
      // clear `capacityPaused` once usage drops. Checking capacity first —
      // on every timer-triggered flush, even an empty one — means the
      // 15-minute flush timer alone is enough to eventually clear the flag;
      // the dedicated `pollCapacity` timer (see its own comment above)
      // exists to clear it much sooner than that, at a cadence the
      // collector's 30s reconcile tick can actually observe.
      //
      // This is a different, non-retryable path from item 16's
      // retry-and-park, which is for transient remote failures — a capacity
      // halt is a standing condition, not a blip, so we skip rather than
      // retry, and leave the buffer untouched so no data is lost while
      // paused.
      if (isLocal) {
        const capacity = await checkCapacity();
        buffer.capacityPaused = capacity.atCapacity;
        if (capacity.atCapacity) {
          if (buffer.lines.length > 0) {
            logger.warn(
              `[segmentWriter] local storage at capacity (${capacity.usedBytes}/${capacity.limitBytes} ` +
                `bytes) — skipping flush for ${key} and marking it capacity-paused. Collection for ` +
                `this stream should disconnect (Phase 4 item 7) until usage drops back under the cap.`,
            );
          }
          return { skipped: true, reason: "capacity" };
        }
      } else {
        buffer.capacityPaused = false;
      }

      if (buffer.lines.length === 0) {
        return { skipped: true, reason: "empty" };
      }

      const snapshot = extractSnapshot(buffer);
      try {
        const ordered = assignOrd(snapshot.lines);
        const ndjson = ordered.map((line) => JSON.stringify(line)).join("\n") + "\n";
        const uncompressed = Buffer.from(ndjson, "utf8");
        const compressed = zlib.zstdCompressSync(uncompressed);
        const { buffer: encrypted, keyId } = encryptSegment(compressed, ring());

        const tenant = { workspaceId: snapshot.workspaceId, ownerUserId: snapshot.ownerUserId };
        const storageKey = buildStorageKey(
          tenant,
          snapshot.agentId,
          snapshot.stream,
          snapshot.tsFrom,
          snapshot.tsTo,
        );

        const indexMeta = {
          workspaceId: snapshot.workspaceId,
          agentId: snapshot.agentId,
          stream: snapshot.stream,
          tsFrom: snapshot.tsFrom,
          tsTo: snapshot.tsTo,
          bytes: encrypted.length,
          lines: ordered.length,
          droppedLines: snapshot.droppedLines,
          levelCounts: snapshot.levelCounts,
          encryptionKeyId: keyId,
        };

        if (isLocal) {
          // Item 21: local write failures surface immediately — no retry,
          // no park. A local disk failure is not the transient condition
          // retry-and-park exists for.
          try {
            await putObj(storageKey, encrypted, config);
          } catch (error) {
            restoreSnapshot(buffer, snapshot);
            throw error;
          }
        } else {
          const result = await putWithRetryOrPark({
            storageKey,
            payload: encrypted,
            config,
            retryDelaysMs,
            sleep,
            logger,
            put: putObj,
            park: (meta) => parkSegment(storageKey, encrypted, meta),
            indexMeta,
          });
          if (result.parked) {
            // Parked: the object is on local disk for later re-upload, not
            // yet in remote storage, so we deliberately do NOT write the
            // index row now (item 14 — object before index — extends to
            // "no object yet reachable" meaning "no index row yet either").
            // retryParkedSegments() writes the index row once the re-upload
            // actually lands in remote storage.
            return { skipped: false, parked: true };
          }
        }

        // Item 14: write the object first, the index row second. An
        // orphaned object (write succeeded, process died before the index
        // insert) is reclaimable by Phase 5's reconciliation; an index row
        // pointing at a missing object would make search throw on a result
        // the user can already see.
        await upsertIndexRow({
          ...indexMeta,
          storageKey,
          storageBackend: config.storageBackend,
          storageConfigSnapshot: logStorageConfigModule.logStorageConfigSnapshot(config),
        });

        return {
          skipped: false,
          storageKey,
          lines: ordered.length,
          bytes: encrypted.length,
          tsFrom: snapshot.tsFrom,
          tsTo: snapshot.tsTo,
        };
      } catch (error) {
        throw error;
      }
    })();

    buffer.flushing = run.finally(() => {
      buffer.flushing = null;
    });
    return buffer.flushing;
  }

  async function flushAll() {
    const keys = Array.from(buffers.keys());
    const results = await Promise.allSettled(keys.map((key) => flush(key)));
    return results.map((result, index) => ({
      key: keys[index],
      ...(result.status === "fulfilled"
        ? result.value
        : { skipped: true, reason: "error", error: result.reason }),
    }));
  }

  /**
   * Flush and permanently release the buffer(s) for an agent — item 5: the
   * only lifecycle event, other than shutdown, that forces a flush. Unlike
   * a normal flush (which keeps the buffer open for reattach), this stops
   * and clears the timer too, since no timer or reconnect will ever claim
   * this buffer again.
   */
  async function deleteAgent(agentId, streams = ["runtime", "gateway"]) {
    const results = [];
    for (const stream of streams) {
      const key = bufferKey(agentId, stream);
      const buffer = buffers.get(key);
      if (!buffer) continue;
      const result = await flush(key);
      clearIntervalFn(buffer.timer);
      buffers.delete(key);
      results.push({ key, ...result });
    }
    return results;
  }

  function isCapacityPaused(agentId, stream) {
    const buffer = buffers.get(bufferKey(agentId, stream));
    return Boolean(buffer && buffer.capacityPaused);
  }

  /**
   * Phase 6 item 7 (recency gap): a non-destructive read of the current
   * in-memory buffer for `(agentId, stream)`, exposed to backend-api over
   * worker.ts's internal HTTP endpoint so `searchLogs` can merge the last
   * few not-yet-flushed minutes into a search result. Deliberately does NOT
   * flush, mutate, or clear anything — a search request must never be able
   * to trigger a flush as a side effect, and the buffer must remain
   * available for the next real flush regardless of how many times this is
   * called.
   *
   * Returns `null` when no buffer is open for this (agentId, stream) pair
   * (nothing buffered right now — not an error). Otherwise returns a plain
   * snapshot: the lines as buffered so far (Phase 2 envelope, no `ord` yet
   * — Phase 6's merge sorts on `(COALESCE(ts, observed_ts), stream)`
   * exactly like it does for `ord`-bearing sealed-segment lines, so an
   * unassigned `ord` on the buffer's tail is fine, see logSearch.ts) plus
   * `tsFrom`/`tsTo` bookkeeping so the caller can apply the "storage wins
   * on overlap" rule without re-deriving it from the raw lines.
   */
  function peekBuffer(agentId, stream) {
    const buffer = buffers.get(bufferKey(agentId, stream));
    if (!buffer || buffer.lines.length === 0) return null;
    return {
      agentId: buffer.agentId,
      stream: buffer.stream,
      lines: buffer.lines.slice(),
      tsFrom: buffer.tsFrom,
      tsTo: buffer.tsTo,
    };
  }

  /**
   * Shutdown coordinator hook (Phase 3 item 6 / registerShutdownCoordinator
   * in worker.ts): stop accepting new lines and flush every open buffer.
   * The bounded deadline is enforced by the CALLER (registerShutdownCoordinator),
   * not here — this returns a plain flushAll() promise so the caller can
   * race it against a timeout.
   */
  async function shutdown() {
    shuttingDown = true;
    if (capacityPollTimer) {
      clearIntervalFn(capacityPollTimer);
      capacityPollTimer = null;
    }
    for (const buffer of buffers.values()) {
      clearIntervalFn(buffer.timer);
    }
    return flushAll();
  }

  return {
    append,
    flush,
    flushAll,
    shutdown,
    deleteAgent,
    retryParkedSegments,
    isCapacityPaused,
    peekBuffer,
  };
}

/**
 * Upload with exponential backoff; on exhaustion, park to local staging for
 * later re-upload (Phase 3 item 16). Only ever called for remote drivers —
 * see item 21 for why `local` skips this entirely.
 */
async function putWithRetryOrPark({
  storageKey,
  payload,
  config,
  retryDelaysMs,
  sleep,
  logger,
  put,
  park,
  indexMeta,
}) {
  const attempts = retryDelaysMs.length + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await put(storageKey, payload, config);
      return { parked: false };
    } catch (error) {
      lastError = error;
      if (attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }
  const parked = await park(indexMeta);
  logger.warn(
    `[segmentWriter] storage write for ${storageKey} failed after ${attempts} attempts` +
      (parked ? ", parked to local staging for later re-upload" : ", and staging is full — segment dropped") +
      `: ${lastError.message}`,
  );
  return { parked };
}

module.exports = {
  createSegmentWriter,
  assignOrd,
  buildStorageKey,
  encryptSegment,
  decryptSegment,
  loadLogEncryptionKeys,
  checkLocalCapacity,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_GLOBAL_MAX_BYTES,
  DEFAULT_CAPACITY_POLL_INTERVAL_MS,
};
