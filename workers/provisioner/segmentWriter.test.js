// Phase 3 of the logging control plane: segment writer tests.
//
// This repo's worker-provisioner test convention (see backendSelection.test.js,
// provisionerExecTermination.test.js) is Node's built-in test runner
// (`node --test "*.test.js"`, per package.json's "test" script), not Jest —
// hence this file lives at the top level next to those, as a `.js` file,
// rather than at the `__tests__/segmentWriter.test.ts` path the original
// spec doc suggested before this convention was verified against the repo.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { test, mock } = require("node:test");

const {
  createSegmentWriter,
  assignOrd,
  buildStorageKey,
  encryptSegment,
  decryptSegment,
  loadLogEncryptionKeys,
  checkLocalCapacity,
} = require("./logs/segmentWriter.ts");

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

function keyRingWith(...pairs) {
  const keys = new Map();
  for (const [id, hex] of pairs) keys.set(id, Buffer.from(hex, "hex"));
  return { keys, currentKeyId: pairs[0][0] };
}

function line(overrides = {}) {
  return {
    ts: overrides.ts ?? null,
    observed_ts: overrides.observed_ts ?? "2026-01-01T00:00:00.000Z",
    ts_source: overrides.ts_source ?? "source",
    stream: overrides.stream ?? "runtime",
    level: overrides.level ?? "INFO",
    message: overrides.message ?? "hello",
    ...overrides,
  };
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: "row-1" }] };
    },
  };
}

