// @ts-nocheck
const {
  getDefaultDeployTarget,
  getDefaultRuntimeFamily,
  getDefaultSandboxProfile,
  normalizeDeployTargetName,
  normalizeRuntimeFamilyName,
  normalizeSandboxProfileName,
} = require("./backendCatalog");
const { getNemoClawSandboxImage } = require("./nemoclawDefaults");

function getProvisionerBackendName() {
  return getDefaultDeployTarget(process.env, {
    runtimeFamily: getDefaultRuntimeFamily(process.env),
    sandbox: getDefaultSandboxProfile(process.env),
  });
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
  return getNemoClawSandboxImage(process.env);
}

function getDefaultAgentImage({
  runtime_family,
  runtimeFamily,
  sandbox = "standard",
  sandbox_profile,
  sandboxProfile,
  deploy_target,
  deployTarget,
  backend,
} = {}) {
  const resolvedRuntimeFamily = normalizeRuntimeFamilyName(
    runtime_family ?? runtimeFamily ?? getDefaultRuntimeFamily(process.env),
  );
  const resolvedSandboxProfile = normalizeSandboxProfileName(
    sandbox_profile ??
      sandboxProfile ??
      sandbox ??
      getDefaultSandboxProfile(process.env, { runtimeFamily: resolvedRuntimeFamily }),
  );
  const resolvedDeployTarget = normalizeDeployTargetName(
    deploy_target ??
      deployTarget ??
      backend ??
      getDefaultDeployTarget(process.env, {
        runtimeFamily: resolvedRuntimeFamily,
        sandbox: resolvedSandboxProfile,
      }),
  );

  if (resolvedRuntimeFamily === "hermes") {
    return resolvedDeployTarget === "proxmox"
      ? process.env.PROXMOX_HERMES_TEMPLATE || getHermesDockerAgentImage()
      : getHermesDockerAgentImage();
  }

  if (resolvedSandboxProfile === "nemoclaw") {
    return resolvedDeployTarget === "proxmox"
      ? process.env.PROXMOX_NEMOCLAW_TEMPLATE || getNemoClawAgentImage()
      : getNemoClawAgentImage();
  }

  if (resolvedDeployTarget === "docker") {
    return getStandardDockerAgentImage();
  }

  if (resolvedDeployTarget === "proxmox") {
    return (
      process.env.PROXMOX_TEMPLATE || "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
    );
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
  normalizeBackendName: normalizeDeployTargetName,
};
