// A secret scanner that never fires is indistinguishable from no scanner at
// all, so these tests pin both directions: real credential shapes must be
// caught, and the source-code constructs that made the first draft unusable
// must stay quiet.
//
// Provider tokens below are assembled from fragments at runtime rather than
// written as literals. Written whole they trip GitHub push protection, which
// blocked the first push of this very file — a fair demonstration that the
// first line of defence works. Splitting them keeps the fixtures invisible to
// every literal-matching scanner while still exercising the patterns here.

import assert from "node:assert/strict";
import test from "node:test";

import { scanContent } from "./scan-secrets.mjs";

const join = (...parts) => parts.join("");

function detectors(content, filePath = "example.txt") {
  return scanContent(filePath, content).map((finding) => finding.detector);
}

function assertDetected(content, label) {
  assert.ok(detectors(content).length > 0, `expected a finding for ${label}`);
}

function assertClean(content, label) {
  const found = detectors(content);
  assert.deepEqual(found, [], `expected no finding for ${label}, got ${found.join(", ")}`);
}

test("detects well-known provider credentials", () => {
  const cases = [
    ["AWS access key", `const id = "${join("AKI", "A4KHJ2LMNP7QRST9V")}";`],
    ["GitHub PAT", `token: "${join("ghp", "_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8")}"`],
    ["Slack bot token", `slack = "${join("xox", "b-4827193056-a91ktvbz73qmxwe5rndl")}"`],
    ["Stripe live key", `stripe: "${join("sk", "_live_51KpQ8vBz3nWxYtRc7mLd2fHa")}"`],
    ["OpenAI key", `openai = "${join("sk-pro", "j-9vBnQ2wErTyUiOpAsDfGhJkLzXcVbNm4")}"`],
    ["Anthropic key", `anthropic = "${join("sk-an", "t-api03-7zQmWvNbXcRtYuIoPaSdFgHjKl")}"`],
    ["Google API key", `g = "${join("AIz", "aSyD3nQ7vBmXpL2wRtYuIoKjHgFdSaZxCvB1")}"`],
    ["NVIDIA key", `nv = "${join("nvap", "i-8xKmQwErTyUiOpAsDfGhJkLzXcVbNm2Qp7Rt")}"`],
    ["Nora workspace key", `k = "${join("nor", "a_9fQm2WvNbXcRtYuIoPaSdFgHjKlZx7Cv")}"`],
    [
      "Slack webhook",
      join("https://hooks.slack.", "com/services/T02KQ7VBM/B04NXQ8LP/9vBnQ2wErTyUiOpAsDfG"),
    ],
  ];
  for (const [label, content] of cases) assertDetected(content, label);
});

test("detects a private key block with real body material", () => {
  const body = join(
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn",
  ).repeat(3);
  assertDetected(`${join("-----BEGIN OPENSSH ", "PRIVATE KEY-----")}\n${body}\n`, "private key");
});

test("detects Nora secret material assigned literally", () => {
  const cases = [
    ["JWT_SECRET", "JWT_SECRET=7f3a9c2e5b8d1f4a6c0e3b7d9f2a5c8e1b4d7f0a3c6e9b2d5f8a1c4e7b0d3f6a"],
    [
      "ENCRYPTION_KEY",
      "ENCRYPTION_KEY=a4d7f0c3e6b9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7",
    ],
    ["DB_PASSWORD", 'DB_PASSWORD: "Xq7Rt2Wv9NbMc4Zp8Kd3"'],
    ["backup encryption key", "NORA_BACKUP_ENCRYPTION_KEY=3c6e9b2d5f8a1c4e7b0d3f6a9c2e5b8d"],
  ];
  for (const [label, content] of cases) assertDetected(content, label);
});

test("ignores source code that merely references secret names", () => {
  const cases = [
    ["random assignment", 'process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");'],
    [
      "regex validation",
      "const ENCRYPTION_KEY = /^[0-9a-fA-F]{64}$/.test(RAW_KEY) ? RAW_KEY : null;",
    ],
    ["powershell helper", '$JWT_SECRET = Read-EnvValue -EnvPath $ENV_FILE -Name "JWT_SECRET"'],
    ["env indirection", "ENCRYPTION_KEY=${ENCRYPTION_KEY}"],
    ["actions secret", "PROXMOX_TOKEN_SECRET: ${{ secrets.PROXMOX_TOKEN_SECRET }}"],
    ["url value", 'NVIDIA_API_KEY: "https://integrate.api.nvidia.com/v1"'],
  ];
  for (const [label, content] of cases) assertClean(content, label);
});

test("does not read a value across a line break", () => {
  // An empty assignment followed by an unrelated line is the .env.example and
  // shell-script shape that made the first draft report 41 false positives.
  assertClean("NORA_BACKUP_S3_SECRET_ACCESS_KEY=\nSOME_OTHER_SETTING=enabled", "empty assignment");
  assertClean("PROXMOX_TOKEN_SECRET:\n  description: token", "yaml key with nested value");
});

test("ignores documented placeholders and fixtures", () => {
  const cases = [
    ["angle placeholder", "ENCRYPTION_KEY=<REPLACE_WITH_64_HEX_CHARS>"],
    ["aws doc key", `const validKey = "${join("AKI", "AIOSFODNN7EXAMPLE")}";`],
    ["slack doc token", `"token":"${join("xox", "b-your-slack-bot-token")}"`],
    ["pem ui label", `{isEditing ? "" : "${join("-----BEGIN OPENSSH ", "PRIVATE KEY-----")}"}`],
    ["short stub", "JWT_SECRET=changeme"],
    [
      "allowlisted test key",
      "ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
  ];
  for (const [label, content] of cases) assertClean(content, label);
});

test("reports the correct line number", () => {
  const content =
    "line one\nline two\nJWT_SECRET=7f3a9c2e5b8d1f4a6c0e3b7d9f2a5c8e1b4d7f0a3c6e9b2d\n";
  const [finding] = scanContent("sample.env", content);
  assert.equal(finding.line, 3);
  assert.equal(finding.filePath, "sample.env");
});
