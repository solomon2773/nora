import test from "node:test";
import assert from "node:assert/strict";

import {
  ACK_MARKER,
  DAY_MS,
  REMINDER_MARKER,
  buildAcknowledgement,
  buildReminder,
  classifyResponseState,
  hasMaintainerResponse,
  isExternalThread,
  isMaintainerAssociation,
  pullRequestResponseStart,
} from "./community-response.mjs";

test("maintainer associations and bots are not placed in the external response queue", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(isMaintainerAssociation(association), true);
    assert.equal(isExternalThread({ authorAssociation: association, authorType: "User" }), false);
  }
  assert.equal(isExternalThread({ authorAssociation: "NONE", authorType: "Bot" }), false);
  assert.equal(isExternalThread({ authorAssociation: "NONE", authorType: "User" }), true);
});

test("maintainer comments and reviews satisfy the human response target", () => {
  assert.equal(hasMaintainerResponse([{ author_association: "OWNER" }]), true);
  assert.equal(hasMaintainerResponse([], [{ author_association: "MEMBER" }]), true);
  assert.equal(hasMaintainerResponse([{ authorAssociation: "COLLABORATOR" }]), true);
  assert.equal(hasMaintainerResponse([{ author_association: "NONE" }]), false);
});

test("response audit reminds at day twelve and escalates at day fourteen", () => {
  const createdAt = new Date("2026-01-01T00:00:00Z").toISOString();
  const dayEleven = classifyResponseState(
    { createdAt },
    new Date("2026-01-12T00:00:00Z").getTime(),
  );
  assert.equal(dayEleven.needsReminder, false);
  assert.equal(dayEleven.overdue, false);

  const dayTwelve = classifyResponseState(
    { createdAt },
    new Date("2026-01-13T00:00:00Z").getTime(),
  );
  assert.equal(dayTwelve.elapsedMs, 12 * DAY_MS);
  assert.equal(dayTwelve.needsReminder, true);
  assert.equal(dayTwelve.overdue, false);

  const dayFourteen = classifyResponseState(
    { createdAt, comments: [{ body: REMINDER_MARKER, author_association: "BOT" }] },
    new Date("2026-01-15T00:00:00Z").getTime(),
  );
  assert.equal(dayFourteen.needsReminder, false);
  assert.equal(dayFourteen.overdue, true);

  const answered = classifyResponseState(
    { createdAt, comments: [{ author_association: "COLLABORATOR" }] },
    new Date("2026-02-01T00:00:00Z").getTime(),
  );
  assert.equal(answered.needsReminder, false);
  assert.equal(answered.overdue, false);
});

test("acknowledgements and reminders carry stable deduplication markers", () => {
  for (const kind of ["issue", "pull request", "discussion"]) {
    assert.match(
      buildAcknowledgement(kind),
      new RegExp(ACK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      buildReminder(kind),
      new RegExp(REMINDER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("draft pull requests enter the response clock only when marked ready", () => {
  const createdAt = "2026-01-01T00:00:00Z";
  assert.equal(pullRequestResponseStart({ createdAt, draft: true }), null);

  const latestReadyAt = pullRequestResponseStart({
    createdAt,
    draft: false,
    timeline: [
      { event: "ready_for_review", created_at: "2026-01-05T00:00:00Z" },
      { event: "convert_to_draft", created_at: "2026-01-06T00:00:00Z" },
      { event: "ready_for_review", created_at: "2026-01-10T00:00:00Z" },
    ],
  });
  assert.equal(latestReadyAt, "2026-01-10T00:00:00Z");

  const dayEleven = classifyResponseState(
    { createdAt: latestReadyAt },
    new Date("2026-01-21T00:00:00Z").getTime(),
  );
  const dayTwelve = classifyResponseState(
    { createdAt: latestReadyAt },
    new Date("2026-01-22T00:00:00Z").getTime(),
  );
  assert.equal(dayEleven.needsReminder, false);
  assert.equal(dayTwelve.needsReminder, true);
});
