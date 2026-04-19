const RUNTIME_FAMILY_LABELS = Object.freeze({
  openclaw: "OpenClaw",
  hermes: "Hermes",
});

type BackendConfig = {
  [key: string]: any;
  runtimeFamilies?: any[];
  runtimeFamily?: any;
  executionTargets?: any[];
};

type RuntimeTarget = {
  [key: string]: any;
  sandboxProfiles?: any[];
};

type AgentRuntimeMeta = {
  [key: string]: any;
  runtime_family?: string;
  backend_type?: string;
  deploy_target?: string;
  sandbox_profile?: string;
  sandbox_type?: string;
};

export function normalizeRuntimeFamily(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["openclaw", "hermes"].includes(normalized)) return normalized;
  return null;
}

export function normalizeDeployTarget(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "kubernetes") return "k8s";
  if (["docker", "k8s", "proxmox"].includes(normalized)) return normalized;
  return null;
}

export function normalizeSandboxProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "nemoclaw") return "nemoclaw";
  if (normalized === "standard") return "standard";
  return null;
}

export function runtimeFamilyFromConfig(
  backendConfig: BackendConfig = {},
  runtimeFamily = ""
) {
  const normalizedRuntimeFamily = normalizeRuntimeFamily(runtimeFamily);
  const runtimeFamilies = Array.isArray(backendConfig?.runtimeFamilies)
    ? backendConfig.runtimeFamilies
    : [];

  if (normalizedRuntimeFamily) {
    return runtimeFamilies.find((entry) => entry.id === normalizedRuntimeFamily) || null;
  }

  return (
    backendConfig?.runtimeFamily ||
    runtimeFamilies.find((entry) => entry.isDefault) ||
    runtimeFamilies[0] ||
    null
  );
}

export function enabledRuntimeFamiliesFromConfig(backendConfig: BackendConfig = {}) {
  return (backendConfig?.runtimeFamilies || []).filter(
    (runtimeFamily) => runtimeFamily.enabled !== false
  );
}

export function visibleRuntimeFamiliesFromConfig(
  backendConfig: BackendConfig = {},
  viewerRole = "user"
) {
  const isAdmin = viewerRole === "admin";
  const enabledRuntimeFamilies = enabledRuntimeFamiliesFromConfig(backendConfig);

  return isAdmin
    ? enabledRuntimeFamilies
    : enabledRuntimeFamilies.filter(
        (runtimeFamily) => runtimeFamily.availableForOnboarding !== false
      );
}

export function pickRuntimeFamilySelection(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
  currentRuntimeFamily = ""
) {
  const candidates = visibleRuntimeFamiliesFromConfig(backendConfig, viewerRole);
  const normalizedRuntimeFamily = normalizeRuntimeFamily(currentRuntimeFamily);
  const current = candidates.find((runtimeFamily) => runtimeFamily.id === normalizedRuntimeFamily);
  const nextRuntimeFamily =
    current ||
    candidates.find((runtimeFamily) => runtimeFamily.available && runtimeFamily.isDefault) ||
    candidates.find((runtimeFamily) => runtimeFamily.available) ||
    candidates[0] ||
    null;

  return nextRuntimeFamily?.id || "";
}

function executionTargetsForRuntimeFamily(
  backendConfig: BackendConfig = {},
  runtimeFamily = ""
) {
  const activeRuntimeFamily = runtimeFamilyFromConfig(backendConfig, runtimeFamily);
  if (Array.isArray(activeRuntimeFamily?.executionTargets)) {
    return activeRuntimeFamily.executionTargets;
  }
  return backendConfig?.executionTargets || [];
}

export function enabledExecutionTargetsFromConfig(
  backendConfig: BackendConfig = {},
  runtimeFamily = ""
) {
  return executionTargetsForRuntimeFamily(backendConfig, runtimeFamily).filter(
    (target) => target.enabled
  );
}

export function visibleExecutionTargetsFromConfig(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
  runtimeFamily = ""
) {
  const isAdmin = viewerRole === "admin";
  const enabledExecutionTargets = enabledExecutionTargetsFromConfig(
    backendConfig,
    runtimeFamily
  );

  return isAdmin
    ? enabledExecutionTargets
    : enabledExecutionTargets.filter((target) => target.availableForOnboarding);
}

export function activeExecutionTargetFromConfig(
  backendConfig: BackendConfig = {},
  runtimeFamilyOrExecutionTarget = "",
  maybeExecutionTarget?: string
) {
  const runtimeFamily =
    maybeExecutionTarget === undefined ? "" : runtimeFamilyOrExecutionTarget;
  const executionTarget =
    maybeExecutionTarget === undefined
      ? runtimeFamilyOrExecutionTarget
      : maybeExecutionTarget;
  const normalizedExecutionTarget = normalizeDeployTarget(executionTarget);

  return (
    enabledExecutionTargetsFromConfig(backendConfig, runtimeFamily).find(
      (target) => target.id === normalizedExecutionTarget
    ) || null
  );
}

export function visibleSandboxOptionsFromTarget(
  executionTarget: RuntimeTarget | null = null,
  viewerRole = "user"
) {
  const isAdmin = viewerRole === "admin";
  const enabledSandboxProfiles = (executionTarget?.sandboxProfiles || []).filter(
    (profile) => profile.enabled
  );

  return isAdmin
    ? enabledSandboxProfiles
    : enabledSandboxProfiles.filter((profile) => profile.availableForOnboarding);
}

export function activeSandboxOptionFromTarget(
  executionTarget: RuntimeTarget | null = null,
  sandboxProfile = ""
) {
  const normalizedSandboxProfile = normalizeSandboxProfile(sandboxProfile);
  return (
    (executionTarget?.sandboxProfiles || []).find(
      (profile) => profile.id === normalizedSandboxProfile
    ) || null
  );
}

