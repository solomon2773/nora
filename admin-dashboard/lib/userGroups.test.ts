import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUserGroupMembers, normalizeUserGroups } from "./userGroups";

test("normalizes versioned group member snapshots", () => {
  const snapshot = normalizeUserGroupMembers({
    version: 5,
    members: [{ userId: "user-1", email: "one@nora.test", name: "One" }],
  });

  assert.equal(snapshot.version, 5);
  assert.deepEqual(snapshot.members, [
    { id: "user-1", userId: "user-1", email: "one@nora.test", name: "One" },
  ]);
});

test("keeps the final users-key response compatible and records list versions", () => {
  const snapshot = normalizeUserGroupMembers({
    version: 6,
    users: [{ userId: "user-2", email: "two@nora.test", name: "Two" }],
  });
  const [group] = normalizeUserGroups([
    { id: "group-1", name: "Builders", memberCount: 1, membersVersion: 6 },
  ]);

  assert.equal(snapshot.version, 6);
  assert.equal(snapshot.members[0].userId, "user-2");
  assert.equal(group.membersVersion, 6);
});
