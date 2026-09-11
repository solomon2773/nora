const assert = require("node:assert/strict");
const test = require("node:test");

const { drainSpanIngest, buildBatchInsert, isInsertableRow, SPAN_COLUMNS } = require("./spanDrain.ts");

function makeFakePool() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: values ? values.length / SPAN_COLUMNS.length : 0 };
    },
  };
}

function sampleSpan({
  name = "openclaw.run",
  traceIdB64 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex").toString("base64"),
  spanIdB64 = Buffer.from("0102030405060708", "hex").toString("base64"),
  parentSpanIdB64 = "",
  attributes = [],
  startNanos = "1000000000",
  endNanos = "2000000000",
} = {}) {
  return {
    traceId: traceIdB64,
    spanId: spanIdB64,
    parentSpanId: parentSpanIdB64,
    name,
    kind: "SPAN_KIND_INTERNAL",
    startTimeUnixNano: startNanos,
    endTimeUnixNano: endNanos,
    attributes,
    status: { code: "STATUS_CODE_OK" },
  };
}

const RESOURCE_CLAIMING_OTHER_WORKSPACE = {
  attributes: [{ key: "workspace_id", value: { stringValue: "attacker-workspace" } }],
};

test("drainSpanIngest batch-inserts all rows in one query", async () => {
  const pool = makeFakePool();
  const job = {
    data: {
      agentId: "agent-1",
      workspaceId: "real-workspace",
      spans: [
        { span: sampleSpan({ name: "openclaw.run" }), resource: RESOURCE_CLAIMING_OTHER_WORKSPACE },
        {
          span: sampleSpan({
            name: "openclaw.model.call",
            spanIdB64: Buffer.from("1112131415161718", "hex").toString("base64"),
            parentSpanIdB64: Buffer.from("0102030405060708", "hex").toString("base64"),
          }),
          resource: RESOURCE_CLAIMING_OTHER_WORKSPACE,
        },
      ],
    },
  };

  const result = await drainSpanIngest(job, { pool });

  assert.equal(result.inserted, 2);
  assert.equal(result.skipped, 0);
  assert.equal(pool.calls.length, 1, "expected exactly one batch INSERT, not one per row");
  assert.match(pool.calls[0].text, /^INSERT INTO agent_spans/);
  assert.equal(pool.calls[0].values.length, 2 * SPAN_COLUMNS.length);
});

test("workspace_id on every inserted row comes from the job, never from the resource's claimed workspace", async () => {
  const pool = makeFakePool();
  const job = {
    data: {
      agentId: "agent-1",
      workspaceId: "real-workspace",
      spans: [{ span: sampleSpan(), resource: RESOURCE_CLAIMING_OTHER_WORKSPACE }],
    },
  };

  await drainSpanIngest(job, { pool });

  const workspaceIdIndex = SPAN_COLUMNS.indexOf("workspace_id");
  assert.equal(pool.calls[0].values[workspaceIdIndex], "real-workspace");
});

test("an agent with no workspace persists spans with a null workspace_id", async () => {
  const pool = makeFakePool();
  const job = {
    data: {
      agentId: "agent-1",
      workspaceId: null,
      spans: [{ span: sampleSpan(), resource: { attributes: [] } }],
    },
  };

  const result = await drainSpanIngest(job, { pool });

  assert.equal(result.inserted, 1);
  const workspaceIdIndex = SPAN_COLUMNS.indexOf("workspace_id");
  assert.equal(pool.calls[0].values[workspaceIdIndex], null);
});

