const {
  getDefaultBackend,
  normalizeBackendName,
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

function getNemoClawAgentImage() {
  return (
    process.env.NEMOCLAW_SANDBOX_IMAGE ||
    "ghcr.io/nvidia/openshell-community/sandboxes/openclaw"
  );
}

function getDefaultAgentImage({
  sandbox = "standard",
  backend = getProvisionerBackendName(),
} = {}) {
  if (sandbox === "nemoclaw") {
    return getNemoClawAgentImage();
  }

  if (normalizeBackendName(backend) === "docker") {
    return getStandardDockerAgentImage();
  }

  return process.env.OPENCLAW_STANDARD_IMAGE || "node:22-slim";
}

module.exports = {
  getDefaultAgentImage,
  getNemoClawAgentImage,
  getProvisionerBackendName,
  getStandardDockerAgentImage,
  getStandardDockerPackageSpec,
  normalizeBackendName,
};
