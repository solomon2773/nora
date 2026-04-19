// @ts-nocheck
const {
  DEFAULT_RUNTIME_FAMILY,
  backendForRuntimeSelection,
  deployTargetForBackend,
  getDefaultBackend,
  getDefaultDeployTarget,
  getDefaultSandboxProfile,
  isKnownBackend,
  isKnownDeployTarget,
  isKnownRuntimeFamily,
  normalizeBackendName,
  normalizeDeployTargetName,
  normalizeRuntimeFamilyName,
  runtimeFamilyForBackend,
  sandboxForBackend,
} = require("./backendCatalog");

function hasText(value) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

function normalizeLegacyBackend(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  return isKnownBackend(normalized) ? normalizeBackendName(normalized) : null;
}

function parseRuntimeFamily(value) {
  if (!isKnownRuntimeFamily(value)) return null;
  return normalizeRuntimeFamilyName(value);
}

function parseDeployTarget(value) {
  if (!isKnownDeployTarget(value)) return null;
  return normalizeDeployTargetName(value);
}

function parseSandboxProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "nemoclaw") return "nemoclaw";
  if (normalized === "standard") return "standard";
  return null;
}

function normalizeRequestedDeployTarget(value) {
  if (isKnownDeployTarget(value)) {
    return normalizeDeployTargetName(value);
  }

  const normalizedBackend = normalizeLegacyBackend(value);
  return normalizedBackend ? deployTargetForBackend(normalizedBackend) : null;
}

function resolveFallbackRuntimeFields(fallback = {}) {
  if (fallback && Object.keys(fallback).length > 0) {
    return buildAgentRuntimeFields(fallback);
  }

  return buildAgentRuntimeFields({ backend_type: getDefaultBackend(process.env) });
}

function hasNewRuntimeSelection(agent = {}) {
  return Boolean(
    parseRuntimeFamily(agent.runtime_family ?? agent.runtimeFamily) ||
      parseDeployTarget(agent.deploy_target ?? agent.deployTarget) ||
      parseSandboxProfile(agent.sandbox_profile ?? agent.sandboxProfile)
  );
}

function resolveAgentRuntimeFamily(agent = {}) {
  const explicitRuntimeFamily = parseRuntimeFamily(
    agent.runtime_family ?? agent.runtimeFamily
  );
  if (explicitRuntimeFamily) return explicitRuntimeFamily;

  const legacyBackend = normalizeLegacyBackend(
    agent.backend_type ?? agent.backendType
  );
  if (legacyBackend) {
    return runtimeFamilyForBackend(legacyBackend);
  }

  return DEFAULT_RUNTIME_FAMILY;
}

function resolveAgentSandboxProfile(agent = {}) {
  const explicitSandbox = parseSandboxProfile(
    agent.sandbox_profile ?? agent.sandboxProfile
  );
  if (explicitSandbox) return explicitSandbox;

  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  if (runtimeFamily === "hermes") {
    return "standard";
  }

  const explicitDeployTarget = parseDeployTarget(
    agent.deploy_target ?? agent.deployTarget
  );
  if (explicitDeployTarget && explicitDeployTarget !== "docker") {
    return "standard";
  }

  const legacySandbox = parseSandboxProfile(
    agent.sandbox_type ?? agent.sandboxType
  );
  if (legacySandbox) return legacySandbox;

  const legacyBackend = normalizeLegacyBackend(
    agent.backend_type ?? agent.backendType
  );
  if (legacyBackend) return sandboxForBackend(legacyBackend);

  return getDefaultSandboxProfile(process.env, { runtimeFamily });
}

function resolveAgentDeployTarget(agent = {}) {
  const explicitDeployTarget = parseDeployTarget(
    agent.deploy_target ?? agent.deployTarget
  );
  if (explicitDeployTarget) return explicitDeployTarget;

  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  if (runtimeFamily === "hermes") {
    return "docker";
  }

  const explicitSandbox = parseSandboxProfile(
    agent.sandbox_profile ?? agent.sandboxProfile
  );
  if (explicitSandbox === "nemoclaw") {
    return "docker";
  }

  const legacyBackend = normalizeLegacyBackend(
    agent.backend_type ?? agent.backendType
  );
  if (legacyBackend) return deployTargetForBackend(legacyBackend);

  const sandboxProfile = resolveAgentSandboxProfile(agent);
  if (sandboxProfile === "nemoclaw") {
    return "docker";
  }

  return getDefaultDeployTarget(process.env, { runtimeFamily, sandbox: sandboxProfile });
}

function resolveAgentBackendType(agent = {}) {
  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  const sandboxProfile = resolveAgentSandboxProfile(agent);
  const deployTarget = resolveAgentDeployTarget(agent);

  if (hasNewRuntimeSelection(agent)) {
    return backendForRuntimeSelection({
      runtimeFamily,
      deployTarget,
      sandboxProfile,
    });
  }

  const legacyBackend = normalizeLegacyBackend(
    agent.backend_type ?? agent.backendType
  );
  if (legacyBackend) return legacyBackend;

  return backendForRuntimeSelection({
    runtimeFamily,
    deployTarget,
    sandboxProfile,
  });
}

