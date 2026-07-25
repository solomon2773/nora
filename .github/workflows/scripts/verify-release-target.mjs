import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXACT_RELEASE_TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const STABLE_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const EXPECTED_NPM_PACKAGES = new Set(["@noraai/mcp-server", "@noraai/cli"]);
const EXPECTED_MCP_PACKAGE = "@noraai/mcp-server";
const EXPECTED_MCP_NAME = "io.github.solomon2773/nora";

function fail(message) {
  throw new Error(message);
}

function requireSafeText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    fail(`${label} is empty or contains a newline.`);
  }
  return value;
}

export function parseExactReleaseTag(value) {
  const tag = requireSafeText(value, "Release tag");
  const match = EXACT_RELEASE_TAG_RE.exec(tag);
  if (!match) {
    fail(`Release tag must be exactly vMAJOR.MINOR.PATCH; got '${tag}'.`);
  }
  return {
    tag,
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function parseStableSemver(value, label = "Package version") {
  const version = requireSafeText(value, label);
  if (!STABLE_SEMVER_RE.test(version)) {
    fail(`${label} must be a stable MAJOR.MINOR.PATCH SemVer; got '${version}'.`);
  }
  return version;
}

export function parseCommitSha(value, label = "Commit SHA") {
  const sha = requireSafeText(value, label).toLowerCase();
  if (!COMMIT_SHA_RE.test(sha)) {
    fail(`${label} must be an exact 40-character commit SHA.`);
  }
  return sha;
}

export function selectRequestedReleaseTag({ eventName, releaseTag, dispatchTag }) {
  if (eventName === "release") {
    return parseExactReleaseTag(releaseTag).tag;
  }
  if (eventName === "workflow_dispatch") {
    return parseExactReleaseTag(dispatchTag).tag;
  }
  fail(`Unsupported release event '${eventName || "(empty)"}'.`);
}

export function assertPublishedRelease(release, requestedTag) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail("GitHub returned an invalid release payload.");
  }
  if (release.tag_name !== requestedTag) {
    fail(
      `Published release tag '${release.tag_name || "(empty)"}' does not match '${requestedTag}'.`,
    );
  }
  if (release.draft !== false) {
    fail(`GitHub release '${requestedTag}' is still a draft.`);
  }
  if (release.prerelease !== false) {
    fail(`GitHub release '${requestedTag}' is marked as a prerelease.`);
  }
  if (
    typeof release.published_at !== "string" ||
    release.published_at.length === 0 ||
    Number.isNaN(Date.parse(release.published_at))
  ) {
    fail(`GitHub release '${requestedTag}' has not been published.`);
  }
  return release;
}

export function assertProtectedDefaultBranch(branch, expectedName) {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
    fail("GitHub returned an invalid default-branch payload.");
  }
  if (branch.name !== expectedName) {
    fail(`GitHub returned branch '${branch.name || "(empty)"}', expected '${expectedName}'.`);
  }
  if (branch.protected !== true) {
    fail(`Default branch '${expectedName}' is not protected.`);
  }
  return parseCommitSha(branch.commit?.sha, `Default branch '${expectedName}' SHA`);
}

export function assertTargetIsAncestor(compare, targetSha, defaultBranchSha) {
  if (!compare || typeof compare !== "object" || Array.isArray(compare)) {
    fail("GitHub returned an invalid comparison payload.");
  }
  const statusAllowsAncestry = compare.status === "ahead" || compare.status === "identical";
  const mergeBase = parseCommitSha(compare.merge_base_commit?.sha, "Comparison merge-base SHA");
  const base = parseCommitSha(compare.base_commit?.sha, "Comparison base SHA");
  if (!statusAllowsAncestry || mergeBase !== targetSha || base !== targetSha) {
    fail(
      `Release target ${targetSha} is not an ancestor of default-branch SHA ${defaultBranchSha}.`,
    );
  }
}

export function validateNpmPackageMetadata(packageJson, expectedName, expectedVersion = "") {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    fail("package.json must contain a JSON object.");
  }
  if (!EXPECTED_NPM_PACKAGES.has(expectedName)) {
    fail(`Unexpected npm package allowlist entry '${expectedName || "(empty)"}'.`);
  }
  if (packageJson.name !== expectedName) {
    fail(`Package name '${packageJson.name || "(empty)"}' does not match '${expectedName}'.`);
  }
  const version = parseStableSemver(packageJson.version);
  if (
    expectedVersion &&
    version !== parseStableSemver(expectedVersion, "Expected package version")
  ) {
    fail(`Package version '${version}' does not match expected version '${expectedVersion}'.`);
  }
  if (
    !packageJson.publishConfig ||
    typeof packageJson.publishConfig !== "object" ||
    Array.isArray(packageJson.publishConfig) ||
    packageJson.publishConfig.access !== "public"
  ) {
    fail(`Package '${expectedName}' must set publishConfig.access to 'public'.`);
  }
  const unexpectedPublishConfigKeys = Object.keys(packageJson.publishConfig).filter(
    (key) => key !== "access",
  );
  if (unexpectedPublishConfigKeys.length > 0) {
    fail(
      `Package '${expectedName}' has unsupported publishConfig keys: ${unexpectedPublishConfigKeys.join(
        ", ",
      )}.`,
    );
  }
  return { name: expectedName, version };
}

