// @ts-nocheck
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const protobuf = require("protobufjs");

jest.mock("../db", () => ({
  query: jest.fn(),
}));

jest.mock("../redisQueue", () => ({
  addSpanIngestJob: jest.fn().mockResolvedValue({ id: "job-1" }),
}));

const db = require("../db");
const { addSpanIngestJob } = require("../redisQueue");
const { decodeTraceRequest, mapSpanToRow, OtlpDecodeError } = require("../otlpDecode");

const INGEST_SECRET = "test-otlp-ingest-secret";

function computeExpectedKey(agentId) {
  return crypto.createHmac("sha256", INGEST_SECRET).update(String(agentId)).digest("hex");
}

function buildApp(router) {
  const app = express();
  // Deliberately NOT using express.json() here, mirroring server.ts, which
  // mounts this router before the global json body parser so the raw body
  // reaches express.raw() untouched.
  app.use("/otlp", router);
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || err.status || 500).json({ error: err.message });
  });
  return app;
}

const ReqType = protobuf
  .loadSync(path.join(__dirname, "..", "proto", "trace_service.proto"))
  .lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");

function encodeProtobuf(obj) {
  const message = ReqType.fromObject(obj);
  return Buffer.from(ReqType.encode(message).finish());
}

const TRACE_ID_HEX = "0102030405060708090a0b0c0d0e0f10";
const PARENT_SPAN_ID_HEX = "0102030405060708";
const CHILD_SPAN_ID_HEX = "1112131415161718";

function hexToB64(hex) {
  return Buffer.from(hex, "hex").toString("base64");
}

