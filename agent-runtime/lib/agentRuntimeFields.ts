// @ts-nocheck
const {
  DEFAULT_RUNTIME_FAMILY,
  backendForRuntimeSelection,
  deployTargetFromExecutionTargetId,
  getDefaultDeployTarget,
  getDefaultRuntimeFamily,
  getDefaultSandboxProfile,
  isKnownRuntimeFamily,
  isKnownSandboxProfile,
  normalizeExecutionTargetId,
  normalizeDeployTargetName,
  normalizeRuntimeFamilyName,
  normalizeSandboxProfileName,
} = require("./backendCatalog");

const LEGACY_BACKEND_TYPE_ALIASES = new Set(["hermes", "nemoclaw"]);

function hasText(value) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

function firstTextValue(...values) {
  return values.find((value) => hasText(value)) ?? null;
}

function unknownRuntimeSelectionError(label, code, value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  const error = new Error(`Unknown ${label}: ${normalized}`);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function parseRuntimeFamily(value) {
  if (!hasText(value)) return null;
  if (!isKnownRuntimeFamily(value)) {
    throw unknownRuntimeSelectionError("runtime family", "UNKNOWN_RUNTIME_FAMILY", value);
  }
  return normalizeRuntimeFamilyName(value);
}

function parseDeployTarget(value, { allowLegacyBackendAlias = false } = {}) {
  if (!hasText(value)) return null;

  const normalizedValue = String(value).trim().toLowerCase();
  if (allowLegacyBackendAlias && LEGACY_BACKEND_TYPE_ALIASES.has(normalizedValue)) {
    return null;
  }

  try {
    return normalizeDeployTargetName(value);
  } catch (error) {
    if (error?.code === "UNKNOWN_DEPLOY_TARGET" && error.statusCode == null) {
      error.statusCode = 400;
    }
    throw error;
  }
}

function parseExecutionTargetId(value, { allowLegacyBackendAlias = false } = {}) {
  if (!hasText(value)) return null;

  const normalizedValue = String(value).trim().toLowerCase();
  if (allowLegacyBackendAlias && LEGACY_BACKEND_TYPE_ALIASES.has(normalizedValue)) {
    return null;
  }

  const executionTargetId = normalizeExecutionTargetId(value);
  if (executionTargetId) return executionTargetId;

  // Reuse the canonical deploy-target error contract so request handlers and
  // persisted-row consumers fail closed with one stable code/status shape.
  parseDeployTarget(value);
  return null;
}

function parseSandboxProfile(value) {
  if (!hasText(value)) return null;
  if (!isKnownSandboxProfile(value)) {
    throw unknownRuntimeSelectionError("sandbox profile", "UNKNOWN_SANDBOX_PROFILE", value);
  }
  return normalizeSandboxProfileName(value);
}

function normalizeRequestedDeployTarget(value, options = {}) {
  return parseDeployTarget(value, options);
}

function normalizeRequestedExecutionTargetId(value, options = {}) {
  return parseExecutionTargetId(value, options);
}

function resolveFallbackRuntimeFields(fallback = {}) {
  if (fallback && Object.keys(fallback).length > 0) {
    return buildAgentRuntimeFields(fallback);
  }

  return buildAgentRuntimeFields({
    runtime_family: getDefaultRuntimeFamily(process.env),
  });
}

function hasNewRuntimeSelection(agent = {}) {
  return Boolean(
    parseRuntimeFamily(agent.runtime_family ?? agent.runtimeFamily) ||
    parseDeployTarget(agent.deploy_target ?? agent.deployTarget) ||
    parseExecutionTargetId(agent.execution_target_id ?? agent.executionTargetId) ||
    parseSandboxProfile(agent.sandbox_profile ?? agent.sandboxProfile),
  );
}

function resolveAgentRuntimeFamily(agent = {}) {
  const explicitRuntimeFamily = parseRuntimeFamily(agent.runtime_family ?? agent.runtimeFamily);
  if (explicitRuntimeFamily) return explicitRuntimeFamily;

  return getDefaultRuntimeFamily(process.env) || DEFAULT_RUNTIME_FAMILY;
}

function resolveAgentSandboxProfile(agent = {}) {
  const explicitSandbox = parseSandboxProfile(agent.sandbox_profile ?? agent.sandboxProfile);
  if (explicitSandbox) return explicitSandbox;

  const legacySandbox = parseSandboxProfile(agent.sandbox_type ?? agent.sandboxType);
  if (legacySandbox) return legacySandbox;

  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  return getDefaultSandboxProfile(process.env, { runtimeFamily });
}

function resolveAgentDeployTarget(agent = {}) {
  const explicitDeployTarget = parseDeployTarget(
    firstTextValue(
      agent.deploy_target,
      agent.deployTarget,
      agent.execution_target_id,
      agent.executionTargetId,
    ),
  );
  if (explicitDeployTarget) return explicitDeployTarget;

  const backendDeployTarget = parseDeployTarget(
    agent.backend_type ?? agent.backendType ?? agent.backend,
    { allowLegacyBackendAlias: true },
  );
  if (backendDeployTarget) return backendDeployTarget;

  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  const sandboxProfile = resolveAgentSandboxProfile({
    ...agent,
    runtime_family: runtimeFamily,
  });
  return getDefaultDeployTarget(process.env, {
    runtimeFamily,
    sandbox: sandboxProfile,
  });
}

function resolveAgentExecutionTargetId(agent = {}) {
  const explicitExecutionTarget = parseExecutionTargetId(
    firstTextValue(
      agent.execution_target_id,
      agent.executionTargetId,
      agent.deploy_target,
      agent.deployTarget,
    ),
  );
  if (explicitExecutionTarget) return explicitExecutionTarget;

  const deployTarget = resolveAgentDeployTarget(agent);
  return parseExecutionTargetId(deployTarget) || deployTarget;
}

function resolveAgentBackendType(agent = {}) {
  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  const sandboxProfile = resolveAgentSandboxProfile({
    ...agent,
    runtime_family: runtimeFamily,
  });
  const deployTarget = resolveAgentDeployTarget({
    ...agent,
    runtime_family: runtimeFamily,
    sandbox_profile: sandboxProfile,
  });

  return backendForRuntimeSelection({
    runtimeFamily,
    deployTarget,
    sandboxProfile,
  });
}

function resolveAgentSandboxType(agent = {}) {
  return resolveAgentSandboxProfile(agent);
}

function buildAgentRuntimeFields(agent = {}) {
  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  const deployTarget = resolveAgentDeployTarget({
    ...agent,
    runtime_family: runtimeFamily,
  });
  const executionTargetId = resolveAgentExecutionTargetId({
    ...agent,
    runtime_family: runtimeFamily,
  });
  const executionDeployTarget = deployTargetFromExecutionTargetId(executionTargetId);
  if (executionDeployTarget !== deployTarget) {
    const error = new Error(
      `Execution target ${executionTargetId} belongs to deploy target ${executionDeployTarget}, not ${deployTarget}.`,
    );
    error.code = "RUNTIME_SELECTION_TARGET_MISMATCH";
    error.statusCode = 400;
    throw error;
  }
  const sandboxProfile = resolveAgentSandboxProfile({
    ...agent,
    runtime_family: runtimeFamily,
    deploy_target: deployTarget,
  });
  const backendType = resolveAgentBackendType({
    ...agent,
    runtime_family: runtimeFamily,
    deploy_target: deployTarget,
    execution_target_id: executionTargetId,
    sandbox_profile: sandboxProfile,
  });

  return {
    runtime_family: runtimeFamily,
    deploy_target: deployTarget,
    execution_target_id: executionTargetId,
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
    leftRuntime.execution_target_id === rightRuntime.execution_target_id &&
    leftRuntime.sandbox_profile === rightRuntime.sandbox_profile
  );
}

function resolveRequestedRuntimeFields({ request = {}, fallback = {} } = {}) {
  const fallbackRuntime = resolveFallbackRuntimeFields(fallback);
  const requestedRuntimeFamily = parseRuntimeFamily(
    request.runtime_family ?? request.runtimeFamily,
  );
  const effectiveRuntimeFamily =
    requestedRuntimeFamily ||
    fallbackRuntime.runtime_family ||
    getDefaultRuntimeFamily(process.env) ||
    DEFAULT_RUNTIME_FAMILY;
  const runtimeFamilyChanged =
    Boolean(requestedRuntimeFamily) && requestedRuntimeFamily !== fallbackRuntime.runtime_family;
  const rawRequestedDeployTarget = request.deploy_target ?? request.deployTarget;
  const rawRequestedExecutionTarget =
    request.execution_target_id ?? request.executionTargetId ?? request.executionTarget;
  const rawRequestedBackend = request.backend ?? request.backend_type ?? request.backendType;
  const requestedExecutionTargetId =
    normalizeRequestedExecutionTargetId(rawRequestedExecutionTarget) ||
    normalizeRequestedExecutionTargetId(rawRequestedDeployTarget) ||
    normalizeRequestedExecutionTargetId(rawRequestedBackend, { allowLegacyBackendAlias: true });
  const requestedDeployTarget =
    normalizeRequestedDeployTarget(rawRequestedDeployTarget) ||
    normalizeRequestedDeployTarget(rawRequestedBackend, { allowLegacyBackendAlias: true }) ||
    normalizeRequestedDeployTarget(requestedExecutionTargetId);
  const requestedSandboxProfile = parseSandboxProfile(
    request.sandbox_profile ??
      request.sandboxProfile ??
      request.sandbox ??
      request.sandbox_type ??
      request.sandboxType,
  );
  const placementRequested =
    hasText(rawRequestedDeployTarget) ||
    hasText(rawRequestedExecutionTarget) ||
    hasText(rawRequestedBackend);
  const defaultRuntimeFields = runtimeFamilyChanged
    ? buildAgentRuntimeFields({
        runtime_family: effectiveRuntimeFamily,
      })
    : fallbackRuntime;
  const sandboxProfile =
    requestedSandboxProfile ||
    (!placementRequested && !runtimeFamilyChanged ? defaultRuntimeFields.sandbox_profile : null) ||
    getDefaultSandboxProfile(process.env, {
      runtimeFamily: effectiveRuntimeFamily,
    });
  const deployTarget =
    requestedDeployTarget ||
    (!placementRequested && !runtimeFamilyChanged ? defaultRuntimeFields.deploy_target : null) ||
    getDefaultDeployTarget(process.env, {
      runtimeFamily: effectiveRuntimeFamily,
      sandbox: sandboxProfile,
    });
  const executionTargetId =
    requestedExecutionTargetId ||
    (!placementRequested && !runtimeFamilyChanged
      ? defaultRuntimeFields.execution_target_id
      : null) ||
    normalizeRequestedExecutionTargetId(deployTarget) ||
    deployTarget;

  return buildAgentRuntimeFields({
    runtime_family: effectiveRuntimeFamily,
    deploy_target: deployTarget,
    execution_target_id: executionTargetId,
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
  resolveAgentExecutionTargetId,
  resolveAgentRuntimeFamily,
  resolveAgentSandboxProfile,
  resolveAgentSandboxType,
};
