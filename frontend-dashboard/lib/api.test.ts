import assert from "node:assert/strict";
import test from "node:test";

import { sameOriginUrl } from "./api";

const ORIGIN = "https://app.example.com";

test("passes through a relative API path", () => {
  assert.equal(sameOriginUrl("/api/agents", ORIGIN), `${ORIGIN}/api/agents`);
  assert.equal(sameOriginUrl("/api/agents?x=1#f", ORIGIN), `${ORIGIN}/api/agents?x=1#f`);
});

test("refuses an absolute cross-origin URL", () => {
  assert.throws(() => sameOriginUrl("https://evil.com/x", ORIGIN), /Refusing to send/);
});

test("refuses a protocol-relative URL", () => {
  assert.throws(() => sameOriginUrl("//evil.com/x", ORIGIN), /Refusing to send/);
});

// Regression: an on-origin URL whose *path* begins with "//" resolves to a
// same-origin URL, so the origin check passes. Returning its pathname alone
// would yield "//evil.com/x", which fetch() treats as protocol-relative and
// sends to evil.com along with the Authorization header. The returned value
// must stay pinned to the validated host.
test("does not let a // path escape the origin", () => {
  const result = sameOriginUrl(`${ORIGIN}//evil.com/x`, ORIGIN);
  assert.equal(new URL(result).origin, ORIGIN);
  assert.equal(new URL(result, ORIGIN).origin, ORIGIN);
});
