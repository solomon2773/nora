const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { shellSingleQuote } = require("../../agent-runtime/lib/containerCommand.ts");
const {
  DEFAULT_DEMO_ACTIVATION_CANARY_TIMEOUT_MS,
  DEMO_ACTIVATION_CANARY_MAX_OUTPUT_BYTES,
  DEMO_ACTIVATION_CANARY_MARKER,
  buildDemoActivationCanaryCleanupCommand,
  buildDemoActivationCanaryCommand,
  resolveDemoActivationCanaryTimeoutMs,
  runDemoActivationCanary,
  verifyDemoActivationCanaryOutput,
} = require("./demoActivationCanary.ts");

function gatewayReply(text = `ready ${DEMO_ACTIVATION_CANARY_MARKER}`) {
  return JSON.stringify({
    runId: "run-canary-1",
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: { durationMs: 42 },
    },
  });
}

test("canary timeout defaults to five minutes and clamps operator overrides", () => {
  assert.equal(resolveDemoActivationCanaryTimeoutMs(), DEFAULT_DEMO_ACTIVATION_CANARY_TIMEOUT_MS);
  assert.equal(resolveDemoActivationCanaryTimeoutMs("invalid"), 300000);
  assert.equal(resolveDemoActivationCanaryTimeoutMs("1000"), 60000);
  assert.equal(resolveDemoActivationCanaryTimeoutMs("900000"), 600000);
  assert.equal(resolveDemoActivationCanaryTimeoutMs("120000"), 120000);
});

test("canary commands use a non-main session, JSON mode, bounded timeout, and safe quoting", () => {
  const sessionKey = "agent:main:canary'; touch /tmp/should-not-run; #";
  const command = buildDemoActivationCanaryCommand({ sessionKey, timeoutMs: 300000 });
  const cleanup = buildDemoActivationCanaryCleanupCommand({ sessionKey });

  assert.match(command, /agent --agent 'main'/);
  assert.ok(command.includes(`--session-key ${shellSingleQuote(sessionKey)}`));
  assert.ok(
    command.includes(
      `--message ${shellSingleQuote(`Activation check: reply with a message containing ${DEMO_ACTIVATION_CANARY_MARKER}.`)}`,
    ),
  );
  assert.match(command, /--thinking 'off' --json --timeout '255'/);
  assert.match(command, /timeout -k 5s 300s/);
  assert.match(command, /Container timeout utility unavailable for activation canary/);
  assert.match(cleanup, /sessions --agent main --json/);
  assert.match(cleanup, /sessions cleanup --agent main --fix-missing --enforce --json/);
  assert.ok(cleanup.includes(shellSingleQuote(sessionKey)));
  assert.doesNotMatch(cleanup, /gateway call|sessions\.delete/);
  assert.match(cleanup, /Activation canary session cleanup did not remove the session/);
  assert.equal(spawnSync("sh", ["-n"], { input: command }).status, 0);
  assert.equal(spawnSync("sh", ["-n"], { input: cleanup }).status, 0);
});

test("canary command builders reject the OpenClaw main session", () => {
  assert.throws(
    () => buildDemoActivationCanaryCommand({ sessionKey: "agent:main:main" }),
    /requires a non-main OpenClaw session key/,
  );
  assert.throws(
    () => buildDemoActivationCanaryCleanupCommand({ sessionKey: "main" }),
    /requires a non-main OpenClaw session key/,
  );
});

test("canary verification accepts only a completed Gateway JSON reply containing the marker", () => {
  assert.deepEqual(verifyDemoActivationCanaryOutput(gatewayReply()), {
    status: "ready",
    runId: "run-canary-1",
    payloadCount: 1,
  });

  assert.throws(
    () =>
      verifyDemoActivationCanaryOutput(
        JSON.stringify({
          runId: "run-canary-2",
          status: "ok",
          result: { payloads: [{ text: "reply without marker" }] },
          note: DEMO_ACTIVATION_CANARY_MARKER,
        }),
      ),
    (error) => error.code === "DEMO_ACTIVATION_CANARY_MARKER_MISSING",
  );
});

