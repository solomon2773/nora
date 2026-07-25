// @ts-nocheck
const fs = require("fs");
const path = require("path");
const {
  PROXMOX_NEMOCLAW_BLOCKER_ISSUE,
  getBackendStatus,
  getRuntimeSelectionStatus,
} = require("../../agent-runtime/lib/backendCatalog");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/proxmox-real-hardware.yml"),
  "utf8",
);
const smokeScript = fs.readFileSync(
  path.resolve(__dirname, "../../e2e/scripts/run-proxmox-smoke.sh"),
  "utf8",
);
const docs = fs.readFileSync(
  path.resolve(__dirname, "../../docs/configuration/provisioner-backends/proxmox.mdx"),
  "utf8",
);

const SECURE_PRODUCTION_ENV = {
  NODE_ENV: "production",
  ENABLED_BACKENDS: "docker,proxmox",
  ENABLED_RUNTIME_FAMILIES: "openclaw,hermes",
  ENABLED_SANDBOX_PROFILES: "standard,nemoclaw",
  PROXMOX_API_URL: "https://pve.example.com:8006/api2/json",
  PROXMOX_TOKEN_ID: "nora@pve!provisioner",
  PROXMOX_TOKEN_SECRET: "secret",
  PROXMOX_NODE: "pve",
  PROXMOX_SSH_HOST: "pve.example.com",
  PROXMOX_SSH_USER: "nora-bootstrap",
  PROXMOX_SSH_PASSWORD: "secret",
  PROXMOX_SSH_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`,
  PROXMOX_OFFLINE_STAGE_COMMAND: "/usr/local/libexec/nora-proxmox-stage",
};

describe("Proxmox real-hardware release gate", () => {
  it("keeps the securely configured target experimental and NemoClaw blocked", () => {
    expect(getBackendStatus("proxmox", SECURE_PRODUCTION_ENV)).toEqual(
      expect.objectContaining({
        enabled: true,
        available: true,
        availableForOnboarding: true,
        maturityTier: "experimental",
      }),
    );
    expect(
      getRuntimeSelectionStatus(
        {
          runtime_family: "openclaw",
          deploy_target: "proxmox",
          sandbox_profile: "nemoclaw",
        },
        SECURE_PRODUCTION_ENV,
      ),
    ).toEqual(
      expect.objectContaining({
        available: false,
        issue: PROXMOX_NEMOCLAW_BLOCKER_ISSUE,
      }),
    );
  });

  it("requires an explicitly dispatched self-hosted real-hardware workflow", () => {
    expect(workflow).toMatch(/^name: Proxmox Real Hardware/m);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/runs-on: \[self-hosted, linux, x64, nora-proxmox\]/);
    expect(workflow).toMatch(/environment: proxmox-real-hardware/);
    expect(workflow).toContain("- name: Run destructive real-hardware lifecycle gate");
    expect(workflow).toMatch(/^\s+e2e\/scripts\/run-proxmox-smoke\.sh\s*$/m);
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).not.toContain("${{ runner.temp }}");
    expect(workflow).toContain("- name: Initialize qualification artifact paths");
    expect(workflow).toContain(
      'prefix="${RUNNER_TEMP}/nora-proxmox-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
  });

  it("releases Proxmox secrets only after validating an exact default-branch SHA", () => {
    expect(workflow).not.toContain("inputs.ref");
    expect(workflow).toContain('if [ "$GITHUB_REF" != "refs/heads/master" ]');
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/master');
    expect(workflow).toContain('echo "sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("needs: validate-target");
    expect(workflow).toContain("ref: ${{ needs.validate-target.outputs.sha }}");

    const validationJob = workflow.indexOf("  validate-target:");
    const protectedEnvironment = workflow.indexOf("    environment: proxmox-real-hardware");
    expect(validationJob).toBeGreaterThan(-1);
    expect(protectedEnvironment).toBeGreaterThan(validationJob);
  });

  it("names the external secrets and enforces secure production transport", () => {
    for (const name of [
      "PROXMOX_API_URL",
      "PROXMOX_TOKEN_ID",
      "PROXMOX_TOKEN_SECRET",
      "PROXMOX_SSH_HOST",
      "PROXMOX_SSH_USER",
      "PROXMOX_SSH_PRIVATE_KEY",
      "PROXMOX_SSH_PASSWORD",
      "PROXMOX_SSH_HOST_FINGERPRINT",
    ]) {
      expect(workflow).toContain(`secrets.${name}`);
    }
    expect(workflow).toContain('PROXMOX_VERIFY_TLS: "true"');
    expect(workflow).toContain('PROXMOX_ALLOW_INSECURE_HTTP: "false"');
    expect(workflow).toContain('PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY: "false"');
    expect(workflow).toContain(
      "PROXMOX_OFFLINE_STAGE_COMMAND: ${{ vars.PROXMOX_OFFLINE_STAGE_COMMAND }}",
    );
    expect(workflow).toContain('if [ "$PROXMOX_SSH_USER" != "root" ]; then');
    expect(workflow).toContain("required+=(PROXMOX_OFFLINE_STAGE_COMMAND)");
  });

  it("forwards host smoke overrides without placing secret values in Docker CLI argv", () => {
    expect(smokeScript).toContain("PROXMOX_SMOKE_RUNTIME_FAMILIES");
    expect(smokeScript).toContain("PROXMOX_SMOKE_KEEP_ON_FAILURE");
    expect(smokeScript).toContain('compose_exec_args+=(--env "$env_name")');
    expect(smokeScript).toContain('getBackendStatus("proxmox")');
  });

  it("requires confirmed exec completion and keeps public maturity claims experimental", () => {
    expect(smokeScript).toContain("state?.Running !== false || !Number.isInteger(state?.ExitCode)");
    expect(smokeScript).toContain("Proxmox exec output ended without a confirmed remote command");
    expect(smokeScript).toContain('catalogStatus.maturityTier === "experimental"');
    expect(docs).toContain("Proxmox support is experimental");
    expect(docs).toContain("does not automatically promote Proxmox beyond **Experimental**");
    expect(docs).toContain("Non-root offline staging helper contract");
    expect(docs).toContain("MIGRATION_CAPTURE_UNSUPPORTED");
    expect(docs).toContain("<helper> <numeric-vmid> <openclaw|hermes> <0|1>");
  });
});
