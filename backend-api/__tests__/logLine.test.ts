// @ts-nocheck
const {
  parseContainerLogChunk,
  createLogChunkStreamParser,
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

// ── createLogChunkStreamParser ───────────────────────────────────────────
// A live stream's `data` chunks split at arbitrary byte offsets — unlike
// the fixtures above, which are always one complete, self-contained chunk.
// These regression-guard the bug reported against real agent traffic: a
// stray `�` appearing right before a Docker-emitted RFC3339 timestamp,
// because the byte(s) straddling a chunk split got corrupted by decoding
// each chunk independently instead of carrying partial state forward.

describe("createLogChunkStreamParser", () => {
  it("behaves like parseContainerLogChunk for a single self-contained chunk", () => {
    const chunk = dockerFrame("2026-09-06T00:00:00.000Z hello world\n");
    const parser = createLogChunkStreamParser(fixedCtx());
    const lines = parser.push(chunk);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("hello world");
    expect(lines[0].ts).toBe("2026-09-06T00:00:00.000Z");
  });

  it("reassembles a multi-byte UTF-8 character split across two chunks (raw, non-multiplexed stream)", () => {
    // U+1F525 "🔥" is 4 bytes in UTF-8. This deliberately uses a *raw*
    // (non-Docker-framed) buffer, not `dockerFrame(...)`: inside a framed
    // stream the whole frame payload gets reassembled via `Buffer.concat`
    // before it's ever decoded, so splitting a multi-byte character across
    // two *frame* pushes wouldn't actually exercise the StringDecoder path.
    // A raw stream (Kubernetes, Proxmox journalctl, or a demuxed-upstream
    // remote Docker) has no such reassembly — `decoder.write()` is called
    // directly on each split chunk, which is the actual failure mode a
    // TCP/pipe `data` event boundary can hit.
    const full = Buffer.from("2026-09-06T00:00:00.000Z on 🔥 now\n", "utf8");
    const splitAt = full.length - 6; // lands inside the emoji's byte sequence
    const parser = createLogChunkStreamParser(fixedCtx());

    const first = parser.push(full.subarray(0, splitAt));
    expect(first).toHaveLength(0); // no newline seen yet — nothing to emit

    const lines = parser.push(full.subarray(splitAt));
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("on 🔥 now");
    expect(lines[0].message).not.toContain("�");
  });

  it("reassembles a Docker frame header split across two chunks", () => {
    const full = dockerFrame("2026-09-06T00:00:00.000Z split header\n");
    const parser = createLogChunkStreamParser(fixedCtx());

    const first = parser.push(full.subarray(0, 4)); // header cut mid-length-prefix
    expect(first).toHaveLength(0);

    const lines = parser.push(full.subarray(4));
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("split header");
  });

  it("reassembles a Docker frame payload split across two chunks", () => {
    const full = dockerFrame("2026-09-06T00:00:00.000Z split payload here\n");
    const splitAt = full.length - 10;
    const parser = createLogChunkStreamParser(fixedCtx());

    parser.push(full.subarray(0, splitAt));
    const lines = parser.push(full.subarray(splitAt));
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("split payload here");
  });

  it("holds a line with no trailing newline until the rest arrives", () => {
    const parser = createLogChunkStreamParser(fixedCtx());
    const first = parser.push(dockerFrame("2026-09-06T00:00:00.000Z partial "));
    expect(first).toHaveLength(0);

    const lines = parser.push(dockerFrame("line\n"));
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("partial line");
  });

  it("flush() emits a trailing line that never got a terminating newline", () => {
    const parser = createLogChunkStreamParser(fixedCtx());
    const midStream = parser.push(dockerFrame("2026-09-06T00:00:00.000Z first\n2026-09-06T00:00:01.000Z unterminated"));
    expect(midStream).toHaveLength(1);
    expect(midStream[0].message).toBe("first");

    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].message).toBe("unterminated");
  });

  it("flush() is a no-op when the stream ended cleanly on a newline", () => {
    const parser = createLogChunkStreamParser(fixedCtx());
    parser.push(dockerFrame("2026-09-06T00:00:00.000Z clean\n"));
    expect(parser.flush()).toHaveLength(0);
  });

  it("decides demux-vs-raw once, from the first chunk, and applies it for the rest of the stream", () => {
    // A raw (non-multiplexed) stream whose first line's bytes happen not to
    // look like a frame header — subsequent chunks must not be misread as
    // framed just because a later chunk's leading bytes happen to match.
    const parser = createLogChunkStreamParser(fixedCtx());
    const raw1 = Buffer.from("2026-09-06T00:00:00.000Z raw one\n", "utf8");
    const lines1 = parser.push(raw1);
    expect(lines1).toHaveLength(1);
    expect(lines1[0].message).toBe("raw one");

    const raw2 = Buffer.from("2026-09-06T00:00:01.000Z raw two\n", "utf8");
    const lines2 = parser.push(raw2);
    expect(lines2).toHaveLength(1);
    expect(lines2[0].message).toBe("raw two");
  });
});
