// Logging control plane Phase 14 items 4 and 8: render-time guards in
// infra/helm/nora/templates/configmap-env.yaml that must FAIL the chart
// render (not merely warn) for two unsupported configurations:
//
//   1. `local` log storage selected (or left at its application default,
//      which is also `local`) while installing via Helm — there is no
//      shared/local disk for log segments in-cluster, so this is
//      unconditionally unsupported on Kubernetes (Design Decision 2d). This
//      mirrors the exact rule PUT /admin/log-storage enforces at runtime
//      (routes/observability.ts, code: "local_unsupported_with_k8s") —
//      `local` is rejected, `ssh` remains allowed.
//   2. `workerProvisioner.replicas` set above 1 — the log collector's
//      in-memory per-agent buffer lives on exactly one worker-provisioner
//      replica, and nothing routes a backend-api buffer read to the correct
//      replica among several.
//
// Run via `node --test` (this package convention — see
// .github/workflows/scripts/validate-infra.mjs and its sibling
// scripts/infra-security.test.mjs, both invoked by `npm run
// ci:validate-infra`). Exercises the real `helm` CLI (`helm template`), not
// just the template source, matching how validate-infra.mjs already
// validates this chart.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chartDir = path.resolve(__dirname, "..");

// Dummy values so the chart renders past its required-secret guards — same
// values validate-infra.mjs's HELM_CI_VALUES uses, duplicated here (rather
// than imported) since that file is a script, not a module with exports,
// and this test needs to stay runnable standalone.
const BASE_ARGS = [
  "template",
  "nora-log-storage-test",
  chartDir,
  "--set",
  "secrets.jwtSecret=test-dummy-jwt-secret-0000000000000000",
  "--set",
  "secrets.encryptionKey=test-dummy-encryption-key-00000000000",
  "--set",
  "secrets.backupEncryptionKey=test-dummy-backup-key-0000000000000",
  "--set",
  "secrets.apiKeyHashSecret=test-dummy-hash-secret-0000000000000",
  "--set",
  "secrets.agentHubApiKeyHashSecret=test-dummy-agent-hub-hash-secret-00",
  "--set",
  "secrets.dbPassword=test-dummy-db-password",
];

function helmTemplate(extraArgs = []) {
  return execFileSync("helm", [...BASE_ARGS, ...extraArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function helmTemplateExpectFailure(extraArgs = []) {
  try {
    helmTemplate(extraArgs);
    throw new Error("expected `helm template` to fail, but it succeeded");
  } catch (error) {
    // execFileSync throws with stdout/stderr attached on a non-zero exit.
    const combined = `${error.stdout || ""}${error.stderr || ""}`;
    if (!combined) throw error; // rethrow if this wasn't actually a helm failure
    return combined;
  }
}

test("chart renders successfully with an s3 log storage destination", () => {
  const rendered = helmTemplate(["--set", "backendEnv.NORA_LOG_STORAGE=s3"]);
  assert.match(rendered, /kind: ConfigMap/);
});

test("chart renders successfully with an r2 log storage destination", () => {
  const rendered = helmTemplate(["--set", "backendEnv.NORA_LOG_STORAGE=r2"]);
  assert.match(rendered, /kind: ConfigMap/);
});

test("chart refuses to render when NORA_LOG_STORAGE is left unset (defaults to local)", () => {
  const output = helmTemplateExpectFailure([]);
  assert.match(output, /NORA_LOG_STORAGE/);
  assert.match(output, /local/);
});

test("chart refuses to render when NORA_LOG_STORAGE is explicitly local", () => {
  const output = helmTemplateExpectFailure(["--set", "backendEnv.NORA_LOG_STORAGE=local"]);
  assert.match(output, /NORA_LOG_STORAGE/);
  assert.match(output, /local/);
});

test("chart refuses to render when workerProvisioner.replicas is above 1", () => {
  const output = helmTemplateExpectFailure([
    "--set",
    "backendEnv.NORA_LOG_STORAGE=s3",
    "--set",
    "workerProvisioner.replicas=2",
  ]);
  assert.match(output, /workerProvisioner\.replicas/);
  assert.match(output, /single-buffer-owner|one worker-provisioner replica|buffer/i);
});

test("chart renders successfully with workerProvisioner.replicas left at its default of 1", () => {
  const rendered = helmTemplate(["--set", "backendEnv.NORA_LOG_STORAGE=s3"]);
  assert.match(rendered, /replicas: 1/);
});
