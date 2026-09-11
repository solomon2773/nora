// Phase 10 of the logging control plane: gateway log collector tests.
//
// Follows this package's established convention (logCollector.test.js /
// segmentWriter.test.js) — Node's built-in test runner, fakes/mocks passed
// in via `deps` rather than module-level mocking, deterministic (no real
// timers: pollAgentGatewayLogs/reconcileStreams are called directly rather
// than waiting on any real interval).
const assert = require("node:assert/strict");
const test = require("node:test");

// gatewayCollector.ts pulls in agent-runtime/lib/*.ts files whose own
// internal requires are extensionless TS files — fine under `tsx` (this
// package's real runtime) but not plain Node's resolver. Registering tsx's
// require hook makes this require exactly what `tsx worker.ts` does in
// production (same fix logCollector.test.js uses for the same reason).
require("tsx/cjs");

const {
  createGatewayCollector,
  pollAgentGatewayLogs,
  splitRunsOnMetaRecords,
  computeNextPollStep,
  resolveGatewayLogsEnabled,
  GATEWAY_STREAM,
  POLL_BACKOFF_STEPS_MS,
  DEFAULT_SOURCE_KIND,
} = require("./logs/gatewayCollector.ts");
const { redactLine, redactText } = require("./logs/redaction.ts");

// ── Fakes ──────────────────────────────────────────────────────────────

function agentRow(overrides = {}) {
  return {
    id: "agent-1",
    user_id: "user-1",
    container_id: "container-1",
    status: "running",
    backend_type: "docker",
    deploy_target: "docker",
    execution_target_id: "docker",
    runtime_family: "openclaw",
    sandbox_profile: "standard",
    host: "127.0.0.1",
    runtime_host: "127.0.0.1",
    runtime_port: 9090,
    gateway_host: "127.0.0.1",
    gateway_port: 18789,
    gateway_token: "encrypted-token",
    ...overrides,
  };
}

/**
 * Minimal fake db backing `agent_log_cursors` and `workspace_log_settings`
 * queries, plus whatever extra dispatch a test needs to add.
 */
function fakeDb({ cursors = new Map(), gatewaySettings = new Map(), extra = null } = {}) {
  const calls = [];
  return {
    calls,
    cursors,
    gatewaySettings,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT cursor FROM agent_log_cursors/.test(sql)) {
        const [agentId, sourceKind] = params;
        const value = cursors.get(`${agentId}:${sourceKind}`);
        return { rows: value !== undefined ? [{ cursor: value }] : [] };
      }
      if (/INSERT INTO agent_log_cursors/.test(sql)) {
        const [agentId, sourceKind, cursor] = params;
        cursors.set(`${agentId}:${sourceKind}`, cursor);
        return { rows: [] };
      }
      if (/FROM workspace_log_settings WHERE workspace_id/.test(sql)) {
        const [workspaceId] = params;
        const enabled = gatewaySettings.get(workspaceId);
        return { rows: enabled === undefined ? [] : [{ gateway_logs_enabled: enabled }] };
      }
      if (extra) {
        const handled = extra(sql, params);
        if (handled) return handled;
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    },
  };
}

function fakeSegmentWriter() {
  const appendCalls = [];
  const flushCalls = [];
  const buffered = new Map(); // bufferKey -> lines[]
  return {
    appendCalls,
    flushCalls,
    buffered,
    async append(agentCtx, lines) {
      appendCalls.push({ agentCtx, lines });
      const key = `${agentCtx.agentId}:${agentCtx.stream}`;
      buffered.set(key, (buffered.get(key) || []).concat(lines));
      return { appended: lines.length, dropped: 0 };
    },
    async flush(key) {
      flushCalls.push(key);
      const flushed = buffered.get(key) || [];
      buffered.set(key, []);
      return { skipped: false, lines: flushed.length };
    },
  };
}

function fakeGatewayClient(responses) {
  // responses: array of { lines, cursor, sourceKind } consumed in order.
  let i = 0;
  const calls = [];
  return {
    calls,
    async call() {
      throw new Error("not used directly in these tests");
    },
    close() {},
    _next() {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      calls.push(r);
      return r;
    },
  };
}

function fakeCallLogsTail(client) {
  return async () => client._next();
}