test("parent/child span relationships survive into the inserted rows", async () => {
  const pool = makeFakePool();
  const parentSpanIdB64 = Buffer.from("0102030405060708", "hex").toString("base64");
  const job = {
    data: {
      agentId: "agent-1",
      workspaceId: "ws-1",
      spans: [
        { span: sampleSpan({ name: "parent", spanIdB64: parentSpanIdB64 }), resource: { attributes: [] } },
        {
          span: sampleSpan({
            name: "child",
            spanIdB64: Buffer.from("2122232425262728", "hex").toString("base64"),
            parentSpanIdB64,
          }),
          resource: { attributes: [] },
        },
      ],
    },
  };

  await drainSpanIngest(job, { pool });

  const parentIdIdx = SPAN_COLUMNS.indexOf("parent_span_id");
  const rowWidth = SPAN_COLUMNS.length;
  const values = pool.calls[0].values;
  assert.equal(values[parentIdIdx], null, "root span has no parent");
  assert.equal(values[rowWidth + parentIdIdx], "0102030405060708");
});

test("token and cost GenAI attributes map onto their columns through the batch insert", async () => {
  const pool = makeFakePool();
  const job = {
    data: {
      agentId: "agent-1",
      workspaceId: "ws-1",
      spans: [
        {
          span: sampleSpan({
            attributes: [
              { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
              { key: "gen_ai.system", value: { stringValue: "openai" } },
              { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
              { key: "gen_ai.usage.output_tokens", value: { intValue: "45" } },
              { key: "gen_ai.usage.cost", value: { doubleValue: 0.05 } },
            ],
          }),
          resource: { attributes: [] },
        },
      ],
    },
  };

  await drainSpanIngest(job, { pool });

  const values = pool.calls[0].values;
  assert.equal(values[SPAN_COLUMNS.indexOf("model")], "gpt-4o");
  assert.equal(values[SPAN_COLUMNS.indexOf("provider")], "openai");
  assert.equal(values[SPAN_COLUMNS.indexOf("tokens_in")], 120);
  assert.equal(values[SPAN_COLUMNS.indexOf("tokens_out")], 45);
  assert.equal(values[SPAN_COLUMNS.indexOf("cost_usd")], 0.05);
});

test("a span missing a required column (no trace id) is skipped, not inserted, and does not crash the batch", async () => {
  const pool = makeFakePool();
  const job = {
    data: {
      agentId: "agent-1",
      workspaceId: "ws-1",
      spans: [
        { span: sampleSpan({ traceIdB64: "" }), resource: { attributes: [] } },
        { span: sampleSpan({ name: "valid-span" }), resource: { attributes: [] } },
      ],
    },
  };

  const result = await drainSpanIngest(job, { pool });

  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 1);
});

test("an empty spans array inserts nothing and does not query the database", async () => {
  const pool = makeFakePool();
  const job = { data: { agentId: "agent-1", workspaceId: "ws-1", spans: [] } };

  const result = await drainSpanIngest(job, { pool });

  assert.equal(result.inserted, 0);
  assert.equal(pool.calls.length, 0);
});

test("isInsertableRow rejects rows missing NOT NULL columns", () => {
  assert.equal(isInsertableRow(null), false);
  assert.equal(
    isInsertableRow({ trace_id: "a", span_id: "b", agent_id: "c", name: "n", started_at: null }),
    false,
  );
  assert.equal(
    isInsertableRow({
      trace_id: "a",
      span_id: "b",
      agent_id: "c",
      name: "n",
      started_at: new Date(),
    }),
    true,
  );
});

test("buildBatchInsert casts the attrs column to jsonb and JSON-encodes it", () => {
  const row = {
    trace_id: "a",
    span_id: "b",
    parent_span_id: null,
    workspace_id: null,
    agent_id: "agent-1",
    name: "n",
    kind: "internal",
    started_at: new Date("2026-01-01T00:00:00Z"),
    duration_ms: 5,
    status: "ok",
    model: null,
    provider: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    attrs: { foo: "bar" },
  };

  const { text, values } = buildBatchInsert([row]);

  assert.match(text, /::jsonb\)$/);
  const attrsIndex = SPAN_COLUMNS.indexOf("attrs");
  assert.equal(values[attrsIndex], JSON.stringify({ foo: "bar" }));
});
