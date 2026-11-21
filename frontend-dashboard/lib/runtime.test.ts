import assert from "node:assert/strict";
import test from "node:test";

import {
  activeExecutionTargetFromConfig,
  listingRuntimeFamily,
  mergeRemoteHostsIntoConfig,
  runtimeFamilyFilterOptions,
  runtimeSupportsAgentHubSharing,
  visibleSandboxOptionsFromTarget,
} from "./runtime";

function createBackendConfig(enabledSandboxProfiles = ["standard"]) {
  return {
    runtimeFamilies: [
      {
        id: "openclaw",
        label: "OpenClaw",
        enabledSandboxProfiles,
        executionTargets: [
          {
            id: "docker",
            adapter: "docker",
            deployTarget: "docker",
            enabled: true,
            configured: true,
            available: true,
            sandboxProfiles: [
              {
                id: "standard",
                label: "Standard",
                enabled: true,
                configured: true,
                available: true,
                onboardingVisible: true,
              },
            ],
          },
          {
            id: "remote-docker",
            adapter: "remote-docker",
            deployTarget: "remote-docker",
            runtimeFamily: "openclaw",
            runtimeFamilyLabel: "OpenClaw",
            enabled: false,
            configured: false,
            available: false,
            enabledSandboxProfiles: [],
            availableSandboxProfiles: [],
            supportedSandboxProfiles: ["standard", "nemoclaw"],
            sandboxProfiles: [
              {
                id: "standard",
                label: "Standard",
                enabled: false,
                configured: false,
                available: false,
                availableForOnboarding: false,
                onboardingVisible: true,
                issue: "Remote Docker requires a registered host.",
              },
              {
                id: "nemoclaw",
                label: "NemoClaw",
                sandboxProfileLabel: "NemoClaw",
                enabled: false,
                configured: false,
                available: false,
                availableForOnboarding: false,
                onboardingVisible: true,
                issue: "Remote Docker requires a registered host.",
              },
            ],
          },
        ],
      },
    ],
  };
}

const connectedHost = {
  executionTargetId: "remote:build-host",
  label: "Build host",
  sshHost: "10.0.0.24",
  sshPort: 22,
  sshUser: "nora",
  available: true,
  canDeploy: true,
};

test("connected Remote Docker hosts enable the runtime family's standard sandbox", () => {
  const backendConfig = createBackendConfig();
  const merged = mergeRemoteHostsIntoConfig(backendConfig, [connectedHost]);
  const target = activeExecutionTargetFromConfig(merged, "openclaw", "remote:build-host");

  assert.ok(target);
  assert.equal(target.adapter, "remote-docker");
  assert.equal(target.deployTarget, "remote-docker");
  assert.equal(target.available, true);
  assert.deepEqual(target.enabledSandboxProfiles, ["standard"]);
  assert.deepEqual(target.availableSandboxProfiles, ["standard"]);
  assert.equal(target.supportsSandboxSelection, false);
  assert.deepEqual(
    visibleSandboxOptionsFromTarget(target).map((profile) => profile.id),
    ["standard"],
  );
  assert.equal(target.sandboxProfiles[0].selectionId, "openclaw:remote:build-host:standard");
  assert.equal(target.sandboxProfiles[0].fullLabel, "OpenClaw + Build host");
  assert.equal(target.sandboxProfiles[1].enabled, false);

  assert.equal(
    backendConfig.runtimeFamilies[0].executionTargets[1].sandboxProfiles[0].enabled,
    false,
    "the public catalog fixture must remain immutable",
  );
});

test("connected Remote Docker hosts expose NemoClaw only when the family enables it", () => {
  const merged = mergeRemoteHostsIntoConfig(createBackendConfig(["standard", "nemoclaw"]), [
    connectedHost,
  ]);
  const target = activeExecutionTargetFromConfig(merged, "openclaw", "remote:build-host");

  assert.ok(target);
  assert.deepEqual(target.enabledSandboxProfiles, ["standard", "nemoclaw"]);
  assert.deepEqual(target.availableSandboxProfiles, ["standard", "nemoclaw"]);
  assert.equal(target.supportsSandboxSelection, true);
  assert.deepEqual(
    visibleSandboxOptionsFromTarget(target).map((profile) => profile.id),
    ["standard", "nemoclaw"],
  );
  assert.equal(target.sandboxProfiles[1].selectionId, "openclaw:remote:build-host:nemoclaw");
  assert.equal(target.sandboxProfiles[1].fullLabel, "OpenClaw + Build host + NemoClaw");
});

test("a NemoClaw-only runtime family selects NemoClaw as the concrete host default", () => {
  const backendConfig = createBackendConfig(["nemoclaw"]);
  const remoteTemplate = backendConfig.runtimeFamilies[0].executionTargets[1] as any;
  remoteTemplate.defaultSandboxProfile = "nemoclaw";

  const merged = mergeRemoteHostsIntoConfig(backendConfig, [connectedHost]);
  const target = activeExecutionTargetFromConfig(merged, "openclaw", "remote:build-host");

  assert.ok(target);
  assert.equal(target.defaultSandboxProfile, "nemoclaw");
  assert.equal(target.sandboxProfiles[0].isDefault, false);
  assert.equal(target.sandboxProfiles[1].isDefault, true);
  assert.deepEqual(
    visibleSandboxOptionsFromTarget(target).map((profile) => profile.id),
    ["nemoclaw"],
  );
});

