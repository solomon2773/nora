import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_STATS,
  collectionHeadline,
  describeCollectionError,
  hasCollectedLogs,
  needsKeepOrDelete,
  purgeInProgress,
  shouldShowUndecidedBanner,
} from "./logCollection";

test("hasCollectedLogs: segments or spans count, nothing or junk does not", () => {
  assert.equal(hasCollectedLogs(EMPTY_STATS), false);
  assert.equal(hasCollectedLogs({ ...EMPTY_STATS, segments: 1 }), true);
  assert.equal(hasCollectedLogs({ ...EMPTY_STATS, spans: 3 }), true);
  assert.equal(hasCollectedLogs(null), false);
  assert.equal(hasCollectedLogs(undefined), false);
  assert.equal(hasCollectedLogs({ segments: Number.NaN }), false);
});

test("purgeInProgress: only pending and running are in progress", () => {
  assert.equal(purgeInProgress({ status: "pending" }), true);
  assert.equal(purgeInProgress({ status: "running" }), true);
  assert.equal(purgeInProgress({ status: "completed" }), false);
  assert.equal(purgeInProgress({ status: "failed" }), false);
  assert.equal(purgeInProgress(null), false);
});

test("collectionHeadline distinguishes on, an explicit off, and not decided", () => {
  assert.equal(collectionHeadline({ enabled: true, decided: true }), "on");
  assert.equal(collectionHeadline({ enabled: false, decided: true }), "off");
  assert.equal(collectionHeadline({ enabled: false, decided: false }), "undecided");
  assert.equal(collectionHeadline(null), "undecided");
});

test("the undecided banner shows only for a known 'not decided' answer that has not been dismissed", () => {
  assert.equal(shouldShowUndecidedBanner({ decided: false }, false), true);
  assert.equal(shouldShowUndecidedBanner({ decided: false }, true), false, "dismissed");
  assert.equal(shouldShowUndecidedBanner({ decided: true }, false), false, "already decided");
  assert.equal(
    shouldShowUndecidedBanner(null, false),
    false,
    "no answer yet must not flash a banner",
  );
});

test("describeCollectionError prefers the server's message", () => {
  assert.equal(
    describeCollectionError({ error: "Logs are still being deleted." }, 409),
    "Logs are still being deleted.",
  );
  assert.equal(describeCollectionError({}, 500), "Request failed (500)");
  assert.equal(describeCollectionError(null, 502), "Request failed (502)");
});

test("needsKeepOrDelete is true only for the server's delete_existing_required answer", () => {
  assert.equal(needsKeepOrDelete(400, { code: "delete_existing_required" }), true);
  assert.equal(needsKeepOrDelete(400, { code: "invalid_enabled" }), false);
  assert.equal(needsKeepOrDelete(409, { code: "delete_existing_required" }), false);
  assert.equal(needsKeepOrDelete(400, null), false);
});