function recentTs(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

async function alwaysAllowRetention() {
  return 30; // days — generous, nothing filtered unless a test overrides it
}

// ── Tests ──────────────────────────────────────────────────────────────

test("cursor persists across a simulated worker restart: no duplicate lines, no gap", async () => {
  const db = fakeDb();
  const segmentWriter = fakeSegmentWriter();
  const agent = agentRow();
  const tenant = { workspaceId: "ws-1", ownerUserId: null };

  const batch1 = [{ level: "info", msg: "line one", ts: recentTs(0) }];
  const batch2 = [{ level: "info", msg: "line two", ts: recentTs(1) }];

  // "Process 1": poll once, persist cursor after flush.
  const client1 = fakeGatewayClient([{ lines: batch1, cursor: "cursor-A", sourceKind: "file" }]);
  const cursorState1 = { currentSourceKind: DEFAULT_SOURCE_KIND, sourceCursors: new Map() };
  await pollAgentGatewayLogs(agent, cursorState1, {
    db,
    client: client1,
    callLogsTail: fakeCallLogsTail(client1),
    segmentWriter,
    tenant,
    resolveLogRetention: alwaysAllowRetention,
    logger: silentLogger(),
  });

  assert.equal(db.cursors.get("agent-1:file"), "cursor-A");
  assert.equal(segmentWriter.appendCalls.length, 1);
  assert.equal(segmentWriter.appendCalls[0].lines[0].message, "line one");

  // "Process 2" (simulated restart): brand-new cursorState, must re-derive
  // the persisted cursor from `db` rather than starting from null.
  const client2 = fakeGatewayClient([{ lines: batch2, cursor: "cursor-B", sourceKind: "file" }]);
  const cursorState2 = { currentSourceKind: DEFAULT_SOURCE_KIND, sourceCursors: new Map() };
  await pollAgentGatewayLogs(agent, cursorState2, {
    db,
    client: client2,
    callLogsTail: fakeCallLogsTail(client2),
    segmentWriter,
    tenant,
    resolveLogRetention: alwaysAllowRetention,
    logger: silentLogger(),
  });

  // The second poll must have been issued WITH the persisted cursor from
  // the first process, not from scratch.
  assert.equal(client2.calls.length, 1);
  assert.equal(db.cursors.get("agent-1:file"), "cursor-B");

  // No duplicate: batch2's "line two" is the only new line appended in the
  // second poll; "line one" was not re-appended.
  assert.equal(segmentWriter.appendCalls.length, 2);
  assert.equal(segmentWriter.appendCalls[1].lines[0].message, "line two");
});

test("a source-kind transition (meta record) resets/updates the cursor for that kind only", async () => {
  const db = fakeDb({ cursors: new Map([["agent-1:file", "old-file-cursor"]]) });
  const segmentWriter = fakeSegmentWriter();
  const agent = agentRow();
  const tenant = { workspaceId: null, ownerUserId: "user-1" };

  const records = [
    { level: "info", msg: "still in file", ts: recentTs(0) },
    { type: "meta", sourceKind: "journal" },
    { level: "info", msg: "now in journal", ts: recentTs(1) },
  ];
  const client = fakeGatewayClient([{ lines: records, cursor: "journal-cursor-1", sourceKind: "journal" }]);
  const cursorState = { currentSourceKind: "file", sourceCursors: new Map() };

  const result = await pollAgentGatewayLogs(agent, cursorState, {
    db,
    client,
    callLogsTail: fakeCallLogsTail(client),
    segmentWriter,
    tenant,
    resolveLogRetention: alwaysAllowRetention,
    logger: silentLogger(),
  });

  assert.equal(result.appended, 2, "both lines around the transition must be written, none dropped");
  // The NEW kind's cursor was updated...
  assert.equal(db.cursors.get("agent-1:journal"), "journal-cursor-1");
  // ...and the OLD kind's cursor was left untouched.
  assert.equal(db.cursors.get("agent-1:file"), "old-file-cursor");
  assert.equal(cursorState.currentSourceKind, "journal");
});

test("log rotation occurring mid-poll does not drop any lines", async () => {
  // Simulate rotation as a meta record with no explicit sourceKind (the
  // response as a whole still reports "file" — i.e. rotated to a new file,
  // same kind) splitting one poll's batch into two runs.
  const db = fakeDb();
  const segmentWriter = fakeSegmentWriter();
  const agent = agentRow();
  const tenant = { workspaceId: "ws-1", ownerUserId: null };

  const records = [
    { level: "info", msg: "pre-rotation line 1", ts: recentTs(0) },
    { level: "info", msg: "pre-rotation line 2", ts: recentTs(1) },
    { type: "meta" },
    { level: "info", msg: "post-rotation line 1", ts: recentTs(2) },
    { level: "info", msg: "post-rotation line 2", ts: recentTs(3) },
  ];
  const client = fakeGatewayClient([{ lines: records, cursor: "post-rotation-cursor", sourceKind: "file" }]);
  const cursorState = { currentSourceKind: "file", sourceCursors: new Map() };

  const result = await pollAgentGatewayLogs(agent, cursorState, {
    db,
    client,
    callLogsTail: fakeCallLogsTail(client),
    segmentWriter,
    tenant,
    resolveLogRetention: alwaysAllowRetention,
    logger: silentLogger(),
  });

  assert.equal(result.appended, 4);
  const messages = segmentWriter.appendCalls[0].lines.map((l) => l.message);
  assert.deepEqual(messages, [
    "pre-rotation line 1",
    "pre-rotation line 2",
    "post-rotation line 1",
    "post-rotation line 2",
  ]);
});

test("adaptive poll interval backs off when idle and recovers immediately on the next non-empty response", () => {
  let state = { stepIndex: 0, delayMs: POLL_BACKOFF_STEPS_MS[0] };

  // Three consecutive empty polls: step forward each time.
  state = computeNextPollStep(state.stepIndex, false);
  assert.equal(state.delayMs, POLL_BACKOFF_STEPS_MS[1]);
  state = computeNextPollStep(state.stepIndex, false);
  assert.equal(state.delayMs, POLL_BACKOFF_STEPS_MS[2]);
  state = computeNextPollStep(state.stepIndex, false);
  assert.equal(state.delayMs, POLL_BACKOFF_STEPS_MS[3]);

  // A non-empty response snaps straight back to the fastest step.
  state = computeNextPollStep(state.stepIndex, true);
  assert.equal(state.delayMs, POLL_BACKOFF_STEPS_MS[0]);
  assert.equal(state.stepIndex, 0);

  // Backoff never exceeds the slowest configured step.
  let idx = 0;
  for (let i = 0; i < POLL_BACKOFF_STEPS_MS.length + 5; i += 1) {
    const next = computeNextPollStep(idx, false);
    idx = next.stepIndex;
  }
  assert.equal(idx, POLL_BACKOFF_STEPS_MS.length - 1);
});

test("trace_id, span_id, session_id, and channel survive normalization into the written segment", async () => {
  const db = fakeDb();
  const segmentWriter = fakeSegmentWriter();
  const agent = agentRow();
  const tenant = { workspaceId: "ws-1", ownerUserId: null };

  const record = {
    level: "info",
    msg: "hello with context",
    ts: recentTs(0),
    traceId: "trace-123",
    spanId: "span-456",
    sessionId: "session-789",
    channel: "whatsapp",
  };
  const client = fakeGatewayClient([{ lines: [record], cursor: "c1", sourceKind: "file" }]);
  const cursorState = { currentSourceKind: "file", sourceCursors: new Map() };

  await pollAgentGatewayLogs(agent, cursorState, {
    db,
    client,
    callLogsTail: fakeCallLogsTail(client),
    segmentWriter,
    tenant,
    resolveLogRetention: alwaysAllowRetention,
    logger: silentLogger(),
  });

  const written = segmentWriter.appendCalls[0].lines[0];
  assert.equal(written.trace_id, "trace-123");
  assert.equal(written.span_id, "span-456");
  assert.equal(written.session_id, "session-789");
  assert.equal(written.channel, "whatsapp");
  assert.equal(written.stream, GATEWAY_STREAM);
});

test("redaction masks a known secret pattern in a message body", () => {
  const line = { message: 'starting up with apiKey="sk-abcdefghijklmnopqrstuvwxyz123456"' };
  const redacted = redactLine(line);
  assert.ok(!redacted.message.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(redacted.message.includes("[REDACTED]"));

  // A generic config-dump-style leak (the config.get gap named in the spec):
  // key name preserved, value masked.
  const configLeak = redactText('config dump: "api_key": "aVeryLongSecretValue1234567890"');
  assert.ok(!configLeak.includes("aVeryLongSecretValue1234567890"));
  assert.ok(configLeak.includes("api_key"));
  assert.ok(configLeak.includes("[REDACTED]"));

  // Bearer token.
  const bearer = redactText("Authorization: Bearer abcdef1234567890ghijklmnop");
  assert.ok(!bearer.includes("abcdef1234567890ghijklmnop"));

  // Plain, non-secret text is left untouched.
  const benign = redactText("agent started successfully on port 9090");
  assert.equal(benign, "agent started successfully on port 9090");
});

test("a Hermes agent (non-OpenClaw runtime family) is skipped entirely, without throwing or logging an error", async () => {
  const hermesAgent = agentRow({ id: "agent-hermes", runtime_family: "hermes" });
  const db = fakeDb({ extra: (sql) => {
    if (/FROM agents\s+WHERE status IN/.test(sql)) {
      return { rows: [hermesAgent] };
    }
    return null;
  } });
  const segmentWriter = fakeSegmentWriter();

  let warnedOrErrored = false;
  const logger = {
    log: () => {},
    warn: () => {
      warnedOrErrored = true;
    },
    error: () => {
      warnedOrErrored = true;
    },
  };

  const collector = createGatewayCollector({
    db,
    segmentWriter,
    logger,
    resolveTenantForAgent: async () => ({ workspaceId: null, ownerUserId: "user-1" }),
    applyConsoleLevelConfig: async () => {
      throw new Error("must never be called for a Hermes agent");
    },
    createGatewayClient: () => {
      throw new Error("must never open a gateway client for a Hermes agent");
    },
  });

  await assert.doesNotReject(() => collector.reconcileStreams());
  assert.equal(collector.heldAgentCount(), 0);
  assert.equal(warnedOrErrored, false);
});

test("a line whose timestamp is already older than the resolved retention window is dropped rather than written", async () => {
  const db = fakeDb();
  const segmentWriter = fakeSegmentWriter();
  const agent = agentRow();
  const tenant = { workspaceId: "ws-1", ownerUserId: null };

  const staleTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
  const freshTs = new Date().toISOString();
  const records = [
    { level: "info", msg: "stale line", ts: staleTs },
    { level: "info", msg: "fresh line", ts: freshTs },
  ];
  const client = fakeGatewayClient([{ lines: records, cursor: "c1", sourceKind: "file" }]);
  const cursorState = { currentSourceKind: "file", sourceCursors: new Map() };

  const result = await pollAgentGatewayLogs(agent, cursorState, {
    db,
    client,
    callLogsTail: fakeCallLogsTail(client),
    segmentWriter,
    tenant,
    resolveLogRetention: async () => 30, // 30-day retention — the stale line is well past it
    logger: silentLogger(),
  });

  assert.equal(result.dropped, 1);
  assert.equal(result.appended, 1);
  assert.equal(segmentWriter.appendCalls[0].lines.length, 1);
  assert.equal(segmentWriter.appendCalls[0].lines[0].message, "fresh line");
  // The cursor still advances even though a line was dropped, so the stale
  // backlog is never reprocessed on the next poll.
  assert.equal(db.cursors.get("agent-1:file"), "c1");
});

test("an agent found without consoleLevel:warn already applied has it applied by the 30s reconcile loop, not only at provisioning", async () => {
  const agent = agentRow();
  const db = fakeDb({ extra: (sql) => {
    if (/FROM agents\s+WHERE status IN/.test(sql)) {
      return { rows: [agent] };
    }
    return null;
  } });
  const segmentWriter = fakeSegmentWriter();

  const consoleLevelCalls = [];
  const collector = createGatewayCollector({
    db,
    segmentWriter,
    logger: silentLogger(),
    resolveTenantForAgent: async () => ({ workspaceId: null, ownerUserId: "user-1" }),
    resolveLogRetention: alwaysAllowRetention,
    applyConsoleLevelConfig: async (a) => {
      consoleLevelCalls.push(a.id);
    },
    createGatewayClient: () => fakeGatewayClient([{ lines: [], cursor: null, sourceKind: "file" }]),
  });

  // This is not "provisioning" — it's a plain reconcile tick against an
  // agent that already exists and was never told about this feature.
  await collector.reconcileStreams();

  assert.deepEqual(consoleLevelCalls, ["agent-1"]);
});

test("splitRunsOnMetaRecords with no meta records returns a single run attributed to the response's sourceKind", () => {
  const records = [{ msg: "a" }, { msg: "b" }];
  const runs = splitRunsOnMetaRecords(records, "file", "file");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sourceKind, "file");
  assert.equal(runs[0].records.length, 2);
});

test("resolveGatewayLogsEnabled falls back to true when no workspace_log_settings row exists", async () => {
  const db = fakeDb();
  const enabledNoWorkspace = await resolveGatewayLogsEnabled({ workspaceId: null }, { db });
  assert.equal(enabledNoWorkspace, true);

  const enabledNoRow = await resolveGatewayLogsEnabled({ workspaceId: "ws-missing" }, { db });
  assert.equal(enabledNoRow, true);
});

test("resolveGatewayLogsEnabled honors an explicit workspace_log_settings row", async () => {
  const db = fakeDb({ gatewaySettings: new Map([["ws-1", false]]) });
  const disabled = await resolveGatewayLogsEnabled({ workspaceId: "ws-1" }, { db });
  assert.equal(disabled, false);
});
