import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublishedRelease,
  assertProtectedDefaultBranch,
  assertTargetIsAncestor,
  parseCommitSha,
  parseExactReleaseTag,
  parseStableSemver,
  resolvePublishedReleaseTarget,
  selectRequestedReleaseTag,
  validateMcpMetadata,
  validateNpmPackageMetadata,
} from "./verify-release-target.mjs";

const TARGET_SHA = "1111111111111111111111111111111111111111";
const DEFAULT_SHA = "2222222222222222222222222222222222222222";

test("parseExactReleaseTag accepts only canonical product release tags", () => {
  assert.deepEqual(parseExactReleaseTag("v1.16.5"), { tag: "v1.16.5", version: "1.16.5" });
  for (const value of ["1.16.5", "v01.16.5", "v1.16", "v1.16.5-rc.1", "v1.16.5+build"]) {
    assert.throws(() => parseExactReleaseTag(value), /exactly vMAJOR\.MINOR\.PATCH/);
  }
});

test("parseStableSemver rejects prefixes, prereleases, build metadata, and leading zeroes", () => {
  assert.equal(parseStableSemver("0.1.4"), "0.1.4");
  assert.equal(parseStableSemver("10.20.30"), "10.20.30");
  for (const value of ["v1.2.3", "01.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2"]) {
    assert.throws(() => parseStableSemver(value), /stable MAJOR\.MINOR\.PATCH SemVer/);
  }
});

test("parseCommitSha requires an exact immutable SHA", () => {
  assert.equal(parseCommitSha(TARGET_SHA.toUpperCase()), TARGET_SHA);
  for (const value of ["1111111", `${TARGET_SHA}00`, "g".repeat(40)]) {
    assert.throws(() => parseCommitSha(value), /exact 40-character commit SHA/);
  }
});

test("selectRequestedReleaseTag uses only the event-specific tag source", () => {
  assert.equal(
    selectRequestedReleaseTag({
      eventName: "release",
      releaseTag: "v1.2.3",
      dispatchTag: "v9.9.9",
    }),
    "v1.2.3",
  );
  assert.equal(
    selectRequestedReleaseTag({
      eventName: "workflow_dispatch",
      releaseTag: "v9.9.9",
      dispatchTag: "v1.2.3",
    }),
    "v1.2.3",
  );
  assert.throws(
    () =>
      selectRequestedReleaseTag({
        eventName: "push",
        releaseTag: "v1.2.3",
        dispatchTag: "v1.2.3",
      }),
    /Unsupported release event/,
  );
});

test("assertPublishedRelease accepts an exact stable published release", () => {
  const release = {
    tag_name: "v1.2.3",
    draft: false,
    prerelease: false,
    published_at: "2026-07-13T12:00:00Z",
  };
  assert.equal(assertPublishedRelease(release, "v1.2.3"), release);
});

test("assertPublishedRelease rejects drafts, prereleases, mismatches, and unpublished payloads", () => {
  const base = {
    tag_name: "v1.2.3",
    draft: false,
    prerelease: false,
    published_at: "2026-07-13T12:00:00Z",
  };
  assert.throws(
    () => assertPublishedRelease({ ...base, tag_name: "v1.2.4" }, "v1.2.3"),
    /does not match/,
  );
  assert.throws(() => assertPublishedRelease({ ...base, draft: true }, "v1.2.3"), /still a draft/);
  assert.throws(
    () => assertPublishedRelease({ ...base, prerelease: true }, "v1.2.3"),
    /marked as a prerelease/,
  );
  assert.throws(
    () => assertPublishedRelease({ ...base, published_at: null }, "v1.2.3"),
    /has not been published/,
  );
  assert.throws(
    () => assertPublishedRelease({ ...base, published_at: "not-a-date" }, "v1.2.3"),
    /has not been published/,
  );
});

test("default branch and comparison policy require protected ancestry", () => {
  assert.equal(
    assertProtectedDefaultBranch(
      { name: "master", protected: true, commit: { sha: DEFAULT_SHA } },
      "master",
    ),
    DEFAULT_SHA,
  );
  assert.doesNotThrow(() =>
    assertTargetIsAncestor(
      {
        status: "ahead",
        base_commit: { sha: TARGET_SHA },
        merge_base_commit: { sha: TARGET_SHA },
      },
      TARGET_SHA,
      DEFAULT_SHA,
    ),
  );
  assert.throws(
    () =>
      assertProtectedDefaultBranch(
        { name: "master", protected: false, commit: { sha: DEFAULT_SHA } },
        "master",
      ),
    /is not protected/,
  );
  assert.throws(
    () =>
      assertTargetIsAncestor(
        {
          status: "diverged",
          base_commit: { sha: TARGET_SHA },
          merge_base_commit: { sha: DEFAULT_SHA },
        },
        TARGET_SHA,
        DEFAULT_SHA,
      ),
    /is not an ancestor/,
  );
});

