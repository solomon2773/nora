require("tsx/cjs");

const test = require("node:test");
const assert = require("node:assert/strict");

const { logEncryptionKeyProblem } = require("./logs/logKeyCheck.ts");

const HEX = "a".repeat(64);

test("reports nothing for a valid single key", () => {
  assert.equal(logEncryptionKeyProblem({ NORA_LOG_ENCRYPTION_KEY: HEX }), null);
});

test("reports nothing for a valid rotation key ring", () => {
  assert.equal(
    logEncryptionKeyProblem({ NORA_LOG_ENCRYPTION_KEY: `k2:${HEX},k1:${"b".repeat(64)}` }),
    null,
  );
});

test("reports a missing key", () => {
  assert.match(logEncryptionKeyProblem({}), /NORA_LOG_ENCRYPTION_KEY is not configured/);
  assert.match(
    logEncryptionKeyProblem({ NORA_LOG_ENCRYPTION_KEY: "   " }),
    /NORA_LOG_ENCRYPTION_KEY is not configured/,
  );
});

test("reports a malformed key instead of waiting for the first flush to fail", () => {
  assert.match(
    logEncryptionKeyProblem({ NORA_LOG_ENCRYPTION_KEY: "not-hex" }),
    /not a valid 64-char hex key/,
  );
});
