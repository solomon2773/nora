const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { version } = require("../package.json");

const entrypoint = path.join(__dirname, "index.js");

test("root help exposes the repository and a single support prompt", () => {
  const result = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8" });

  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /Repository: https:\/\/github\.com\/solomon2773\/nora/);
  assert.match(result.stdout, /consider starring it/);
  assert.doesNotMatch(result.stdout, /Docs: https:\/\/github\.com\/solomon2773\/nora/);
});

test("--version prints only the package version", () => {
  const result = spawnSync(process.execPath, [entrypoint, "--version"], { encoding: "utf8" });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, `${version}\n`);
  assert.strictEqual(result.stderr, "");
});
