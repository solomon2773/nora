import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (file) => readFileSync(path.join(repoRoot, file), "utf8");

test("root license is the canonical Apache-2.0 text", () => {
  const digest = createHash("sha256").update(readRepoFile("LICENSE"), "utf8").digest("hex");
  assert.equal(digest, "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
});

test("repository attribution and public license copy stay aligned", () => {
  assert.equal(readRepoFile("NOTICE"), "Nora\nCopyright 2026 Nora Contributors\n");
  assert.match(readRepoFile("README.md"), /Apache License 2\.0/);
  assert.match(readRepoFile("CONTRIBUTING.md"), /Nora is Apache-2\.0 licensed/);
});