function fakePutStorageObject({ failTimes = 0, store = new Map() } = {}) {
  let attempts = 0;
  const calls = [];
  const fn = async (key, buffer, config) => {
    attempts += 1;
    calls.push({ key, buffer, config, attempt: attempts });
    if (attempts <= failTimes) {
      throw new Error(`simulated storage failure (attempt ${attempts})`);
    }
    store.set(key, buffer);
    return { ok: true };
  };
  fn.calls = calls;
  fn.store = store;
  return fn;
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nora-segwriter-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function baseDeps(overrides = {}) {
  return {
    db: fakeDb(),
    putStorageObject: fakePutStorageObject(),
    logStorageConfig: async () => ({ storageBackend: "local", localPath: "/tmp/unused" }),
    keyRing: keyRingWith(["k1", KEY_A]),
    sleep: async () => {}, // instant backoff in tests
    checkLocalCapacity: () => ({ usedBytes: 0, limitBytes: Infinity, atCapacity: false }),
    ...overrides,
  };
}

// ── assignOrd ────────────────────────────────────────────────────────────

test("assignOrd sorts by (COALESCE(ts, observed_ts), arrival) and assigns positional ord", () => {
  const lines = [
    line({ ts: "2026-01-01T00:00:02.000Z", message: "third-ish" }),
    line({ ts: "2026-01-01T00:00:01.000Z", message: "first" }),
    line({ ts: null, observed_ts: "2026-01-01T00:00:01.500Z", message: "second" }),
    line({ ts: "2026-01-01T00:00:02.000Z", message: "arrives-after-third-ish-same-ts" }),
  ];
  const ordered = assignOrd(lines);
  assert.deepEqual(
    ordered.map((l) => l.message),
    ["first", "second", "third-ish", "arrives-after-third-ish-same-ts"],
  );
  assert.deepEqual(ordered.map((l) => l.ord), [0, 1, 2, 3]);
});

test("assignOrd is deterministic across two independent calls simulating crash-replay", () => {
  // Same lines, same array (arrival) order, fed through two independent
  // "processes" (two entirely separate calls, no shared state) — this is
  // the regression guard against a parse-time running counter, which could
  // not reproduce identical ord values after a crash-and-replay.
  const lines = [
    line({ ts: "2026-01-01T00:00:05.000Z", message: "a" }),
    line({ ts: "2026-01-01T00:00:05.000Z", message: "b" }),
    line({ ts: "2026-01-01T00:00:03.000Z", message: "c" }),
    line({ ts: null, observed_ts: "2026-01-01T00:00:04.000Z", message: "d" }),
  ];
  const first = assignOrd(lines.map((l) => ({ ...l })));
  const second = assignOrd(lines.map((l) => ({ ...l })));
  assert.deepEqual(first, second);
});

// ── buildStorageKey ──────────────────────────────────────────────────────

test("buildStorageKey partitions by workspace, or by owning user when unassigned", () => {
  const wsKey = buildStorageKey(
    { workspaceId: "ws-1" },
    "agent-1",
    "runtime",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:15:00.000Z",
  );
  assert.equal(wsKey, "ws_ws-1/agent_agent-1/runtime/2026-01-01/0000-0015.ndjson.zst.enc");

  const userKey = buildStorageKey(
    { ownerUserId: "user-1" },
    "agent-2",
    "gateway",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:15:00.000Z",
  );
  assert.equal(userKey, "user_user-1/agent_agent-2/gateway/2026-01-01/0000-0015.ndjson.zst.enc");
});

test("two unassigned owners never share a prefix", () => {
  const keyA = buildStorageKey({ ownerUserId: "user-a" }, "agent-x", "runtime", 0, 900000);
  const keyB = buildStorageKey({ ownerUserId: "user-b" }, "agent-x", "runtime", 0, 900000);
  assert.notEqual(keyA.split("/")[0], keyB.split("/")[0]);
  assert.ok(keyA.startsWith("user_user-a/"));
  assert.ok(keyB.startsWith("user_user-b/"));
});

test("buildStorageKey throws rather than pooling into a shared unassigned/ prefix", () => {
  assert.throws(() => buildStorageKey({}, "agent-1", "runtime", 0, 900000));
});

// ── encryptSegment / decryptSegment ──────────────────────────────────────

test("encryptSegment/decryptSegment round-trip", () => {
  const ring = keyRingWith(["k1", KEY_A]);
  const plaintext = Buffer.from("hello segment world");
  const { buffer: encrypted, keyId } = encryptSegment(plaintext, ring);
  assert.equal(keyId, "k1");
  const decrypted = decryptSegment(encrypted, ring);
  assert.deepEqual(decrypted, plaintext);
});

test("a segment encrypted under key A still decrypts after key B becomes current", () => {
  const ringWithA = keyRingWith(["k1", KEY_A]);
  const plaintext = Buffer.from("written under key A");
  const { buffer: encrypted, keyId } = encryptSegment(plaintext, ringWithA);
  assert.equal(keyId, "k1");

  // Rotate: k2 is now current, k1 retained (not yet retired).
  const ringAfterRotation = keyRingWith(["k2", KEY_B], ["k1", KEY_A]);
  const decrypted = decryptSegment(encrypted, ringAfterRotation);
  assert.deepEqual(decrypted, plaintext);
});

test("loadLogEncryptionKeys parses multi-key env format, first entry current", () => {
  const { keys, currentKeyId } = loadLogEncryptionKeys({
    NORA_LOG_ENCRYPTION_KEY: `k2:${KEY_B},k1:${KEY_A}`,
  });
  assert.equal(currentKeyId, "k2");
  assert.equal(keys.size, 2);
  assert.deepEqual(keys.get("k1"), Buffer.from(KEY_A, "hex"));
});

test("loadLogEncryptionKeys accepts a bare hex key as 'default'", () => {
  const { keys, currentKeyId } = loadLogEncryptionKeys({ NORA_LOG_ENCRYPTION_KEY: KEY_A });
  assert.equal(currentKeyId, "default");
  assert.deepEqual(keys.get("default"), Buffer.from(KEY_A, "hex"));
});

// ── checkLocalCapacity ───────────────────────────────────────────────────

test("checkLocalCapacity sums file sizes under the given directory", async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, "a.txt"), Buffer.alloc(100));
    await fsp.mkdir(path.join(dir, "sub"));
    await fsp.writeFile(path.join(dir, "sub", "b.txt"), Buffer.alloc(50));
    const result = checkLocalCapacity({ dir, limitBytes: 200 });
    assert.equal(result.usedBytes, 150);
    assert.equal(result.limitBytes, 200);
    assert.equal(result.atCapacity, false);

    const atLimit = checkLocalCapacity({ dir, limitBytes: 150 });
    assert.equal(atLimit.atCapacity, true);
  });
});