function resolveAgentSandboxType(agent = {}) {
  if (hasNewRuntimeSelection(agent)) {
    return resolveAgentSandboxProfile(agent);
  }

  const legacySandbox = parseSandboxProfile(
    agent.sandbox_type ?? agent.sandboxType
  );
  if (legacySandbox) return legacySandbox;

  return resolveAgentSandboxProfile(agent);
}

function buildAgentRuntimeFields(agent = {}) {
  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  const deployTarget = resolveAgentDeployTarget({
    ...agent,
    runtime_family: runtimeFamily,
  });
  const sandboxProfile = resolveAgentSandboxProfile({
    ...agent,
    runtime_family: runtimeFamily,
    deploy_target: deployTarget,
  });
  const backendType = resolveAgentBackendType({
    ...agent,
    runtime_family: runtimeFamily,
    deploy_target: deployTarget,
    sandbox_profile: sandboxProfile,
  });

  return {
    runtime_family: runtimeFamily,
    deploy_target: deployTarget,
    sandbox_profile: sandboxProfile,
    backend_type: backendType,
    sandbox_type: sandboxProfile,
  };
}

function isSameRuntimePath(left = {}, right = {}) {
  const leftRuntime = buildAgentRuntimeFields(left);
  const rightRuntime = buildAgentRuntimeFields(right);

  return (
    leftRuntime.runtime_family === rightRuntime.runtime_family &&
    leftRuntime.deploy_target === rightRuntime.deploy_target &&
    leftRuntime.sandbox_profile === rightRuntime.sandbox_profile
  );
}

function resolveRequestedRuntimeFields({ request = {}, fallback = {} } = {}) {
  const fallbackRuntime = resolveFallbackRuntimeFields(fallback);
  const requestedRuntimeFamily = parseRuntimeFamily(
    request.runtime_family ?? request.runtimeFamily
  );
  const effectiveRuntimeFamily =
    requestedRuntimeFamily ||
    fallbackRuntime.runtime_family ||
    DEFAULT_RUNTIME_FAMILY;
  const runtimeFamilyChanged =
    Boolean(requestedRuntimeFamily) &&
    requestedRuntimeFamily !== fallbackRuntime.runtime_family;
  const rawRequestedDeployTarget = request.deploy_target ?? request.deployTarget;
  const rawRequestedBackend =
    request.backend ?? request.backend_type ?? request.backendType;
  const requestedDeployTarget =
    normalizeRequestedDeployTarget(rawRequestedDeployTarget);
  const requestedBackend = normalizeLegacyBackend(rawRequestedBackend);
  const requestedSandboxProfile = parseSandboxProfile(
    request.sandbox_profile ??
      request.sandboxProfile ??
      request.sandbox ??
      request.sandbox_type ??
      request.sandboxType
  );
  const legacyNemoHint =
    effectiveRuntimeFamily === "openclaw" &&
    (normalizeLegacyBackend(rawRequestedDeployTarget) === "nemoclaw" ||
      requestedBackend === "nemoclaw");
  const placementRequested =
    hasText(rawRequestedDeployTarget) || hasText(rawRequestedBackend);
  const defaultRuntimeFields = runtimeFamilyChanged
    ? buildAgentRuntimeFields({
        runtime_family: effectiveRuntimeFamily,
        backend_type: getDefaultBackend(process.env, {
          runtimeFamily: effectiveRuntimeFamily,
        }),
      })
    : fallbackRuntime;
  const sandboxProfile =
    requestedSandboxProfile ||
    (legacyNemoHint ? "nemoclaw" : null) ||
    (placementRequested ? "standard" : defaultRuntimeFields.sandbox_profile) ||
    getDefaultSandboxProfile(process.env, {
      runtimeFamily: effectiveRuntimeFamily,
    });
  const deployTarget =
    requestedDeployTarget ||
    (requestedBackend ? deployTargetForBackend(requestedBackend) : null) ||
    (requestedSandboxProfile === "nemoclaw" || legacyNemoHint
      ? "docker"
      : null) ||
    (!placementRequested && !runtimeFamilyChanged
      ? defaultRuntimeFields.deploy_target
      : null) ||
    getDefaultDeployTarget(process.env, {
      runtimeFamily: effectiveRuntimeFamily,
      sandbox: sandboxProfile,
    });

  return buildAgentRuntimeFields({
    runtime_family: effectiveRuntimeFamily,
    deploy_target: deployTarget,
    sandbox_profile: sandboxProfile,
  });
}

function isNemoClawSandbox(agent = {}) {
  return resolveAgentSandboxProfile(agent) === "nemoclaw";
}

module.exports = {
  DEFAULT_RUNTIME_FAMILY,
  buildAgentRuntimeFields,
  hasNewRuntimeSelection,
  isNemoClawSandbox,
  isSameRuntimePath,
  parseDeployTarget,
  parseRuntimeFamily,
  parseSandboxProfile,
  resolveRequestedRuntimeFields,
  resolveAgentBackendType,
  resolveAgentDeployTarget,
  resolveAgentRuntimeFamily,
  resolveAgentSandboxProfile,
  resolveAgentSandboxType,
};