test("canary verification rejects direct embedded and explicit fallback results", () => {
  assert.throws(
    () =>
      verifyDemoActivationCanaryOutput(
        JSON.stringify({
          payloads: [{ text: DEMO_ACTIVATION_CANARY_MARKER }],
          meta: { transport: "embedded", fallbackFrom: "gateway" },
        }),
      ),
    (error) => error.code === "DEMO_ACTIVATION_CANARY_EMBEDDED_FALLBACK",
  );

  assert.throws(
    () =>
      verifyDemoActivationCanaryOutput(
        JSON.stringify({
          runId: "run-canary-fallback",
          status: "ok",
          result: {
            payloads: [{ text: DEMO_ACTIVATION_CANARY_MARKER }],
            meta: { fallbackReason: "gateway_timeout" },
          },
        }),
      ),
    (error) => error.code === "DEMO_ACTIVATION_CANARY_EMBEDDED_FALLBACK",
  );
});

test("canary verification fails closed on malformed or non-Gateway JSON", () => {
  assert.throws(
    () => verifyDemoActivationCanaryOutput("not json"),
    (error) => error.code === "DEMO_ACTIVATION_CANARY_INVALID_JSON",
  );
  assert.throws(
    () =>
      verifyDemoActivationCanaryOutput(
        JSON.stringify({
          payloads: [{ text: DEMO_ACTIVATION_CANARY_MARKER }],
          meta: { durationMs: 1 },
        }),
      ),
    (error) => error.code === "DEMO_ACTIVATION_CANARY_INVALID_GATEWAY_REPLY",
  );
});

test("canary execution verifies the reply before deleting its isolated session", async () => {
  const calls = [];
  const result = await runDemoActivationCanary({
    agentId: "agent-1",
    sessionKey: "agent:main:nora-activation-canary-test",
    timeoutMs: 300000,
    execute: async (command, options) => {
      calls.push({ command, options });
      return calls.length === 1 ? { output: gatewayReply() } : { output: "" };
    },
  });

  assert.deepEqual(result, { status: "ready", runId: "run-canary-1", payloadCount: 1 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].command, / agent /);
  assert.equal(calls[0].options.timeout, 310000);
  assert.equal(calls[0].options.maxOutputBytes, DEMO_ACTIVATION_CANARY_MAX_OUTPUT_BYTES);
  assert.equal(calls[0].options.agentId, "agent-1");
  assert.match(calls[1].command, /sessions cleanup/);
  assert.equal(calls[1].options.timeout, 20000);
});

test("canary cleanup is attempted after verification failure and remains best effort", async () => {
  const calls = [];
  const cleanupFailures = [];

  await assert.rejects(
    runDemoActivationCanary({
      agentId: "agent-1",
      sessionKey: "agent:main:nora-activation-canary-test",
      execute: async (command) => {
        calls.push(command);
        if (calls.length === 1) return { output: gatewayReply("missing marker") };
        throw new Error("cleanup unavailable");
      },
      onCleanupFailure: async (failure) => cleanupFailures.push(failure),
    }),
    (error) => error.code === "DEMO_ACTIVATION_CANARY_MARKER_MISSING",
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1], /sessions cleanup/);
  assert.equal(cleanupFailures.length, 1);
  assert.equal(cleanupFailures[0].agentId, "agent-1");
});

test("canary wraps exec failures without exposing command output and still cleans up", async () => {
  const calls = [];
  await assert.rejects(
    runDemoActivationCanary({
      agentId: "agent-1",
      sessionKey: "agent:main:nora-activation-canary-test",
      execute: async (command) => {
        calls.push(command);
        if (calls.length === 1) throw new Error("sensitive transport output");
        return { output: "" };
      },
    }),
    (error) => {
      assert.equal(error.code, "DEMO_ACTIVATION_CANARY_EXEC_FAILED");
      assert.doesNotMatch(error.message, /sensitive transport output/);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});
