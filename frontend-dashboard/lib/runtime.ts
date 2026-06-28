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
  execution_target_id?: string;
  sandbox_profile?: string;
  sandbox_type?: string;
};

export function normalizeRuntimeFamily(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["openclaw", "hermes"].includes(normalized)) return normalized;
  return null;
}

export function normalizeDeployTarget(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("k8s:") || normalized.startsWith("kubernetes:")) return "k8s";
  if (normalized === "kubernetes" || normalized === "k3s") return "k8s";
  if (normalized.startsWith("remote:")) return "remote-docker";
  if (["docker", "k8s", "remote-docker", "proxmox", "external"].includes(normalized)) {
    return normalized;
  }
  return null;
}

export function normalizeExecutionTargetId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "kubernetes" || normalized === "k3s") return "k8s";
  if (normalized.startsWith("kubernetes:")) {
    return `k8s:${normalized.slice("kubernetes:".length)}`;
  }
  if (normalized.startsWith("k8s:")) {
    const clusterId = normalized
      .slice(4)
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return clusterId ? `k8s:${clusterId}` : "k8s";
  }
  if (normalized.startsWith("remote:")) {
    const hostId = normalized
      .slice("remote:".length)
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return hostId ? `remote:${hostId}` : "remote-docker";
  }
  return normalizeDeployTarget(normalized);
}

export function normalizeSandboxProfile(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "nemoclaw") return "nemoclaw";
  if (normalized === "standard") return "standard";
  return null;
}

export function runtimeFamilyFromConfig(backendConfig: BackendConfig = {}, runtimeFamily = "") {
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
    (runtimeFamily) => runtimeFamily.enabled !== false,
  );
}

export function visibleRuntimeFamiliesFromConfig(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
) {
  const isAdmin = viewerRole === "admin";
  const enabledRuntimeFamilies = enabledRuntimeFamiliesFromConfig(backendConfig);

  return isAdmin
    ? enabledRuntimeFamilies
    : enabledRuntimeFamilies.filter(
        (runtimeFamily) => runtimeFamily.availableForOnboarding !== false,
      );
}

