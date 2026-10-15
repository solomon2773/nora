require("tsx/cjs");

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  parseEnvDecision,
  readStoredDecision,
  readStoredState,
  stateFrom,
  resolveLogCollectionState,
  createLogCollectionGate,
} = require("./logs/logCollectionState.ts");

const row = (value) => ({ query: async () => ({ rows: [{ log_collection_enabled: value }] }) });

test("parseEnvDecision: only recognised values decide; anything else is undecided", () => {
  assert.equal(parseEnvDecision({}), undefined);
  assert.equal(parseEnvDecision({ NORA_LOG_ENABLED: "" }), undefined);
  assert.equal(parseEnvDecision({ NORA_LOG_ENABLED: "garbage" }), undefined);
  for (const v of ["true", "TRUE", " 1 ", "yes", "on"])
    assert.equal(parseEnvDecision({ NORA_LOG_ENABLED: v }), true, v);
  for (const v of ["false", "FALSE", " 0 ", "no", "off"])
    assert.equal(parseEnvDecision({ NORA_LOG_ENABLED: v }), false, v);
});

test("stateFrom: the database wins over .env, .env wins over the default, nothing set is off and undecided", () => {
  assert.deepEqual(stateFrom(true, { NORA_LOG_ENABLED: "false" }), {
    enabled: true,
    decided: true,
    source: "database",
    since: null,
  });
  assert.deepEqual(stateFrom(false, { NORA_LOG_ENABLED: "true" }), {
    enabled: false,
    decided: true,
    source: "database",
    since: null,
  });
  assert.deepEqual(stateFrom(null, { NORA_LOG_ENABLED: "true" }), {
    enabled: true,
    decided: true,
    source: "env",
    since: null,
  });
  assert.deepEqual(stateFrom(null, { NORA_LOG_ENABLED: "false" }), {
    enabled: false,
    decided: true,
    source: "env",
    since: null,
  });
  assert.deepEqual(stateFrom(null, {}), {
    enabled: false,
    decided: false,
    source: "default",
    since: null,
  });
});

test("readStoredDecision: null when unset, boolean when set, null when the column does not exist yet", async () => {
  assert.equal(await readStoredDecision({ db: row(null) }), null);
  assert.equal(await readStoredDecision({ db: row(true) }), true);
  assert.equal(await readStoredDecision({ db: row(false) }), false);
  assert.equal(await readStoredDecision({ db: { query: async () => ({ rows: [] }) } }), null);
  for (const code of ["42703", "42P01"]) {
    const err = Object.assign(new Error("missing"), { code });
    assert.equal(
      await readStoredDecision({
        db: {
          query: async () => {
            throw err;
          },
        },
      }),
      null,
      code,
    );
  }
  await assert.rejects(
    readStoredDecision({
      db: {
        query: async () => {
          throw new Error("connection lost");
        },
      },
    }),
    /connection lost/,
  );
});

test("resolveLogCollectionState combines the stored value with the environment", async () => {
  assert.deepEqual(await resolveLogCollectionState({ db: row(null), env: {} }), {
    enabled: false,
    decided: false,
    source: "default",
    since: null,
  });
  assert.deepEqual(await resolveLogCollectionState({ db: row(true), env: {} }), {
    enabled: true,
    decided: true,
    source: "database",
    since: null,
  });
});

test("gate caches for the TTL, then rereads, and invalidate forces a reread", async () => {
  let reads = 0;
  let clock = 1_000;
  const gate = createLogCollectionGate({
    resolve: async () => {
      reads += 1;
      return { enabled: reads > 1, decided: true, source: "database" };
    },
    ttlMs: 10_000,
    now: () => clock,
  });

  assert.equal(await gate.isEnabled(), false);
  assert.equal(await gate.isEnabled(), false);
  assert.equal(reads, 1, "second call within the TTL must not hit the database");

  clock += 10_001;
  assert.equal(await gate.isEnabled(), true);
  assert.equal(reads, 2);

  gate.invalidate();
  await gate.isEnabled();
  assert.equal(reads, 3);
});

test("gate shares one in-flight read between concurrent callers", async () => {
  let reads = 0;
  const gate = createLogCollectionGate({
    resolve: async () => {
      reads += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { enabled: true, decided: true, source: "env", since: null };
    },
  });
  await Promise.all([gate.isEnabled(), gate.isEnabled(), gate.isEnabled()]);
  assert.equal(reads, 1);
});

test("gate keeps the last known answer when the database read fails, instead of flapping", async () => {
  let fail = false;
  let clock = 0;
  const warnings = [];
  const gate = createLogCollectionGate({
    resolve: async () => {
      if (fail) throw new Error("db down");
      return { enabled: true, decided: true, source: "database", since: null };
    },
    ttlMs: 1_000,
    now: () => clock,
    logger: { warn: (m) => warnings.push(m) },
  });

  assert.equal(await gate.isEnabled(), true);
  fail = true;
  clock += 5_000;
  assert.equal(
    await gate.isEnabled(),
    true,
    "must keep collecting through a transient database error",
  );
  assert.equal(warnings.length, 1);
});

test("gate falls back to the env-derived state when the very first read fails", async () => {
  const gate = createLogCollectionGate({
    resolve: async () => {
      throw new Error("db down");
    },
    env: { NORA_LOG_ENABLED: "true" },
    logger: { warn() {} },
  });
  assert.deepEqual(await gate.state(), {
    enabled: true,
    decided: true,
    source: "env",
    since: null,
  });

  const undecided = createLogCollectionGate({
    resolve: async () => {
      throw new Error("db down");
    },
    env: {},
    logger: { warn() {} },
  });
  assert.equal(await undecided.isEnabled(), false);
});

test("an enabled stored decision carries 'since', so output from before it is never collected", () => {
  const at = "2026-10-01T15:44:33.000Z";
  assert.deepEqual(stateFrom(true, {}, at), {
    enabled: true,
    decided: true,
    source: "database",
    since: at,
  });
});

test("a disabled decision, an env decision, and no decision carry no 'since'", () => {
  const at = "2026-10-01T15:44:33.000Z";
  assert.equal(stateFrom(false, {}, at).since, null);
  assert.equal(stateFrom(null, { NORA_LOG_ENABLED: "true" }, at).since, null);
  assert.equal(stateFrom(null, {}, at).since, null);
});

test("readStoredState returns when the decision last changed, as an ISO string", async () => {
  const db = {
    query: async () => ({
      rows: [
        {
          log_collection_enabled: true,
          log_collection_updated_at: new Date("2026-10-01T15:44:33Z"),
        },
      ],
    }),
  };
  assert.deepEqual(await readStoredState({ db }), {
    value: true,
    updatedAt: "2026-10-01T15:44:33.000Z",
  });
  const empty = {
    query: async () => ({
      rows: [{ log_collection_enabled: null, log_collection_updated_at: null }],
    }),
  };
  assert.deepEqual(await readStoredState({ db: empty }), { value: null, updatedAt: null });
});

test("the gate exposes 'since' from the same cached state", async () => {
  const at = "2026-10-01T15:44:33.000Z";
  const gate = createLogCollectionGate({
    resolve: async () => ({ enabled: true, decided: true, source: "database", since: at }),
  });
  assert.equal(await gate.since(), at);
  const none = createLogCollectionGate({
    resolve: async () => ({ enabled: true, decided: true, source: "env", since: null }),
  });
  assert.equal(await none.since(), null);
});