function buildSampleRequestObject({ claimedWorkspaceId = "attacker-workspace" } = {}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            // A resource attribute claiming a workspace. This must NEVER be
            // trusted for tenancy — see the core tenant-isolation test below.
            { key: "workspace_id", value: { stringValue: claimedWorkspaceId } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "openclaw" },
            spans: [
              {
                traceId: hexToB64(TRACE_ID_HEX),
                spanId: hexToB64(PARENT_SPAN_ID_HEX),
                parentSpanId: "",
                name: "openclaw.run",
                kind: 1,
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "2000000000",
                attributes: [],
                status: { code: 1 },
              },
              {
                traceId: hexToB64(TRACE_ID_HEX),
                spanId: hexToB64(CHILD_SPAN_ID_HEX),
                parentSpanId: hexToB64(PARENT_SPAN_ID_HEX),
                name: "openclaw.model.call",
                kind: 3,
                startTimeUnixNano: "1100000000",
                endTimeUnixNano: "1900000000",
                attributes: [
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                  { key: "gen_ai.system", value: { stringValue: "openai" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "45" } },
                  { key: "gen_ai.usage.cost", value: { doubleValue: 0.0123 } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("otlpDecode", () => {
  test("protobuf and JSON payloads decode to an identical normalized shape", () => {
    const requestObj = buildSampleRequestObject();
    const protobufBuffer = encodeProtobuf(requestObj);
    const jsonBuffer = Buffer.from(JSON.stringify(requestObj), "utf8");

    const fromProtobuf = decodeTraceRequest(protobufBuffer, "application/x-protobuf");
    const fromJson = decodeTraceRequest(jsonBuffer, "application/json");

    expect(fromProtobuf).toEqual(fromJson);
    expect(fromProtobuf).toHaveLength(2);
  });

  test("malformed/truncated protobuf is rejected without throwing an uncaught exception", () => {
    expect(() => decodeTraceRequest(Buffer.from([0xff, 0xff, 0xff]), "application/x-protobuf")).toThrow(
      OtlpDecodeError,
    );
  });

  test("malformed JSON body is rejected gracefully", () => {
    expect(() => decodeTraceRequest(Buffer.from("{not json"), "application/json")).toThrow(
      OtlpDecodeError,
    );
  });

  test("an unsupported content type is rejected gracefully", () => {
    expect(() => decodeTraceRequest(Buffer.from("whatever"), "text/plain")).toThrow(OtlpDecodeError);
  });
});

describe("mapSpanToRow", () => {
  test("parent/child span relationships survive into the row shape", () => {
    const requestObj = buildSampleRequestObject();
    const decoded = decodeTraceRequest(encodeProtobuf(requestObj), "application/x-protobuf");
    const agent = { id: "agent-1", workspace_id: "real-workspace" };

    const parentEntry = decoded.find((entry) => entry.span.name === "openclaw.run");
    const childEntry = decoded.find((entry) => entry.span.name === "openclaw.model.call");

    const parentRow = mapSpanToRow(parentEntry.span, parentEntry.resource, agent);
    const childRow = mapSpanToRow(childEntry.span, childEntry.resource, agent);

    expect(parentRow.parent_span_id).toBeNull();
    expect(parentRow.span_id).toBe(PARENT_SPAN_ID_HEX);
    expect(childRow.parent_span_id).toBe(PARENT_SPAN_ID_HEX);
    expect(childRow.trace_id).toBe(TRACE_ID_HEX);
  });

  test("token and cost GenAI-convention attributes map onto the correct columns", () => {
    const requestObj = buildSampleRequestObject();
    const decoded = decodeTraceRequest(encodeProtobuf(requestObj), "application/x-protobuf");
    const agent = { id: "agent-1", workspace_id: "real-workspace" };
    const childEntry = decoded.find((entry) => entry.span.name === "openclaw.model.call");

    const row = mapSpanToRow(childEntry.span, childEntry.resource, agent);

    expect(row.model).toBe("gpt-4o");
    expect(row.provider).toBe("openai");
    expect(row.tokens_in).toBe(120);
    expect(row.tokens_out).toBe(45);
    expect(row.cost_usd).toBeCloseTo(0.0123);
  });

  test("workspace_id on the row always comes from the agent, never from a resource attribute", () => {
    const requestObj = buildSampleRequestObject({ claimedWorkspaceId: "attacker-workspace" });
    const decoded = decodeTraceRequest(encodeProtobuf(requestObj), "application/x-protobuf");
    const agent = { id: "agent-1", workspace_id: "real-workspace" };
    const entry = decoded[0];

    const row = mapSpanToRow(entry.span, entry.resource, agent);

    expect(row.workspace_id).toBe("real-workspace");
    expect(row.workspace_id).not.toBe("attacker-workspace");
  });

  test("an agent with no workspace maps to a null workspace_id, not an error", () => {
    const requestObj = buildSampleRequestObject();
    const decoded = decodeTraceRequest(encodeProtobuf(requestObj), "application/x-protobuf");
    const agent = { id: "agent-1", workspace_id: null };
    const entry = decoded[0];

    const row = mapSpanToRow(entry.span, entry.resource, agent);

    expect(row.workspace_id).toBeNull();
    expect(row.agent_id).toBe("agent-1");
    expect(row.trace_id).toBeTruthy();
  });
});

describe("POST /otlp/v1/traces", () => {
  const AGENT_ID = "11111111-1111-1111-1111-111111111111";
  // Required once, at file scope: the mocked ../redisQueue and ../db module
  // instances routes/otlp.ts binds at require-time must be the SAME instances
  // this file asserts against. Re-requiring routes/otlp.ts per test via
  // jest.resetModules() would hand it fresh, disconnected mock instances.
  const router = require("../routes/otlp");
  const app = buildApp(router);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NORA_OTLP_INGEST_SECRET = INGEST_SECRET;
    delete process.env.NORA_OTLP_MAX_BODY_BYTES;
  });

  test("valid protobuf payload authenticates, decodes, and enqueues the expected spans", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ workspace_id: "real-workspace" }] });
    const body = encodeProtobuf(buildSampleRequestObject());

    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", computeExpectedKey(AGENT_ID))
      .set("Content-Type", "application/x-protobuf")
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(2);
    expect(addSpanIngestJob).toHaveBeenCalledTimes(1);
    const [job] = addSpanIngestJob.mock.calls[0];
    expect(job.agentId).toBe(AGENT_ID);
    expect(job.workspaceId).toBe("real-workspace");
    expect(job.spans).toHaveLength(2);
  });

  test("an invalid ingest key is rejected with 401", async () => {
    const body = encodeProtobuf(buildSampleRequestObject());

    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", "0".repeat(64))
      .set("Content-Type", "application/x-protobuf")
      .send(body);

    expect(res.status).toBe(401);
    expect(addSpanIngestJob).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test("a request missing the agent-id header is rejected before any decoding happens", async () => {
    // Body is intentionally garbage protobuf: if decode were ever attempted
    // it would throw a 400, not a 401. Getting 401 back proves the header
    // check ran first and short-circuited before touching the body.
    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-ingest-key", "0".repeat(64))
      .set("Content-Type", "application/x-protobuf")
      .send(Buffer.from([0xff, 0xff, 0xff]));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/x-nora-agent-id/);
    expect(addSpanIngestJob).not.toHaveBeenCalled();
  });

  test("a request missing the ingest-key header is rejected before any decoding happens", async () => {
    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("Content-Type", "application/x-protobuf")
      .send(Buffer.from([0xff, 0xff, 0xff]));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/x-nora-ingest-key/);
    expect(addSpanIngestJob).not.toHaveBeenCalled();
  });

  test("a payload whose resource claims a different workspace is still stored under the agent's real workspace", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ workspace_id: "real-workspace" }] });
    const body = encodeProtobuf(buildSampleRequestObject({ claimedWorkspaceId: "attacker-workspace" }));

    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", computeExpectedKey(AGENT_ID))
      .set("Content-Type", "application/x-protobuf")
      .send(body);

    expect(res.status).toBe(202);
    const [job] = addSpanIngestJob.mock.calls[0];
    expect(job.workspaceId).toBe("real-workspace");
    expect(job.workspaceId).not.toBe("attacker-workspace");
  });

  test("an agent belonging to no workspace authenticates successfully with a null workspace_id", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const body = encodeProtobuf(buildSampleRequestObject());

    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", computeExpectedKey(AGENT_ID))
      .set("Content-Type", "application/x-protobuf")
      .send(body);

    expect(res.status).toBe(202);
    expect(addSpanIngestJob).toHaveBeenCalledTimes(1);
    const [job] = addSpanIngestJob.mock.calls[0];
    expect(job.workspaceId).toBeNull();
  });

  test("a JSON payload authenticates and enqueues identically to the protobuf equivalent", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ workspace_id: "real-workspace" }] });
    const requestObj = buildSampleRequestObject();

    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", computeExpectedKey(AGENT_ID))
      .set("Content-Type", "application/json")
      .send(JSON.stringify(requestObj));

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(2);
  });

  test("malformed protobuf does not crash the route and is rejected with 400", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ workspace_id: "real-workspace" }] });

    const res = await request(app)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", computeExpectedKey(AGENT_ID))
      .set("Content-Type", "application/x-protobuf")
      .send(Buffer.from([0xff, 0xff, 0xff]));

    expect(res.status).toBe(400);
    expect(addSpanIngestJob).not.toHaveBeenCalled();
  });

  test("an oversized request body is rejected before decode is attempted", async () => {
    process.env.NORA_OTLP_MAX_BODY_BYTES = "64";
    jest.resetModules();
    const smallLimitRouter = require("../routes/otlp");
    const smallLimitApp = buildApp(smallLimitRouter);

    const bigBody = encodeProtobuf(buildSampleRequestObject());
    expect(bigBody.length).toBeGreaterThan(64);

    const res = await request(smallLimitApp)
      .post("/otlp/v1/traces")
      .set("x-nora-agent-id", AGENT_ID)
      .set("x-nora-ingest-key", computeExpectedKey(AGENT_ID))
      .set("Content-Type", "application/x-protobuf")
      .send(bigBody);

    expect(res.status).toBe(413);
    expect(addSpanIngestJob).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});