test("resolvePublishedReleaseTarget resolves an annotated tag and protected ancestry", async () => {
  const calls = [];
  const payloads = new Map([
    [
      "https://api.github.com/repos/solomon2773/nora/releases/tags/v1.2.3",
      {
        tag_name: "v1.2.3",
        draft: false,
        prerelease: false,
        published_at: "2026-07-13T12:00:00Z",
      },
    ],
    ["https://api.github.com/repos/solomon2773/nora", { default_branch: "master" }],
    [
      "https://api.github.com/repos/solomon2773/nora/branches/master",
      { name: "master", protected: true, commit: { sha: DEFAULT_SHA } },
    ],
    [
      "https://api.github.com/repos/solomon2773/nora/git/ref/tags/v1.2.3",
      {
        ref: "refs/tags/v1.2.3",
        object: { type: "tag", sha: "3333333333333333333333333333333333333333" },
      },
    ],
    [
      "https://api.github.com/repos/solomon2773/nora/git/tags/3333333333333333333333333333333333333333",
      { object: { type: "commit", sha: TARGET_SHA } },
    ],
    [
      `https://api.github.com/repos/solomon2773/nora/compare/${TARGET_SHA}...${DEFAULT_SHA}`,
      {
        status: "ahead",
        base_commit: { sha: TARGET_SHA },
        merge_base_commit: { sha: TARGET_SHA },
      },
    ],
  ]);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const payload = payloads.get(url);
    assert.ok(payload, `Unexpected URL ${url}`);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return payload;
      },
    };
  };

  const target = await resolvePublishedReleaseTarget({
    repository: "solomon2773/nora",
    requestedTag: "v1.2.3",
    token: "test-token",
    fetchImpl,
  });
  assert.deepEqual(target, {
    tag: "v1.2.3",
    version: "1.2.3",
    sha: TARGET_SHA,
    defaultBranch: "master",
  });
  assert.equal(calls.length, payloads.size);
  assert.ok(calls.every(({ options }) => options.headers.Authorization === "Bearer test-token"));
});

test("npm metadata is allowlisted by exact name and stable version", () => {
  assert.deepEqual(
    validateNpmPackageMetadata(
      { name: "@noraai/cli", version: "0.1.1", publishConfig: { access: "public" } },
      "@noraai/cli",
    ),
    {
      name: "@noraai/cli",
      version: "0.1.1",
    },
  );
  assert.throws(
    () =>
      validateNpmPackageMetadata(
        {
          name: "@attacker/cli",
          version: "0.1.1",
          publishConfig: { access: "public" },
        },
        "@noraai/cli",
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      validateNpmPackageMetadata(
        {
          name: "@noraai/new",
          version: "0.1.1",
          publishConfig: { access: "public" },
        },
        "@noraai/new",
      ),
    /allowlist/,
  );
  assert.throws(
    () =>
      validateNpmPackageMetadata(
        {
          name: "@noraai/cli",
          version: "0.1.1",
          publishConfig: { access: "public", registry: "https://registry.attacker.invalid" },
        },
        "@noraai/cli",
      ),
    /unsupported publishConfig keys/,
  );
});

test("MCP metadata requires the exact package, mcpName, identifier, and aligned SemVer", () => {
  const packageJson = {
    name: "@noraai/mcp-server",
    version: "0.1.4",
    mcpName: "io.github.solomon2773/nora",
    publishConfig: { access: "public" },
  };
  const serverJson = {
    name: "io.github.solomon2773/nora",
    version: "0.1.4",
    packages: [
      {
        registryType: "npm",
        identifier: "@noraai/mcp-server",
        version: "0.1.4",
      },
    ],
  };
  assert.deepEqual(validateMcpMetadata(packageJson, serverJson), {
    name: "@noraai/mcp-server",
    version: "0.1.4",
    mcpName: "io.github.solomon2773/nora",
  });
  assert.throws(
    () => validateMcpMetadata({ ...packageJson, mcpName: "io.github.attacker/nora" }, serverJson),
    /does not match/,
  );
  assert.throws(
    () => validateMcpMetadata(packageJson, { ...serverJson, version: "0.1.5" }),
    /does not match package version/,
  );
});
