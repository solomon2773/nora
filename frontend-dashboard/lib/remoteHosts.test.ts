import assert from "node:assert/strict";
import test from "node:test";

import { isOwnedRemoteHost, partitionRemoteHosts, remoteHostAccessSource } from "./remoteHosts";

test("only an explicit owned access marker exposes remote-host management", () => {
  assert.equal(isOwnedRemoteHost({ access: "owned" }), true);
  assert.equal(isOwnedRemoteHost({ access: "shared" }), false);
  assert.equal(isOwnedRemoteHost({ access: "platform", managementScope: "platform" }), false);
  assert.equal(isOwnedRemoteHost({ access: "user" }), false);
  assert.equal(isOwnedRemoteHost({ access: "group" }), false);
  assert.equal(isOwnedRemoteHost({}), false);
});

test("partitionRemoteHosts keeps every non-owned grant read-only", () => {
  const hosts = [
    { id: "personal", access: "owned" },
    { id: "workspace", access: "shared" },
    { id: "global", access: "platform", managementScope: "platform" },
    { id: "direct", access: "user", managementScope: "platform" },
    { id: "team", access: "group", managementScope: "platform" },
  ];

  const result = partitionRemoteHosts(hosts);

  assert.deepEqual(
    result.owned.map((host) => host.id),
    ["personal"],
  );
  assert.deepEqual(
    result.accessible.map((host) => host.id),
    ["workspace", "global", "direct", "team"],
  );
});

test("remoteHostAccessSource explains the strongest grant surface", () => {
  assert.equal(
    remoteHostAccessSource({ access: "direct", managementScope: "platform" }),
    "shared directly with you",
  );
  assert.equal(
    remoteHostAccessSource({ access: "group", managementScope: "platform" }),
    "via a user group",
  );
  assert.equal(
    remoteHostAccessSource({ access: "platform", managementScope: "platform" }),
    "via platform access",
  );
  assert.equal(remoteHostAccessSource({ access: "user" }), "shared directly with you");
  assert.equal(remoteHostAccessSource({ access: "group" }), "via a user group");
  assert.equal(remoteHostAccessSource({ access: "shared" }), "via a workspace");
});