export function pickRuntimeFamilySelection(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
  currentRuntimeFamily = "",
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

function executionTargetsForRuntimeFamily(backendConfig: BackendConfig = {}, runtimeFamily = "") {
  const activeRuntimeFamily = runtimeFamilyFromConfig(backendConfig, runtimeFamily);
  if (Array.isArray(activeRuntimeFamily?.executionTargets)) {
    return activeRuntimeFamily.executionTargets;
  }
  return backendConfig?.executionTargets || [];
}

export function enabledExecutionTargetsFromConfig(
  backendConfig: BackendConfig = {},
  runtimeFamily = "",
) {
  return executionTargetsForRuntimeFamily(backendConfig, runtimeFamily).filter(
    (target) => target.enabled,
  );
}

export function visibleExecutionTargetsFromConfig(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
  runtimeFamily = "",
) {
  const isAdmin = viewerRole === "admin";
  const executionTargets = executionTargetsForRuntimeFamily(backendConfig, runtimeFamily);
  const enabledExecutionTargets = executionTargets.filter((target) => target.enabled);

  return isAdmin ? executionTargets : enabledExecutionTargets;
}

export function activeExecutionTargetFromConfig(
  backendConfig: BackendConfig = {},
  runtimeFamilyOrExecutionTarget = "",
  maybeExecutionTarget?: string,
) {
  const runtimeFamily = maybeExecutionTarget === undefined ? "" : runtimeFamilyOrExecutionTarget;
  const executionTarget =
    maybeExecutionTarget === undefined ? runtimeFamilyOrExecutionTarget : maybeExecutionTarget;
  const normalizedExecutionTarget = normalizeExecutionTargetId(executionTarget);

  return (
    enabledExecutionTargetsFromConfig(backendConfig, runtimeFamily).find(
      (target) => target.id === normalizedExecutionTarget,
    ) || null
  );
}

function executionTargetMetadataFromConfig(
  backendConfig: BackendConfig = {},
  executionTarget = "",
  runtimeFamily = "",
) {
  const normalizedExecutionTarget = normalizeExecutionTargetId(executionTarget);
  if (!normalizedExecutionTarget) return null;

  const candidates = executionTargetsForRuntimeFamily(backendConfig, runtimeFamily);
  return candidates.find((target) => target.id === normalizedExecutionTarget) || null;
}

export function visibleSandboxOptionsFromTarget(
  executionTarget: RuntimeTarget | null = null,
  viewerRole = "user",
) {
  const isAdmin = viewerRole === "admin";
  const enabledSandboxProfiles = (executionTarget?.sandboxProfiles || []).filter(
    (profile) => profile.enabled,
  );

  return isAdmin
    ? enabledSandboxProfiles
    : enabledSandboxProfiles.filter((profile) => profile.availableForOnboarding);
}

export function activeSandboxOptionFromTarget(
  executionTarget: RuntimeTarget | null = null,
  sandboxProfile = "",
) {
  const normalizedSandboxProfile = normalizeSandboxProfile(sandboxProfile);
  return (
    (executionTarget?.sandboxProfiles || []).find(
      (profile) => profile.id === normalizedSandboxProfile,
    ) || null
  );
}

export function pickExecutionTargetSelection(
  backendConfig: BackendConfig = {},
  viewerRole = "user",
  currentExecutionTarget = "",
  runtimeFamily = "",
) {
  const candidates = visibleExecutionTargetsFromConfig(backendConfig, viewerRole, runtimeFamily);
  const normalizedExecutionTarget = normalizeExecutionTargetId(currentExecutionTarget);
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
  currentSandboxProfile = "",
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

function remoteHostTargetLabel(host: any = {}) {
  const user = host.sshUser ? `${host.sshUser}@` : "";
  const port = host.sshPort && host.sshPort !== 22 ? `:${host.sshPort}` : "";
  return `${user}${host.sshHost || host.gatewayHost || "remote"}${port}`;
}

// Clone a generic execution-target template into a concrete per-host entry that
// the deploy picker can render and select. Remote Docker now supports both the
// standard OpenClaw path and NemoClaw through a dedicated remote sandbox backend.
function buildRemoteHostTarget(template: any = {}, host: any = {}) {
  const sandboxProfiles = (template.sandboxProfiles || []).map((profile: any) => {
    const enabled = profile.enabled !== false;
    return {
      ...profile,
      executionTargetId: host.executionTargetId,
      deployTargetLabel: host.label,
      enabled,
      configured: enabled,
      available: enabled,
      availableForOnboarding: enabled && profile.onboardingVisible !== false,
      isDefault: profile.id === "standard",
      issue: enabled ? null : profile.issue || null,
      // remote-docker is experimental in this phase regardless of which template
      // was cloned (don't inherit a fallback docker template's "ga").
      maturityTier: "experimental",
      maturityLabel: "Experimental",
    };
  });
  return {
    ...template,
    id: host.executionTargetId,
    executionTargetId: host.executionTargetId,
    deployTarget: "remote-docker",
    label: host.label || host.executionTargetId,
    shortLabel: host.label || host.executionTargetId,
    summary: `Your remote Docker host · ${remoteHostTargetLabel(host)}`,
    enabled: true,
    configured: true,
    available: true,
    availableForOnboarding: true,
    isDefault: false,
    issue: null,
    defaultSandboxProfile: "standard",
    sandboxProfiles,
    // remote-docker is experimental in this phase — set explicitly so a docker
    // fallback template can't make a remote host report "ga".
    maturityTier: "experimental",
    maturityLabel: "Experimental",
    // k8s-only display fields must not leak onto a remote host card
    clusterName: undefined,
    namespace: undefined,
    exposureMode: undefined,
  };
}

// Merge the operator's own connected remote hosts into the (public, global)
// backend catalog so they appear as selectable deploy targets — the per-user
// equivalent of how registered Kubernetes clusters surface. Only connected
// (available) hosts are injected, replacing the generic experimental
// "remote-docker" placeholder. Pure + immutable; returns the original config
// untouched when there are no usable hosts.
export function mergeRemoteHostsIntoConfig(
  backendConfig: BackendConfig = {},
  remoteHosts: any[] = [],
) {
  // Only connected hosts the caller may actually deploy to. Owned hosts always
  // carry canDeploy=true; hosts shared into a workspace are deployable for
  // editor+ members and read-only (canDeploy=false) for viewers — those must
  // not appear as selectable targets even though the operator can see them.
  const hosts = Array.isArray(remoteHosts)
    ? remoteHosts.filter((host) => host && host.available && host.canDeploy !== false)
    : [];
  if (!hosts.length) return backendConfig;
  const runtimeFamilies = Array.isArray(backendConfig?.runtimeFamilies)
    ? backendConfig.runtimeFamilies
    : [];
  if (!runtimeFamilies.length) return backendConfig;

  const nextRuntimeFamilies = runtimeFamilies.map((family: any) => {
    if (family.id !== "openclaw") return family;
    const targets = Array.isArray(family.executionTargets) ? family.executionTargets : [];
    const template =
      targets.find((target: any) => target.id === "remote-docker") ||
      targets.find((target: any) => target.deployTarget === "remote-docker") ||
      targets.find((target: any) => target.id === "docker");
    if (!template) return family;
    const hostTargets = hosts.map((host) => buildRemoteHostTarget(template, host));
    const withoutPlaceholder = targets.filter(
      (target: any) => target.deployTarget !== "remote-docker",
    );
    return { ...family, executionTargets: [...withoutPlaceholder, ...hostTargets] };
  });

  return { ...backendConfig, runtimeFamilies: nextRuntimeFamilies };
}

export function resolveAgentRuntimeFamily(agent: AgentRuntimeMeta = {}) {
  const explicitRuntimeFamily = normalizeRuntimeFamily(agent.runtime_family);
  if (explicitRuntimeFamily) return explicitRuntimeFamily;

  return "openclaw";
}

export function resolveAgentExecutionTarget(agent: AgentRuntimeMeta = {}) {
  const explicitExecutionTarget = normalizeExecutionTargetId(agent.execution_target_id);
  if (explicitExecutionTarget) return explicitExecutionTarget;

  const explicitDeployTarget = normalizeDeployTarget(agent.deploy_target);
  if (explicitDeployTarget) return explicitDeployTarget;

  return normalizeDeployTarget(agent.backend_type) || "docker";
}

export function resolveAgentSandboxProfile(agent: AgentRuntimeMeta = {}) {
  const explicitSandboxProfile =
    normalizeSandboxProfile(agent.sandbox_profile) || normalizeSandboxProfile(agent.sandbox_type);
  if (explicitSandboxProfile) return explicitSandboxProfile;

  return "standard";
}

export function resolveBackendTypeForSelection({
  runtimeFamily = "openclaw",
  deployTarget = "docker",
  sandboxProfile = "standard",
} = {}) {
  return normalizeDeployTarget(deployTarget) || "docker";
}

export function containerNamePrefixForSelection({
  runtimeFamily = "openclaw",
  sandboxProfile = "standard",
} = {}) {
  void sandboxProfile;

  if (normalizeRuntimeFamily(runtimeFamily) === "hermes") {
    return "nora-hermes";
  }

  return "nora-oclaw";
}

export function formatRuntimeFamilyLabel(value) {
  return RUNTIME_FAMILY_LABELS[normalizeRuntimeFamily(value)] || "OpenClaw";
}

export function formatExecutionTargetLabel(
  value,
  backendConfig: BackendConfig = {},
  runtimeFamily = "",
) {
  const configuredTarget = executionTargetMetadataFromConfig(backendConfig, value, runtimeFamily);
  if (configuredTarget?.label) return configuredTarget.label;

  switch (normalizeDeployTarget(value)) {
    case "k8s":
      return "Kubernetes";
    case "remote-docker":
      return "Remote Docker host";
    case "proxmox":
      return "Proxmox";
    case "external":
      return "External runtime";
    default:
      return "Docker";
  }
}

export function formatSandboxProfileLabel(value) {
  return normalizeSandboxProfile(value) === "nemoclaw" ? "NemoClaw" : "Standard";
}

export function formatRuntimePathLabel(
  agent: AgentRuntimeMeta = {},
  backendConfig: BackendConfig = {},
) {
  const runtimeLabel = formatRuntimeFamilyLabel(resolveAgentRuntimeFamily(agent));
  const targetLabel = formatExecutionTargetLabel(
    resolveAgentExecutionTarget(agent),
    backendConfig,
    resolveAgentRuntimeFamily(agent),
  );
  const sandboxProfile = resolveAgentSandboxProfile(agent);

  return sandboxProfile === "nemoclaw"
    ? `${runtimeLabel} + ${targetLabel} + NemoClaw`
    : `${runtimeLabel} + ${targetLabel}`;
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

export function runtimeSupportsAgentHubSharing(agentOrRuntimeFamily = {}) {
  const runtimeFamily =
    typeof agentOrRuntimeFamily === "string"
      ? normalizeRuntimeFamily(agentOrRuntimeFamily)
      : resolveAgentRuntimeFamily(agentOrRuntimeFamily);
  return runtimeFamily !== "hermes";
}
