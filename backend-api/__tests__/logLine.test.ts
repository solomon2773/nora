// @ts-nocheck
const {
  parseContainerLogChunk,
  normalizeGatewayLogLine,
  inferLevel,
} = require("../../agent-runtime/lib/logLine");

const FIXED_NOW = "2026-09-06T00:00:00.000Z";
const fixedCtx = (extra = {}) => ({ now: () => FIXED_NOW, ...extra });

function dockerFrame(text, streamType = 1) {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.from([streamType, 0, 0, 0, 0, 0, 0, 0]);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("parseContainerLogChunk", () => {
  it("strips the 8-byte Docker multiplex header when present", () => {
    const chunk = dockerFrame("2026-09-06T00:00:00.000Z hello world\n");
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("hello world");
  });

  it("leaves a raw stream without the Docker header untouched", () => {
    // First byte > 2 means "no header" per the multiplex framing rule.
    const chunk = Buffer.from("2026-09-06T00:00:00.000Z raw line\n", "utf8");
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("raw line");
  });

  it("splits an RFC3339 timestamp prefix into ts and message", () => {
    const chunk = Buffer.from("2026-08-14T14:32:01.482Z tool exec failed: exit 1\n", "utf8");
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines).toHaveLength(1);
    expect(lines[0].ts).toBe("2026-08-14T14:32:01.482Z");
    expect(lines[0].ts_source).toBe("source");
    expect(lines[0].message).toBe("tool exec failed: exit 1");
    expect(lines[0].observed_ts).toBe(FIXED_NOW);
  });

  it('classifies "no errors found" as INFO, not ERROR (bug-fix regression)', () => {
    const chunk = Buffer.from("2026-09-06T00:00:00.000Z no errors found\n", "utf8");
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines[0].level).toBe("INFO");
  });

  it('classifies a JSON line with "level":"warn" as WARN regardless of body text', () => {
    const chunk = Buffer.from(
      '2026-09-06T00:00:00.000Z {"level":"warn","msg":"no errors found, all clear"}\n',
      "utf8",
    );
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines[0].level).toBe("WARN");
  });

  it("yields ts: null and ts_source: collector for an unparseable timestamp, never a fabricated ts", () => {
    const chunk = Buffer.from("not a timestamp at all, just a message\n", "utf8");
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines).toHaveLength(1);
    expect(lines[0].ts).toBeNull();
    expect(lines[0].ts_source).toBe("collector");
    expect(lines[0].observed_ts).toBe(FIXED_NOW);
    expect(lines[0].message).toBe("not a timestamp at all, just a message");
  });

  it("never assigns an ord field", () => {
    const chunk = Buffer.from(
      "2026-09-06T00:00:00.000Z line one\n2026-09-06T00:00:01.000Z line two\n",
      "utf8",
    );
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toHaveProperty("ord");
    }
  });

  it("returns an empty array for an empty chunk", () => {
    expect(parseContainerLogChunk(Buffer.alloc(0), fixedCtx())).toEqual([]);
  });

  it("handles multiple lines in one chunk, preserving encounter order", () => {
    const chunk = Buffer.from(
      "2026-09-06T00:00:00.000Z first\n2026-09-06T00:00:01.000Z second\n",
      "utf8",
    );
    const lines = parseContainerLogChunk(chunk, fixedCtx());
    expect(lines.map((l) => l.message)).toEqual(["first", "second"]);
  });
});

describe("inferLevel", () => {
  it("prefers a structured level field over substring heuristics", () => {
    expect(inferLevel("no errors found", { level: "warn" })).toBe("WARN");
  });

  it("falls back to the substring heuristic when unstructured", () => {
    expect(inferLevel("something WARN happened", undefined)).toBe("WARN");
    expect(inferLevel("plain message", undefined)).toBe("INFO");
  });
});

describe("normalizeGatewayLogLine", () => {
  it("maps fatal to ERROR", () => {
    const line = normalizeGatewayLogLine(
      { level: "fatal", msg: "boom", ts: "2026-09-06T00:00:00.000Z" },
      fixedCtx(),
    );
    expect(line.level).toBe("ERROR");
  });

  it("maps trace to DEBUG", () => {
    const line = normalizeGatewayLogLine(
      { level: "trace", msg: "fine detail", ts: "2026-09-06T00:00:00.000Z" },
      fixedCtx(),
    );
    expect(line.level).toBe("DEBUG");
  });

  it("maps error, warn, info, debug by name", () => {
    for (const [input, expected] of [
      ["error", "ERROR"],
      ["warn", "WARN"],
      ["info", "INFO"],
      ["debug", "DEBUG"],
    ]) {
      const line = normalizeGatewayLogLine({ level: input, msg: "x" }, fixedCtx());
      expect(line.level).toBe(expected);
    }
  });

  it("drops silent-level records", () => {
    const line = normalizeGatewayLogLine({ level: "silent", msg: "should not surface" }, fixedCtx());
    expect(line).toBeNull();
  });

  it("carries gateway-only correlation fields", () => {
    const line = normalizeGatewayLogLine(
      {
        level: "info",
        msg: "tool call",
        traceId: "trace-1",
        spanId: "span-1",
        sessionId: "session-1",
        channel: "cli",
      },
      fixedCtx(),
    );
    expect(line.trace_id).toBe("trace-1");
    expect(line.span_id).toBe("span-1");
    expect(line.session_id).toBe("session-1");
    expect(line.channel).toBe("cli");
  });

  it("emits ts: null / ts_source: collector for a missing or unparseable timestamp", () => {
    const line = normalizeGatewayLogLine({ level: "info", msg: "no ts" }, fixedCtx());
    expect(line.ts).toBeNull();
    expect(line.ts_source).toBe("collector");
    expect(line.observed_ts).toBe(FIXED_NOW);
  });

  it("never assigns an ord field", () => {
    const line = normalizeGatewayLogLine({ level: "info", msg: "x" }, fixedCtx());
    expect(line).not.toHaveProperty("ord");
  });
});
