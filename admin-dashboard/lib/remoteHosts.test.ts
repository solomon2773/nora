import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteHostAccessPayload,
  normalizeAdminUserGroups,
  normalizeRemoteHostAccess,
} from "./remoteHosts";

test("normalizes versioned Remote Host access and sends the expected version", () => {
  const access = normalizeRemoteHostAccess({
    version: 7,
    availableToAll: false,
    users: [{ userId: "user-1", email: "one@nora.test", name: "One" }],
    groups: [{ groupId: "group-1", name: "Builders" }],
    workspaces: [{ workspaceId: "workspace-1", name: "Core" }],
  });

  assert.equal(access.version, 7);
  assert.deepEqual(buildRemoteHostAccessPayload(access), {
    expectedVersion: 7,
    availableToAll: false,
    users: ["user-1"],
    groups: ["group-1"],
    workspaces: ["workspace-1"],
  });
});

test("normalizes group membership versions for access directory options", () => {
  assert.deepEqual(
    normalizeAdminUserGroups([
      { id: "group-1", name: "Builders", memberCount: 2, membersVersion: 4 },
    ]),
    [{ id: "group-1", name: "Builders", memberCount: 2, membersVersion: 4 }],
  );
});