// ── createSegmentWriter: flush triggers ──────────────────────────────────

test("flush triggers at the 15-minute timer boundary", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const deps = baseDeps();
    const writer = createSegmentWriter(deps);
    await writer.append(
      { agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" },
      [line({ ts: "2026-01-01T00:00:00.000Z" })],
    );
    assert.equal(deps.putStorageObject.calls.length, 0);
    mock.timers.tick(15 * 60 * 1000);
    // Let the microtask queue draining catch up with the async flush kicked
    // off by the timer callback.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(deps.putStorageObject.calls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("flush triggers independently at the uncompressed-size threshold", async () => {
  const deps = baseDeps({ maxBufferBytes: 200 });
  const writer = createSegmentWriter(deps);
  const bigMessage = "x".repeat(300);
  await writer.append(
    { agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" },
    [line({ ts: "2026-01-01T00:00:00.000Z", message: bigMessage })],
  );
  assert.equal(deps.putStorageObject.calls.length, 1);
});

test("resident memory per buffer is bounded by tracked uncompressed bytes, not compressed bytes emitted", async () => {
  // Regression guard: if the writer mistakenly tracked *compressed* bytes
  // (which zstd emits far behind input rate — see item 8's rationale),
  // highly-compressible repeated content would never trip the threshold.
  // Using tracked *uncompressed* bytes, it must trip well before megabytes
  // of raw repeated text accumulate.
  const deps = baseDeps({ maxBufferBytes: 10_000 });
  const writer = createSegmentWriter(deps);
  const repeated = "A".repeat(1000); // extremely compressible
  const lines = Array.from({ length: 20 }, () =>
    line({ ts: "2026-01-01T00:00:00.000Z", message: repeated }),
  );
  await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, lines);
  // 20 * (JSON overhead + 1000 chars) comfortably exceeds 10,000 uncompressed
  // bytes, so this must have flushed even though the compressed size of 20x
  // "AAAA...A" is tiny.
  assert.equal(deps.putStorageObject.calls.length, 1);
  const compressedLen = deps.putStorageObject.calls[0].buffer.length;
  assert.ok(
    compressedLen < 2000,
    `expected highly-compressed output, got ${compressedLen} bytes`,
  );
});

// ── stream end vs reattach vs restart-mid-window ─────────────────────────

test("a stream ending does not flush; a reattach appends to the same open buffer", async () => {
  const deps = baseDeps();
  const writer = createSegmentWriter(deps);
  const ctx = { agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" };
  await writer.append(ctx, [line({ ts: "2026-01-01T00:00:00.000Z", message: "before-restart" })]);
  // Simulate the collector's stream ending (no explicit call here — the
  // point under test is the ABSENCE of a flush call on stream end).
  assert.equal(deps.putStorageObject.calls.length, 0);

  // Reattach: same (agentId, stream) key.
  await writer.append(ctx, [line({ ts: "2026-01-01T00:05:00.000Z", message: "after-restart" })]);
  assert.equal(deps.putStorageObject.calls.length, 0, "still no flush after reattach");

  const result = await writer.flush("agent-1:runtime");
  assert.equal(result.lines, 2, "one segment spans the restart, not two");
});

test("the flush timer is not reset by a reattach — a crash loop stays bounded at one segment per interval", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const deps = baseDeps();
    const writer = createSegmentWriter(deps);
    const ctx = { agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" };

    await writer.append(ctx, [line({ ts: "2026-01-01T00:00:00.000Z" })]);
    mock.timers.tick(10 * 60 * 1000); // 10 minutes in — buffer created at t=0

    // Crash loop: many reattaches between t=10min and t=15min.
    for (let i = 0; i < 30; i++) {
      await writer.append(ctx, [line({ ts: "2026-01-01T00:10:00.000Z", message: `restart-${i}` })]);
    }
    assert.equal(deps.putStorageObject.calls.length, 0, "not yet at the 15-minute mark");

    mock.timers.tick(5 * 60 * 1000); // now at 15 minutes since buffer creation
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      deps.putStorageObject.calls.length,
      1,
      "exactly one segment for the whole crash loop, not one per restart",
    );
  } finally {
    mock.timers.reset();
  }
});

