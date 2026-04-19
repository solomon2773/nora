// @ts-nocheck
const {
  deployTargetForBackend,
  getDefaultBackend,
  getDefaultDeployTarget,
  isKnownSandboxProfile,
  normalizeBackendName,
  runtimeFamilyForBackend,
} = require("./backendCatalog");

function getProvisionerBackendName() {
  return getDefaultBackend(process.env, { sandbox: "standard" });
}

function getStandardDockerAgentImage() {
  return process.env.OPENCLAW_DOCKER_IMAGE || "nora-openclaw-agent:local";
}

function getStandardDockerPackageSpec() {
  return process.env.OPENCLAW_DOCKER_PACKAGE || "openclaw@latest";
}

function getHermesDockerAgentImage() {
  return process.env.HERMES_DOCKER_IMAGE || "nousresearch/hermes-agent:latest";
}

function getNemoClawAgentImage() {
  return (
    process.env.NEMOCLAW_SANDBOX_IMAGE ||
    "ghcr.io/nvidia/openshell-community/sandboxes/openclaw"
  );
}

function normalizeRequestedSandboxProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (isKnownSandboxProfile(normalized)) return normalized;
  return null;
}

function resolveProvisionerBackend({ backend, deployTarget, sandboxProfile }) {
  const normalizedBackend = String(backend || "").trim().toLowerCase();
  if (normalizedBackend) {
    return normalizeBackendName(normalizedBackend);
  }

  const normalizedDeployTarget = String(deployTarget || "").trim().toLowerCase();
  if (normalizedDeployTarget === "nemoclaw") {
    return "nemoclaw";
  }
  if (sandboxProfile === "nemoclaw") {
    return "nemoclaw";
  }

  return getDefaultBackend(process.env, { sandbox: sandboxProfile || "standard" });
}

function getDefaultAgentImage({
  sandbox = "standard",
  backend = getProvisionerBackendName(),
  sandbox_profile,
  sandboxProfile,
  deploy_target,
  deployTarget,
} = {}) {
  const resolvedBackend = resolveProvisionerBackend({
    backend,
    deployTarget: deploy_target ?? deployTarget,
    sandboxProfile:
      normalizeRequestedSandboxProfile(
        sandbox_profile ?? sandboxProfile ?? sandbox
      ) || "standard",
  });
  const resolvedRuntimeFamily = runtimeFamilyForBackend(resolvedBackend);
  const resolvedSandboxProfile =
    normalizeRequestedSandboxProfile(
      sandbox_profile ?? sandboxProfile ?? sandbox
    ) ||
    (resolvedBackend === "nemoclaw" ? "nemoclaw" : "standard");

  if (resolvedRuntimeFamily === "hermes") {
    return getHermesDockerAgentImage();
  }

  if (resolvedSandboxProfile === "nemoclaw") {
    return getNemoClawAgentImage();
  }

  const resolvedDeployTarget =
    deploy_target ??
    deployTarget ??
    deployTargetForBackend(resolvedBackend) ??
    getDefaultDeployTarget(process.env, { sandbox: resolvedSandboxProfile });

  if (normalizeBackendName(resolvedDeployTarget) === "docker") {
    return getStandardDockerAgentImage();
  }

  return process.env.OPENCLAW_STANDARD_IMAGE || "node:24-slim";
}

module.exports = {
  getDefaultAgentImage,
  getHermesDockerAgentImage,
  getNemoClawAgentImage,
  getProvisionerBackendName,
  getStandardDockerAgentImage,
  getStandardDockerPackageSpec,
  normalizeBackendName,
};
