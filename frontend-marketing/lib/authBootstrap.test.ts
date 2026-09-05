import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthBootstrapStatus } from "./authBootstrap";

const validBootstrap = {
  needsFirstAdmin: false,
  oauthLoginEnabled: true,
  platformMode: "paas",
  signupEnabled: true,
  signupBotProtection: {
    enabled: false,
    provider: "none",
    siteKey: null,
    configured: true,
    configurationError: null,
  },
};

test("parses signup availability", () => {
  const result = parseAuthBootstrapStatus(validBootstrap);

  assert.equal(result.signupEnabled, true);
});

test("defaults missing signup availability to enabled (older backend)", () => {
  // A backend that predates SIGNUP_ENABLED omits the field during a rolling
  // deploy; the parser must not reject the whole payload for it.
  const { signupEnabled: _signupEnabled, ...missingSignupEnabled } = validBootstrap;

  assert.equal(parseAuthBootstrapStatus(missingSignupEnabled).signupEnabled, true);
});

test("parses explicitly disabled signup availability", () => {
  assert.equal(
    parseAuthBootstrapStatus({ ...validBootstrap, signupEnabled: false }).signupEnabled,
    false,
  );
});

test("rejects non-boolean signup availability", () => {
  assert.throws(
    () => parseAuthBootstrapStatus({ ...validBootstrap, signupEnabled: "yes" }),
    /signup availability/i,
  );
});