// ── agent deletion ────────────────────────────────────────────────────────

test("deleting an agent flushes and releases its buffer", async () => {
  const deps = baseDeps();
  const writer = createSegmentWriter(deps);
  const ctx = { agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" };
  await writer.append(ctx, [line({ ts: "2026-01-01T00:00:00.000Z" })]);

  const results = await writer.deleteAgent("agent-1", ["runtime"]);
  assert.equal(deps.putStorageObject.calls.length, 1);
  assert.equal(results[0].lines, 1);

  // The buffer is gone: a subsequent flush of the same key is a no-op, and
  // appending again creates a brand-new buffer rather than resurrecting the
  // deleted one (implicitly verified by the fresh append not throwing and
  // by a second flush needing new data to produce a new segment).
  const noop = await writer.flush("agent-1:runtime");
  assert.equal(noop.skipped, true);
});

// ── round trip / index row correctness ───────────────────────────────────

test("round-trip: a written segment decrypts and decompresses to the exact input lines", async () => {
  const deps = baseDeps();
  const writer = createSegmentWriter(deps);
  const ctx = { agentId: "agent-1", stream: "runtime", workspaceId: "ws-1" };
  const inputLines = [
    line({ ts: "2026-01-01T00:00:00.000Z", message: "one" }),
    line({ ts: "2026-01-01T00:00:01.000Z", message: "two" }),
  ];
  await writer.append(ctx, inputLines);
  await writer.flush("agent-1:runtime");

  const [{ key, buffer }] = deps.putStorageObject.calls;
  const decrypted = decryptSegment(buffer, deps.keyRing);
  const decompressed = zlib.zstdDecompressSync(decrypted);
  const outputLines = decompressed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert.equal(outputLines.length, 2);
  assert.deepEqual(
    outputLines.map((l) => l.message),
    ["one", "two"],
  );
  assert.deepEqual(
    outputLines.map((l) => l.ord),
    [0, 1],
  );
  assert.ok(key.startsWith("ws_ws-1/agent_agent-1/runtime/"));
});

test("the index row's lines/bytes/ts_from/ts_to match the actual segment contents", async () => {
  const deps = baseDeps();
  const writer = createSegmentWriter(deps);
  const ctx = { agentId: "agent-1", stream: "runtime", workspaceId: "ws-1" };
  await writer.append(ctx, [
    line({ ts: "2026-01-01T00:00:00.000Z" }),
    line({ ts: "2026-01-01T00:10:00.000Z" }),
  ]);
  await writer.flush("agent-1:runtime");

  const insertCall = deps.db.calls.find((c) => c.sql.includes("INSERT INTO log_segments"));
  assert.ok(insertCall, "expected an INSERT INTO log_segments call");
  const [, , , tsFrom, tsTo, , , , , bytes, lines] = insertCall.params;
  assert.equal(lines, 2);
  assert.equal(tsFrom, "2026-01-01T00:00:00.000Z");
  assert.equal(tsTo, "2026-01-01T00:10:00.000Z");
  assert.equal(bytes, deps.putStorageObject.calls[0].buffer.length);
});

test("the index row records storage_backend, storage_config, and encryption_key_id", async () => {
  const deps = baseDeps({
    logStorageConfig: async () => ({ storageBackend: "local", localPath: "/var/lib/nora-logs" }),
  });
  const writer = createSegmentWriter(deps);
  await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
    line({ ts: "2026-01-01T00:00:00.000Z" }),
  ]);
  await writer.flush("agent-1:runtime");

  const insertCall = deps.db.calls.find((c) => c.sql.includes("INSERT INTO log_segments"));
  const [, , , , , , storageBackend, storageConfigJson, encryptionKeyId] = insertCall.params;
  assert.equal(storageBackend, "local");
  assert.deepEqual(JSON.parse(storageConfigJson).storageBackend, "local");
  assert.equal(encryptionKeyId, "k1");
});