export function pickExecutionTargetSelection(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
  currentExecutionTarget = "",
  runtimeFamily = ""
) {
  const candidates = visibleExecutionTargetsFromConfig(
    backendConfig,
    viewerRole,
    runtimeFamily
  );
  const normalizedExecutionTarget = normalizeDeployTarget(currentExecutionTarget);
  const current = candidates.find((target) => target.id === normalizedExecutionTarget);
  const nextTarget =
    current ||
    candidates.find((target) => target.available && target.isDefault) ||
    candidates.find((target) => target.available) ||
    candidates[0] ||
    null;

  return nextTarget?.id || "";
}

export function pickSandboxProfileSelection(
  executionTarget: RuntimeTarget | null = null,
  viewerRole = "user",
  currentSandboxProfile = ""
) {
  const candidates = visibleSandboxOptionsFromTarget(executionTarget, viewerRole);
  const normalizedSandboxProfile = normalizeSandboxProfile(currentSandboxProfile);
  const current = candidates.find((profile) => profile.id === normalizedSandboxProfile);
  const nextProfile =
    current ||
    candidates.find((profile) => profile.available && profile.isDefault) ||
    candidates.find((profile) => profile.available) ||
    candidates[0] ||
    null;

  return nextProfile?.id || "";
}

export function resolveAgentRuntimeFamily(agent: AgentRuntimeMeta = {}) {
  const explicitRuntimeFamily = normalizeRuntimeFamily(agent.runtime_family);
  if (explicitRuntimeFamily) return explicitRuntimeFamily;

  const legacyBackend = String(agent.backend_type || "").trim().toLowerCase();
  if (legacyBackend === "hermes") return "hermes";
  return "openclaw";
}

export function resolveAgentExecutionTarget(agent: AgentRuntimeMeta = {}) {
  const explicitDeployTarget = normalizeDeployTarget(agent.deploy_target);
  if (explicitDeployTarget) return explicitDeployTarget;

  const legacyBackend = String(agent.backend_type || "").trim().toLowerCase();
  if (legacyBackend === "nemoclaw" || legacyBackend === "hermes") return "docker";

  return normalizeDeployTarget(legacyBackend) || "docker";
}

export function resolveAgentSandboxProfile(agent: AgentRuntimeMeta = {}) {
  const explicitSandboxProfile =
    normalizeSandboxProfile(agent.sandbox_profile) ||
    normalizeSandboxProfile(agent.sandbox_type);
  if (explicitSandboxProfile) return explicitSandboxProfile;

  return String(agent.backend_type || "").trim().toLowerCase() === "nemoclaw"
    ? "nemoclaw"
    : "standard";
}

export function resolveBackendTypeForSelection({
  runtimeFamily = "openclaw",
  deployTarget = "docker",
  sandboxProfile = "standard",
} = {}) {
  if (normalizeRuntimeFamily(runtimeFamily) === "hermes") {
    return "hermes";
  }

  return normalizeSandboxProfile(sandboxProfile) === "nemoclaw"
    ? "nemoclaw"
    : normalizeDeployTarget(deployTarget) || "docker";
}

export function containerNamePrefixForSelection({
  runtimeFamily = "openclaw",
  sandboxProfile = "standard",
} = {}) {
  if (normalizeRuntimeFamily(runtimeFamily) === "hermes") {
    return "hermes-agent";
  }

  return normalizeSandboxProfile(sandboxProfile) === "nemoclaw"
    ? "oclaw-nemoclaw"
    : "oclaw-agent";
}

export function formatRuntimeFamilyLabel(value) {
  return RUNTIME_FAMILY_LABELS[normalizeRuntimeFamily(value)] || "OpenClaw";
}

export function formatExecutionTargetLabel(value) {
  switch (normalizeDeployTarget(value)) {
    case "k8s":
      return "Kubernetes";
    case "proxmox":
      return "Proxmox";
    default:
      return "Docker";
  }
}

export function formatSandboxProfileLabel(value) {
  return normalizeSandboxProfile(value) === "nemoclaw" ? "NemoClaw" : "Standard";
}

export function formatRuntimePathLabel(agent: AgentRuntimeMeta = {}) {
  if (resolveAgentRuntimeFamily(agent) === "hermes") {
    return "Hermes + Docker";
  }

  if (resolveAgentSandboxProfile(agent) === "nemoclaw") {
    return "NemoClaw + OpenClaw";
  }

  switch (resolveAgentExecutionTarget(agent)) {
    case "k8s":
      return "OpenClaw + Kubernetes";
    case "proxmox":
      return "OpenClaw + Proxmox";
    default:
      return "OpenClaw + Docker";
  }
}

export function isNemoClawSandbox(agent = {}) {
  return resolveAgentSandboxProfile(agent) === "nemoclaw";
}

export function isHermesRuntime(agent = {}) {
  return resolveAgentRuntimeFamily(agent) === "hermes";
}

export function runtimeSupportsGateway(agentOrRuntimeFamily = {}) {
  const runtimeFamily =
    typeof agentOrRuntimeFamily === "string"
      ? normalizeRuntimeFamily(agentOrRuntimeFamily)
      : resolveAgentRuntimeFamily(agentOrRuntimeFamily);
  return runtimeFamily !== "hermes";
}

export function runtimeSupportsMarketplacePublishing(agentOrRuntimeFamily = {}) {
  const runtimeFamily =
    typeof agentOrRuntimeFamily === "string"
      ? normalizeRuntimeFamily(agentOrRuntimeFamily)
      : resolveAgentRuntimeFamily(agentOrRuntimeFamily);
  return runtimeFamily !== "hermes";
}
