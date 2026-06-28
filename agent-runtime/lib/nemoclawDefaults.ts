// @ts-nocheck
// Shared NemoClaw defaults used by the catalog, provisioners, setup, and tests.

const NEMOCLAW_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const NEMOCLAW_SANDBOX_IMAGE_DEFAULT = "ghcr.io/solomon2773/nora-nemoclaw-agent:latest";
const NEMOCLAW_SANDBOX_IMAGE_LOCAL = "nora-nemoclaw-agent:local";

function getNemoClawDefaultModel(env = process.env) {
  return env.NEMOCLAW_DEFAULT_MODEL || NEMOCLAW_DEFAULT_MODEL;
}

function getNemoClawSandboxImage(env = process.env) {
  return env.NEMOCLAW_SANDBOX_IMAGE || NEMOCLAW_SANDBOX_IMAGE_DEFAULT;
}

module.exports = {
  NEMOCLAW_DEFAULT_MODEL,
  NEMOCLAW_SANDBOX_IMAGE_DEFAULT,
  NEMOCLAW_SANDBOX_IMAGE_LOCAL,
  getNemoClawDefaultModel,
  getNemoClawSandboxImage,
};