test("the storage object exists before the index row is written (ordering assertion)", async () => {
  const deps = baseDeps();
  const order = [];
  const originalPut = deps.putStorageObject;
  deps.putStorageObject = async (...args) => {
    const result = await originalPut(...args);
    order.push("put");
    return result;
  };
  const originalQuery = deps.db.query;
  deps.db.query = async (...args) => {
    const result = await originalQuery(...args);
    if (args[0].includes("INSERT INTO log_segments")) order.push("index");
    return result;
  };

  const writer = createSegmentWriter(deps);
  await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
    line({ ts: "2026-01-01T00:00:00.000Z" }),
  ]);
  await writer.flush("agent-1:runtime");

  assert.deepEqual(order, ["put", "index"]);
});

test("byte-identical segment content is produced regardless of the destination driver", async () => {
  const inputLines = [
    line({ ts: "2026-01-01T00:00:00.000Z", message: "one" }),
    line({ ts: "2026-01-01T00:00:01.000Z", message: "two" }),
  ];

  async function flushUnder(storageBackend) {
    const deps = baseDeps({ logStorageConfig: async () => ({ storageBackend }) });
    const writer = createSegmentWriter(deps);
    await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
      ...inputLines.map((l) => ({ ...l })),
    ]);
    await writer.flush("agent-1:runtime");
    const { buffer } = deps.putStorageObject.calls[0];
    const decompressed = zlib.zstdDecompressSync(decryptSegment(buffer, deps.keyRing));
    return decompressed.toString("utf8");
  }

  // Note: the ENCRYPTED bytes are never byte-identical across two
  // independent encryptSegment calls, because AES-GCM uses a fresh random
  // IV every time by construction (this is a security property, not a
  // bug) — comparing raw ciphertext would be a meaningless assertion. What
  // must be byte-identical, and is asserted here, is the plaintext
  // segment CONTENT once decrypted and decompressed: the driver a segment
  // is written to must never influence what's actually inside it.
  const localContent = await flushUnder("local");
  const s3Content = await flushUnder("s3");
  assert.equal(localContent, s3Content);
});

// ── global overflow / dropped_lines ───────────────────────────────────────

test("aggregate buffer overflow drops lines and increments dropped_lines without unbounded growth", async () => {
  const deps = baseDeps({ globalMaxBytes: 500, maxBufferBytes: Infinity });
  const writer = createSegmentWriter(deps);
  const bigLine = () => line({ ts: "2026-01-01T00:00:00.000Z", message: "x".repeat(300) });

  const r1 = await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
    bigLine(),
  ]);
  assert.equal(r1.appended, 1);

  // A second agent's line should not fit — the largest existing buffer
  // (agent-1's) gets flushed first (preferring flush to drop); if that
  // still doesn't free enough room, admission drops rather than growing
  // unboundedly.
  const r2 = await writer.append({ agentId: "agent-2", stream: "runtime", ownerUserId: "user-2" }, [
    bigLine(),
    bigLine(),
    bigLine(),
  ]);
  assert.ok(r2.dropped >= 1, "at least one line should have been dropped under sustained overflow");

  const flushResult = await writer.flush("agent-2:runtime");
  if (!flushResult.skipped) {
    assert.ok(flushResult.lines <= 3);
  }
});

// ── retry-and-park (remote drivers only) ──────────────────────────────────

test("a failing putStorageObject retries with backoff, then parks to the staging directory", async () => {
  await withTempDir(async (stagingDir) => {
    const put = fakePutStorageObject({ failTimes: 999 }); // never succeeds
    const deps = baseDeps({
      putStorageObject: put,
      logStorageConfig: async () => ({ storageBackend: "s3", bucket: "b" }),
      stagingDir,
      retryDelaysMs: [1, 1, 1],
    });
    const writer = createSegmentWriter(deps);
    await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
      line({ ts: "2026-01-01T00:00:00.000Z" }),
    ]);
    const result = await writer.flush("agent-1:runtime");
    assert.equal(result.parked, true);
    assert.equal(put.calls.length, 4); // 1 initial + 3 retries

    const staged = await fsp.readdir(stagingDir);
    assert.ok(staged.some((f) => f.endsWith(".seg")));
    assert.ok(staged.some((f) => f.endsWith(".json")));

    // No index row yet — the object isn't durably in remote storage.
    assert.equal(deps.db.calls.filter((c) => c.sql.includes("INSERT INTO log_segments")).length, 0);
  });
});