export function validateMcpMetadata(packageJson, serverJson, expectedVersion = "") {
  const npmMetadata = validateNpmPackageMetadata(
    packageJson,
    EXPECTED_MCP_PACKAGE,
    expectedVersion,
  );
  if (packageJson.mcpName !== EXPECTED_MCP_NAME) {
    fail(
      `Package mcpName '${packageJson.mcpName || "(empty)"}' does not match '${EXPECTED_MCP_NAME}'.`,
    );
  }
  if (!serverJson || typeof serverJson !== "object" || Array.isArray(serverJson)) {
    fail("server.json must contain a JSON object.");
  }
  if (serverJson.name !== EXPECTED_MCP_NAME) {
    fail(
      `server.json name '${serverJson.name || "(empty)"}' does not match '${EXPECTED_MCP_NAME}'.`,
    );
  }
  if (serverJson.version !== npmMetadata.version) {
    fail(
      `server.json version '${serverJson.version || "(empty)"}' does not match package version '${npmMetadata.version}'.`,
    );
  }
  if (!Array.isArray(serverJson.packages) || serverJson.packages.length !== 1) {
    fail("server.json must contain exactly one packages[] entry.");
  }
  const [npmPackage] = serverJson.packages;
  if (npmPackage?.registryType !== "npm" || npmPackage?.identifier !== EXPECTED_MCP_PACKAGE) {
    fail(`server.json must reference npm package '${EXPECTED_MCP_PACKAGE}'.`);
  }
  if (npmPackage.version !== npmMetadata.version) {
    fail(
      `server.json npm package version '${npmPackage.version || "(empty)"}' does not match '${npmMetadata.version}'.`,
    );
  }
  return {
    ...npmMetadata,
    mcpName: EXPECTED_MCP_NAME,
  };
}