// A hermes runtime family as /config/backends serves it: its own remote-docker
// placeholder (hermes supports remote Docker in the backend catalog), standard
// sandbox only. The placeholder deliberately omits `runtimeFamily` to pin that
// the merge takes the family from the family being merged, not the template.
function createHermesFamily() {
  return {
    id: "hermes",
    label: "Hermes",
    enabledSandboxProfiles: ["standard"],
    executionTargets: [
      {
        id: "docker",
        adapter: "docker",
        deployTarget: "docker",
        enabled: true,
        configured: true,
        available: true,
        sandboxProfiles: [
          {
            id: "standard",
            label: "Standard",
            enabled: true,
            configured: true,
            available: true,
            onboardingVisible: true,
          },
        ],
      },
      {
        id: "remote-docker",
        adapter: "remote-docker",
        deployTarget: "remote-docker",
        enabled: false,
        configured: false,
        available: false,
        sandboxProfiles: [
          {
            id: "standard",
            label: "Standard",
            enabled: false,
            configured: false,
            available: false,
            availableForOnboarding: false,
            onboardingVisible: true,
            issue: "Remote Docker requires a registered host.",
          },
        ],
      },
    ],
  };
}

test("connected Remote Docker hosts appear for the hermes family too — full parity (#455)", () => {
  const backendConfig = createBackendConfig();
  backendConfig.runtimeFamilies.push(createHermesFamily() as any);

  const merged = mergeRemoteHostsIntoConfig(backendConfig, [connectedHost]);
  const target = activeExecutionTargetFromConfig(merged, "hermes", "remote:build-host");

  assert.ok(target, "the hermes family must receive a selectable remote host target");
  assert.equal(target.adapter, "remote-docker");
  assert.equal(target.deployTarget, "remote-docker");
  assert.equal(target.available, true);
  assert.equal(target.runtimeFamily, "hermes");
  assert.deepEqual(target.enabledSandboxProfiles, ["standard"]);
  assert.equal(target.sandboxProfiles[0].selectionId, "hermes:remote:build-host:standard");
  assert.equal(target.sandboxProfiles[0].fullLabel, "Hermes + Build host");

  // And the openclaw family still gets its own host target alongside.
  const openclawTarget = activeExecutionTargetFromConfig(merged, "openclaw", "remote:build-host");
  assert.ok(openclawTarget);
  assert.equal(openclawTarget.runtimeFamily, "openclaw");
});

test("a family whose catalog has no remote-docker target is returned untouched", () => {
  const hermesFamily = createHermesFamily() as any;
  hermesFamily.executionTargets = hermesFamily.executionTargets.filter(
    (target: any) => target.deployTarget !== "remote-docker",
  );
  const backendConfig = { runtimeFamilies: [hermesFamily] };

  const merged = mergeRemoteHostsIntoConfig(backendConfig, [connectedHost]);

  // No placeholder means the catalog says this family does not support remote
  // Docker — a docker target alone must not conjure remote host entries.
  assert.equal(merged.runtimeFamilies[0], hermesFamily);
});

test("unavailable or view-only remote hosts do not become deploy targets", () => {
  const backendConfig = createBackendConfig();

  assert.equal(
    mergeRemoteHostsIntoConfig(backendConfig, [{ ...connectedHost, available: false }]),
    backendConfig,
  );
  assert.equal(
    mergeRemoteHostsIntoConfig(backendConfig, [{ ...connectedHost, canDeploy: false }]),
    backendConfig,
  );
});

test("runtimeSupportsAgentHubSharing includes both openclaw and hermes", () => {
  assert.equal(runtimeSupportsAgentHubSharing("openclaw"), true);
  assert.equal(runtimeSupportsAgentHubSharing("hermes"), true);
  assert.equal(runtimeSupportsAgentHubSharing({ runtime_family: "hermes" }), true);
  assert.equal(runtimeSupportsAgentHubSharing({}), true);
  assert.equal(runtimeSupportsAgentHubSharing("quantumclaw"), false);
});

test("listingRuntimeFamily resolves the listing field, template summary, then openclaw", () => {
  assert.equal(listingRuntimeFamily({ runtime_family: "hermes" }), "hermes");
  assert.equal(listingRuntimeFamily({ runtimeFamily: "hermes" }), "hermes");
  assert.equal(listingRuntimeFamily({ template: { runtimeFamily: "hermes" } }), "hermes");
  assert.equal(
    listingRuntimeFamily({ runtime_family: "openclaw", template: { runtimeFamily: "hermes" } }),
    "openclaw",
  );
  assert.equal(listingRuntimeFamily({ runtime_family: "unknown-family" }), "openclaw");
  assert.equal(listingRuntimeFamily({}), "openclaw");
  assert.equal(listingRuntimeFamily(null), "openclaw");
});

test("runtimeFamilyFilterOptions only offers a filter when families are mixed", () => {
  assert.deepEqual(runtimeFamilyFilterOptions([]), []);
  assert.deepEqual(runtimeFamilyFilterOptions([{ runtime_family: "openclaw" }, {}]), []);
  assert.deepEqual(
    runtimeFamilyFilterOptions([{ runtime_family: "hermes" }, { runtime_family: "hermes" }]),
    [],
  );
  assert.deepEqual(
    runtimeFamilyFilterOptions([{ runtime_family: "hermes" }, { runtime_family: "openclaw" }, {}]),
    ["openclaw", "hermes"],
  );
});
