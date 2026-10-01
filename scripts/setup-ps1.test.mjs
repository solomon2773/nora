// Runs scripts/setup-ps1-log-settings.test.ps1, which exercises the real
// logging functions in setup.ps1 (the upgrade-vs-install defaults and the env
// filler). Needs PowerShell 7; skipped, with a reason, where `pwsh` is absent.
// GitHub's ubuntu-latest and windows-latest runners both ship it.
//
// Run: node --test scripts/setup-ps1.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "setup-ps1-log-settings.test.ps1");

const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
  encoding: "utf8",
});
const pwshMajor = probe.status === 0 ? Number(probe.stdout.trim()) : null;

test(
  "setup.ps1 logging behaviour (upgrade defaults to No, env filler, CRLF files)",
  {
    skip:
      pwshMajor === null
        ? "pwsh is not installed"
        : pwshMajor < 7
          ? "PowerShell 7+ is required"
          : false,
  },
  () => {
    const result = spawnSync("pwsh", ["-NoProfile", "-File", script], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `PowerShell tests failed:\n${output}`);
    assert.match(output, /---- \d+ passed, 0 failed/);
    // Guard against the suite quietly shrinking.
    const passed = Number(output.match(/---- (\d+) passed/)?.[1] ?? 0);
    assert.ok(passed >= 25, `expected at least 25 checks, ran ${passed}`);
  },
);