export function createGitHubApi({ repository, token, fetchImpl = globalThis.fetch }) {
  if (!REPOSITORY_RE.test(repository || "")) {
    fail("GITHUB_REPOSITORY must be an owner/name pair.");
  }
  requireSafeText(token, "GITHUB_TOKEN");
  if (typeof fetchImpl !== "function") {
    fail("A fetch implementation is required.");
  }
  const baseUrl = `https://api.github.com/repos/${repository}`;
  return async function githubApi(relativePath = "") {
    const normalizedPath = relativePath ? `/${relativePath.replace(/^\/+/, "")}` : "";
    const response = await fetchImpl(`${baseUrl}${normalizedPath}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nora-release-target-verifier",
      },
    });
    if (!response.ok) {
      fail(`GitHub API request failed with ${response.status} ${response.statusText}.`);
    }
    return response.json();
  };
}

export async function resolveTagCommitSha({ tag, api }) {
  const parsedTag = parseExactReleaseTag(tag).tag;
  const tagRef = await api(`git/ref/tags/${encodeURIComponent(parsedTag)}`);
  if (tagRef?.ref !== `refs/tags/${parsedTag}`) {
    fail(`GitHub did not return the exact tag ref refs/tags/${parsedTag}.`);
  }

  let object = tagRef.object;
  const seen = new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    if (object?.type === "commit") {
      return parseCommitSha(object.sha, `Tag '${parsedTag}' commit SHA`);
    }
    if (object?.type !== "tag") {
      fail(
        `Tag '${parsedTag}' resolves to unsupported Git object type '${object?.type || "empty"}'.`,
      );
    }
    const annotatedTagSha = parseCommitSha(object.sha, `Tag '${parsedTag}' object SHA`);
    if (seen.has(annotatedTagSha)) {
      fail(`Tag '${parsedTag}' contains a cyclic annotated-tag chain.`);
    }
    seen.add(annotatedTagSha);
    const annotatedTag = await api(`git/tags/${annotatedTagSha}`);
    object = annotatedTag?.object;
  }
  fail(`Tag '${parsedTag}' exceeds the annotated-tag resolution limit.`);
}

export async function resolvePublishedReleaseTarget({
  repository,
  requestedTag,
  token,
  fetchImpl,
}) {
  const { tag, version } = parseExactReleaseTag(requestedTag);
  const api = createGitHubApi({ repository, token, fetchImpl });

  const release = await api(`releases/tags/${encodeURIComponent(tag)}`);
  assertPublishedRelease(release, tag);

  const repositoryInfo = await api();
  const defaultBranch = requireSafeText(repositoryInfo?.default_branch, "Default branch");
  const branch = await api(`branches/${encodeURIComponent(defaultBranch)}`);
  const defaultBranchSha = assertProtectedDefaultBranch(branch, defaultBranch);

  const sha = await resolveTagCommitSha({ tag, api });
  const compare = await api(`compare/${sha}...${defaultBranchSha}`);
  assertTargetIsAncestor(compare, sha, defaultBranchSha);

  return { tag, version, sha, defaultBranch };
}

function readJson(filePath, label) {
  const absolutePath = path.resolve(requireSafeText(filePath, `${label} path`));
  let contents;
  try {
    contents = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    fail(`Could not read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readPackageJsonFromTarball(tarballPath) {
  const absolutePath = path.resolve(requireSafeText(tarballPath, "Package tarball path"));
  let contents;
  try {
    contents = execFileSync("tar", ["-xOf", absolutePath, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(`Could not read package/package.json from npm tarball: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`npm tarball package/package.json is not valid JSON: ${error.message}`);
  }
}

function appendOutput(name, value) {
  const outputPath = requireSafeText(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const safeName = requireSafeText(name, "Output name");
  const safeValue = requireSafeText(String(value), `Output '${safeName}'`);
  fs.appendFileSync(outputPath, `${safeName}=${safeValue}\n`);
}

function emitPackageOutputs(metadata) {
  appendOutput("name", metadata.name);
  appendOutput("version", metadata.version);
  if (metadata.mcpName) {
    appendOutput("mcp_name", metadata.mcpName);
  }
}

async function runResolveRelease() {
  const requestedTag = selectRequestedReleaseTag({
    eventName: process.env.EVENT_NAME || "",
    releaseTag: process.env.RELEASE_TAG || "",
    dispatchTag: process.env.DISPATCH_TAG || "",
  });
  const target = await resolvePublishedReleaseTarget({
    repository: process.env.GITHUB_REPOSITORY || "",
    requestedTag,
    token: process.env.GITHUB_TOKEN || "",
  });

  if (
    process.env.EXPECTED_TAG &&
    target.tag !== parseExactReleaseTag(process.env.EXPECTED_TAG).tag
  ) {
    fail(`Release tag changed from '${process.env.EXPECTED_TAG}' to '${target.tag}'.`);
  }
  if (process.env.EXPECTED_SHA && target.sha !== parseCommitSha(process.env.EXPECTED_SHA)) {
    fail(
      `Release tag '${target.tag}' no longer points to expected SHA ${process.env.EXPECTED_SHA}.`,
    );
  }

  appendOutput("tag", target.tag);
  appendOutput("version", target.version);
  appendOutput("sha", target.sha);
  appendOutput("default_branch", target.defaultBranch);
  console.log(
    `Verified published release ${target.tag} at ${target.sha} on ${target.defaultBranch}.`,
  );
}

function runVerifyNpmDirectory() {
  const targetDir = path.resolve(requireSafeText(process.env.TARGET_DIR, "TARGET_DIR"));
  const packageJson = readJson(path.join(targetDir, "package.json"), "package.json");
  const metadata = validateNpmPackageMetadata(
    packageJson,
    process.env.EXPECTED_PACKAGE_NAME || "",
    process.env.EXPECTED_VERSION || "",
  );
  emitPackageOutputs(metadata);
  console.log(`Verified ${metadata.name}@${metadata.version}.`);
}

function runVerifyNpmTarball() {
  const packageJson = readPackageJsonFromTarball(process.env.PACKAGE_TARBALL || "");
  const metadata = validateNpmPackageMetadata(
    packageJson,
    process.env.EXPECTED_PACKAGE_NAME || "",
    process.env.EXPECTED_VERSION || "",
  );
  emitPackageOutputs(metadata);
  console.log(`Verified npm tarball ${metadata.name}@${metadata.version}.`);
}

function runVerifyMcpDirectory() {
  const targetDir = path.resolve(requireSafeText(process.env.TARGET_DIR, "TARGET_DIR"));
  const packageJson = readJson(path.join(targetDir, "package.json"), "package.json");
  const serverJson = readJson(path.join(targetDir, "server.json"), "server.json");
  const metadata = validateMcpMetadata(packageJson, serverJson, process.env.EXPECTED_VERSION || "");
  emitPackageOutputs(metadata);
  console.log(`Verified MCP payload ${metadata.mcpName}@${metadata.version}.`);
}

async function main() {
  const command = process.argv[2] || "";
  if (command === "resolve-release") {
    await runResolveRelease();
    return;
  }
  if (command === "verify-npm-directory") {
    runVerifyNpmDirectory();
    return;
  }
  if (command === "verify-npm-tarball") {
    runVerifyNpmTarball();
    return;
  }
  if (command === "verify-mcp-directory") {
    runVerifyMcpDirectory();
    return;
  }
  fail(
    "Usage: verify-release-target.mjs <resolve-release|verify-npm-directory|verify-npm-tarball|verify-mcp-directory>",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Release verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