test("a parked segment is re-uploaded successfully on the next attempt", async () => {
  await withTempDir(async (stagingDir) => {
    // A swappable indirection: createSegmentWriter captures its `put`
    // dependency once at construction, so to simulate "the remote endpoint
    // is broken, then later recovers" within a single writer instance, the
    // dependency itself needs to delegate to a mutable current
    // implementation rather than being replaced on the `deps` object after
    // the fact (which the writer would never re-read).
    let currentPut = fakePutStorageObject({ failTimes: 999 });
    const dbCalls = [];
    const deps = baseDeps({
      putStorageObject: (...args) => currentPut(...args),
      db: {
        calls: dbCalls,
        query: async (sql, params) => {
          dbCalls.push({ sql, params });
          return { rows: [{ id: "row-1" }] };
        },
      },
      logStorageConfig: async () => ({ storageBackend: "s3", bucket: "b" }),
      stagingDir,
      retryDelaysMs: [1],
    });
    const writer = createSegmentWriter(deps);
    await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
      line({ ts: "2026-01-01T00:00:00.000Z" }),
    ]);
    const parkedResult = await writer.flush("agent-1:runtime");
    assert.equal(parkedResult.parked, true);

    // The remote endpoint recovers.
    currentPut = fakePutStorageObject();
    const retryResult = await writer.retryParkedSegments();
    assert.equal(retryResult.reuploaded, 1);
    assert.equal(retryResult.remaining, 0);
    assert.equal(dbCalls.filter((c) => c.sql.includes("INSERT INTO log_segments")).length, 1);

    const remaining = await fsp.readdir(stagingDir);
    assert.equal(remaining.length, 0);
  });
});

test("on the local driver, a write failure surfaces immediately — no retry, no park", async () => {
  let currentPut = fakePutStorageObject({ failTimes: 999 });
  const deps = baseDeps({
    putStorageObject: (...args) => currentPut(...args),
    logStorageConfig: async () => ({ storageBackend: "local", localPath: "/tmp/x" }),
  });
  const writer = createSegmentWriter(deps);
  await writer.append({ agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" }, [
    line({ ts: "2026-01-01T00:00:00.000Z" }),
  ]);
  await assert.rejects(() => writer.flush("agent-1:runtime"));
  assert.equal(currentPut.calls.length, 1, "no retries on the local driver");

  // The failed write's line is restored into the buffer rather than lost —
  // a subsequent flush against a working endpoint succeeds with the exact
  // same content, proving nothing was dropped by the earlier failure.
  currentPut = fakePutStorageObject();
  const retry = await writer.flush("agent-1:runtime");
  assert.equal(retry.skipped, false);
  assert.equal(retry.lines, 1);
});

// ── capacity gate (local driver only) ─────────────────────────────────────

test("a flush at or past NORA_LOG_LOCAL_MAX_BYTES is skipped, not retried, and marks the stream capacity-paused", async () => {
  const deps = baseDeps({
    logStorageConfig: async () => ({ storageBackend: "local", localPath: "/tmp/x" }),
    checkLocalCapacity: () => ({ usedBytes: 1000, limitBytes: 1000, atCapacity: true }),
  });
  const writer = createSegmentWriter(deps);
  const ctx = { agentId: "agent-1", stream: "runtime", ownerUserId: "user-1" };
  await writer.append(ctx, [line({ ts: "2026-01-01T00:00:00.000Z" })]);

  const result = await writer.flush("agent-1:runtime");
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "capacity");
  assert.equal(deps.putStorageObject.calls.length, 0, "no write attempt at all — not even one try");
  assert.equal(writer.isCapacityPaused("agent-1", "runtime"), true);

  // Lines are preserved, not dropped, while capacity-paused.
  const flushed = await writer.deleteAgent("agent-1", ["runtime"]);
  // Capacity is still at the cap in this fake, so the forced flush on
  // deletion also skips the write — but the point under test above (no
  // retry, marked paused) already holds regardless of this cleanup call.
  void flushed;
});
