// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Intentionally-shell-executing handler for the agent runtime's /exec endpoint.
//
// This file is explicitly excluded from CodeQL analysis via
// .github/codeql-config.yml → paths-ignore. Rationale:
//
//   /exec IS the designed terminal surface of the agent runtime. Authenticated
//   callers pass an arbitrary shell command; it runs inside the agent's own
//   container. The container sandbox is the isolation boundary — not this
//   code. A CodeQL js/command-line-injection flag here is structurally correct
//   ("a shell is being fed untrusted input") but semantically the feature.
//   Isolating the handler into its own file keeps CodeQL focused on code that
//   SHOULDN'T exec shell commands, without blanket-disabling the rule.
//
// Keep this file small and single-purpose. Do NOT add anything here that
// would benefit from CodeQL coverage.
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require("child_process");

async function handleExec(body) {
  const cmd = body.command || body.cmd || "echo 'no command'";
  const timeout = body.timeout || 30000;
  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/sh",
    });
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch (e) {
    return {
      exitCode: e.status || 1,
      stdout: e.stdout || "",
      stderr: e.stderr || e.message,
    };
  }
}

module.exports = { handleExec };
