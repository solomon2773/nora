// @ts-nocheck
const DEFAULT_RUNTIME_FAMILY = "openclaw";
const KNOWN_RUNTIME_FAMILIES = Object.freeze(["openclaw", "hermes"]);
const KNOWN_BACKENDS = Object.freeze([
  "docker",
  "k8s",
  "proxmox",
  "nemoclaw",
  "hermes",
]);
const KNOWN_DEPLOY_TARGETS = Object.freeze(["docker", "k8s", "proxmox"]);
const KNOWN_SANDBOX_PROFILES = Object.freeze(["standard", "nemoclaw"]);
const PROXMOX_RELEASE_BLOCKER_ISSUE =
  "Proxmox execution target is not release-ready in this Nora build. New Proxmox deployments are disabled for the first release.";
const OPENCLAW_OPERATOR_CONTRACT = Object.freeze([
  "deploy/redeploy",
  "readiness",
  "gateway/chat",
  "logs",
  "exec",
  "bootstrap/template files",
  "auth/integration sync",
]);
const HERMES_OPERATOR_CONTRACT = Object.freeze([
  "deploy/redeploy",
  "readiness",
  "logs",
  "exec",
  "provider/integration env sync",
]);
const MATURITY_METADATA = Object.freeze({
  ga: Object.freeze({
    id: "ga",
    label: "GA",
    summary: "Release-ready default path for normal onboarding.",
    onboardingVisible: true,
  }),
  beta: Object.freeze({
    id: "beta",
    label: "Beta",
    summary: "Usable with existing smoke coverage, but still maturing operationally.",
    onboardingVisible: true,
  }),
  experimental: Object.freeze({
    id: "experimental",
    label: "Experimental",
    summary: "Promising, but still under active contract validation and operator testing.",
    onboardingVisible: true,
  }),
  blocked: Object.freeze({
    id: "blocked",
    label: "Blocked",
    summary: "Visible for operator awareness, but intentionally excluded from normal onboarding.",
    onboardingVisible: false,
  }),
});
const RUNTIME_FAMILY_METADATA = Object.freeze({
  openclaw: Object.freeze({
    id: "openclaw",
    label: "OpenClaw",
    summary:
      "Default runtime family for Nora. Use deploy targets and sandbox profiles to change placement or isolation without changing the operator workflow.",
    contractStatus: "stable",
    contractStatusLabel: "Stable contract",
    operatorContract: [...OPENCLAW_OPERATOR_CONTRACT],
    operatorContractSummary:
      "Deploy/redeploy, readiness, gateway/chat, logs, exec, bootstrap/template files, and auth/integration sync all stay inside the OpenClaw contract.",
    expansionPolicy:
      "Add another runtime family only when it can satisfy Nora's full operator contract end-to-end.",
  }),
  hermes: Object.freeze({
    id: "hermes",
    label: "Hermes",
    summary:
      "Deploy Nous Hermes Agent as a Docker-managed runtime when you want Nora lifecycle control without the OpenClaw gateway surface.",
    contractStatus: "deployment-first",
    contractStatusLabel: "Deployment-first contract",
    operatorContract: [...HERMES_OPERATOR_CONTRACT],
    operatorContractSummary:
      "Deploy/redeploy, readiness, logs, exec, and provider or integration env sync stay inside the Hermes contract. OpenClaw gateway and chat surfaces are not part of this runtime family.",
    expansionPolicy:
      "Hermes currently ships as a Docker-only runtime path backed by its own API server and filesystem layout.",
  }),
});
const EXECUTION_TARGET_METADATA = Object.freeze({
  docker: Object.freeze({
    id: "docker",
    label: "Docker",
    shortLabel: "Docker",
    summary:
      "Containerized runtime on the local Docker host. This is the recommended default for most self-hosted deployments.",
    detail:
      "Run the selected runtime family as an isolated container on the local Docker host. This is the fastest and clearest path from install to live operations.",
    badges: ["Fast path", "Local socket", "General purpose"],
  }),
  k8s: Object.freeze({
    id: "k8s",
    label: "Kubernetes",
    shortLabel: "Kubernetes",
    summary:
      "Run agents as Kubernetes workloads when Nora should provision into a shared cluster instead of the local Docker host.",
    detail:
      "Use a shared cluster when your control plane is wired to Kubernetes and you want Nora to place runtimes as Deployments and Services.",
    badges: ["Cluster workload", "Service-backed", "Kube API"],
  }),
  proxmox: Object.freeze({
    id: "proxmox",
    label: "Proxmox",
    shortLabel: "Proxmox",
    summary:
      "Provision agents as Proxmox LXCs when your infrastructure standard is VM and LXC orchestration through the Proxmox API.",
    detail:
      "Use Proxmox when Nora should create LXCs through the Proxmox API instead of scheduling onto Docker or Kubernetes.",
    badges: ["LXC", "Proxmox API", "Infrastructure-specific"],
  }),
});
const SANDBOX_PROFILE_METADATA = Object.freeze({
  standard: Object.freeze({
    id: "standard",
    label: "Standard",
    summary:
      "Default runtime environment for the selected Nora runtime family and execution target.",
    detail:
      "Standard keeps the usual runtime workflow while the runtime family decides the operator contract and the execution target decides where the runtime is provisioned.",
    badges: ["Default"],
  }),
  nemoclaw: Object.freeze({
    id: "nemoclaw",
    label: "NemoClaw",
    summary:
      "NVIDIA secure sandbox path for teams that need stronger runtime restrictions and compatible model routing.",
    detail:
      "NemoClaw + OpenClaw agents run in NVIDIA secure sandboxes with deny-by-default networking and capability-restricted containers.",
    badges: ["Secure sandbox", "Deny-by-default network", "Capability-restricted"],
  }),
});
const BACKEND_METADATA = Object.freeze({
  docker: Object.freeze({
    id: "docker",
    runtimeFamily: "openclaw",
    label: "OpenClaw + Docker",
    shortLabel: "Docker",
    deployTarget: "docker",
    sandboxProfile: "standard",
    maturityTier: "ga",
    summary:
      "Recommended default for self-hosted deployments. Containerized runtime with the shortest path from install to live operations.",
    detail:
      "OpenClaw + Docker agents are deployed as isolated containers. This is the fastest and clearest path for a self-hosted deployment.",
    badges: ["Fast path", "Local socket", "General purpose"],
  }),
  k8s: Object.freeze({
    id: "k8s",
    runtimeFamily: "openclaw",
    label: "OpenClaw + Kubernetes",
    shortLabel: "Kubernetes",
    deployTarget: "k8s",
    sandboxProfile: "standard",
    maturityTier: "beta",
    summary:
      "Run agents as Kubernetes workloads when Nora should provision into a shared cluster instead of the local Docker host.",
    detail:
      "OpenClaw + Kubernetes agents run as Deployments and Services. Use this when your control plane is wired to a Kubernetes cluster.",
    badges: ["Cluster workload", "Service-backed", "Kube API"],
  }),
  proxmox: Object.freeze({
    id: "proxmox",
    runtimeFamily: "openclaw",
    label: "OpenClaw + Proxmox",
    shortLabel: "Proxmox",
    deployTarget: "proxmox",
    sandboxProfile: "standard",
    maturityTier: "blocked",
    summary:
      "Provision agents as Proxmox LXCs when your infrastructure standard is VM and LXC orchestration through the Proxmox API.",
    detail:
      "OpenClaw + Proxmox agents are provisioned as LXCs through the Proxmox API. This path depends on external Proxmox configuration.",
    badges: ["LXC", "Proxmox API", "Infrastructure-specific"],
  }),
  nemoclaw: Object.freeze({
    id: "nemoclaw",
    runtimeFamily: "openclaw",
    label: "NemoClaw + OpenClaw",
    shortLabel: "NemoClaw",
    deployTarget: "docker",
    sandboxProfile: "nemoclaw",
    maturityTier: "experimental",
    summary:
      "NVIDIA secure sandbox path for teams that need stronger runtime restrictions and compatible model routing.",
    detail:
      "NemoClaw + OpenClaw agents run in NVIDIA secure sandboxes with deny-by-default networking and capability-restricted containers.",
    badges: ["Secure sandbox", "Deny-by-default network", "Capability-restricted"],
  }),
  hermes: Object.freeze({
    id: "hermes",
    runtimeFamily: "hermes",
    label: "Hermes + Docker",
    shortLabel: "Hermes",
    deployTarget: "docker",
    sandboxProfile: "standard",
    maturityTier: "experimental",
    summary:
      "Deploy Nous Hermes Agent as a Docker container managed by Nora.",
    detail:
      "Hermes agents run as Docker containers using Hermes's built-in API server for readiness, logs, exec, and provider or integration env sync without the OpenClaw gateway surface.",
    badges: ["Docker-only", "API server", "Experimental"],
  }),
});
const NEMOCLAW_MODELS = Object.freeze([
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-3-nano-30b-a3b",
]);

function normalizeRuntimeFamilyName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return KNOWN_RUNTIME_FAMILIES.includes(normalized)
    ? normalized
    : DEFAULT_RUNTIME_FAMILY;
}

function defaultBackendForRuntimeFamily(runtimeFamily) {
  return normalizeRuntimeFamilyName(runtimeFamily) === "hermes"
    ? "hermes"
    : "docker";
}

function normalizeBackendName(value) {
  const normalized = String(value || "docker").trim().toLowerCase();
  if (normalized === "kubernetes") return "k8s";
  return KNOWN_BACKENDS.includes(normalized) ? normalized : "docker";
}

function normalizeDeployTargetName(value) {
  const normalized = String(value || "docker").trim().toLowerCase();
  if (normalized === "kubernetes") return "k8s";
  return KNOWN_DEPLOY_TARGETS.includes(normalized) ? normalized : "docker";
}

function isKnownRuntimeFamily(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return KNOWN_RUNTIME_FAMILIES.includes(normalized);
}

function isKnownBackend(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "kubernetes" || KNOWN_BACKENDS.includes(normalized);
}

function isKnownDeployTarget(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "kubernetes" || KNOWN_DEPLOY_TARGETS.includes(normalized);
}

function isKnownSandboxProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return KNOWN_SANDBOX_PROFILES.includes(normalized);
}

function getBackendMetadata(backend) {
  return BACKEND_METADATA[normalizeBackendName(backend)];
}

function getRuntimeFamilyMetadata(runtimeFamily) {
  return RUNTIME_FAMILY_METADATA[normalizeRuntimeFamilyName(runtimeFamily)];
}

function getExecutionTargetMetadata(deployTarget) {
  return EXECUTION_TARGET_METADATA[normalizeDeployTargetName(deployTarget)];
}

function getSandboxProfileMetadata(sandboxProfile) {
  return SANDBOX_PROFILE_METADATA[
    isKnownSandboxProfile(sandboxProfile) ? sandboxProfile : "standard"
  ];
}

function runtimeFamilyForBackend(backend) {
  return getBackendMetadata(backend)?.runtimeFamily || DEFAULT_RUNTIME_FAMILY;
}

function backendForRuntimeSelection({
  runtimeFamily = DEFAULT_RUNTIME_FAMILY,
  deployTarget = "docker",
  sandboxProfile = "standard",
} = {}) {
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  if (normalizedRuntimeFamily === "hermes") {
    return "hermes";
  }

  return sandboxProfile === "nemoclaw"
    ? "nemoclaw"
    : normalizeDeployTargetName(deployTarget);
}

function sandboxForBackend(backend) {
  return getBackendMetadata(backend)?.sandboxProfile || "standard";
}

function selectionTypeForBackend(backend) {
  const normalizedBackend = normalizeBackendName(backend);
  const runtimeFamily = runtimeFamilyForBackend(normalizedBackend);

  if (runtimeFamily !== DEFAULT_RUNTIME_FAMILY) {
    return "runtime_family";
  }

  return normalizedBackend === "nemoclaw"
    ? "sandbox_profile"
    : "deploy_target";
}

function deployTargetForBackend(backend) {
  return getBackendMetadata(backend)?.deployTarget || normalizeDeployTargetName(backend);
}

function sandboxProfileLabel(sandboxProfile) {
  return SANDBOX_PROFILE_METADATA[sandboxProfile]?.label || "Standard";
}

function getMaturityMetadata(maturityTier) {
  return MATURITY_METADATA[maturityTier] || MATURITY_METADATA.ga;
}

function buildMaturityFields(maturityTier) {
  const maturity = getMaturityMetadata(maturityTier);
  return {
    maturity,
    maturityTier: maturity.id,
    maturityLabel: maturity.label,
    maturitySummary: maturity.summary,
    onboardingVisible: maturity.onboardingVisible,
  };
}

function resolveMaturityTier({ runtimeFamily, deployTarget, sandboxProfile }) {
  if (normalizeRuntimeFamilyName(runtimeFamily) === "hermes") {
    return "experimental";
  }
  if (sandboxProfile === "nemoclaw") return "experimental";

  switch (normalizeDeployTargetName(deployTarget)) {
    case "k8s":
      return "beta";
    case "proxmox":
      return "blocked";
    default:
      return "ga";
  }
}

function parseEnabledBackendList(rawValue) {
  const seen = new Set();
  const parsed = [];

  for (const entry of String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!isKnownBackend(entry)) continue;
    const normalized = normalizeBackendName(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    parsed.push(normalized);
  }

  return parsed;
}

function parseEnabledRuntimeFamilyList(rawValue) {
  const seen = new Set();
  const parsed = [];

  for (const entry of String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!isKnownRuntimeFamily(entry)) continue;
    const normalized = String(entry).trim().toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    parsed.push(normalized);
  }

  return parsed;
}

function getEnabledBackends(env = process.env) {
  const explicitBackends = parseEnabledBackendList(env.ENABLED_BACKENDS);
  const enabledRuntimeFamilies = parseEnabledRuntimeFamilyList(
    env.ENABLED_RUNTIME_FAMILIES
  );

  if (enabledRuntimeFamilies.length > 0) {
    const seen = new Set();
    const effectiveBackends = [];
    const runtimeFamilySet = new Set(enabledRuntimeFamilies);

    const pushBackend = (backend) => {
      const normalized = normalizeBackendName(backend);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      effectiveBackends.push(normalized);
    };

    for (const backend of explicitBackends) {
      if (!runtimeFamilySet.has(runtimeFamilyForBackend(backend))) continue;
      pushBackend(backend);
    }

    for (const runtimeFamily of enabledRuntimeFamilies) {
      const familyAlreadyCovered = effectiveBackends.some(
        (backend) => runtimeFamilyForBackend(backend) === runtimeFamily
      );
      if (familyAlreadyCovered) continue;
      pushBackend(defaultBackendForRuntimeFamily(runtimeFamily));
    }

    if (effectiveBackends.length > 0) {
      return effectiveBackends;
    }
  }

  if (explicitBackends.length > 0) {
    return explicitBackends;
  }

  return ["docker"];
}

function getEnabledRuntimeFamilies(env = process.env) {
  const seen = new Set();
  const runtimeFamilies = [];

  for (const backend of getEnabledBackends(env)) {
    const runtimeFamily = runtimeFamilyForBackend(backend);
    if (seen.has(runtimeFamily)) continue;
    seen.add(runtimeFamily);
    runtimeFamilies.push(runtimeFamily);
  }

  return runtimeFamilies.length > 0
    ? runtimeFamilies
    : [DEFAULT_RUNTIME_FAMILY];
}

function getEnabledDeployTargets(env = process.env, options = {}) {
  const runtimeFamily = isKnownRuntimeFamily(options.runtimeFamily)
    ? normalizeRuntimeFamilyName(options.runtimeFamily)
    : null;
  const seen = new Set();
  const enabledDeployTargets = [];

  for (const backend of getEnabledBackends(env)) {
    if (runtimeFamily && runtimeFamilyForBackend(backend) !== runtimeFamily) {
      continue;
    }

    const deployTarget = deployTargetForBackend(backend);
    if (seen.has(deployTarget)) continue;
    seen.add(deployTarget);
    enabledDeployTargets.push(deployTarget);
  }

  return enabledDeployTargets;
}

function getEnabledSandboxProfiles(env = process.env, options = {}) {
  const runtimeFamily = isKnownRuntimeFamily(options.runtimeFamily)
    ? normalizeRuntimeFamilyName(options.runtimeFamily)
    : null;
  const seen = new Set();
  const enabledSandboxProfiles = [];

  for (const backend of getEnabledBackends(env)) {
    if (runtimeFamily && runtimeFamilyForBackend(backend) !== runtimeFamily) {
      continue;
    }

    const sandboxProfile = sandboxForBackend(backend);
    if (seen.has(sandboxProfile)) continue;
    seen.add(sandboxProfile);
    enabledSandboxProfiles.push(sandboxProfile);
  }

  return enabledSandboxProfiles;
}

function getDefaultBackend(env = process.env, options = {}) {
  const requestedRuntimeFamily = isKnownRuntimeFamily(options.runtimeFamily)
    ? normalizeRuntimeFamilyName(options.runtimeFamily)
    : null;
  const enabledBackends = getEnabledBackends(env).filter((backend) =>
    requestedRuntimeFamily
      ? runtimeFamilyForBackend(backend) === requestedRuntimeFamily
      : true
  );
  const availableEnabledBackends = enabledBackends.filter(
    (backend) => backendConfigIssue(backend, env) == null
  );
  const candidateBackends =
    availableEnabledBackends.length > 0
      ? availableEnabledBackends
      : enabledBackends;
  const requested = options.backend ? normalizeBackendName(options.backend) : null;
  const requestedSandbox =
    options.sandbox === "nemoclaw" || options.sandbox === "standard"
      ? options.sandbox
      : null;

  if (requested && candidateBackends.includes(requested)) {
    return requested;
  }

  if (requestedSandbox) {
    const matching = candidateBackends.find(
      (backend) => sandboxForBackend(backend) === requestedSandbox
    );
    if (matching) return matching;
  }

  if (candidateBackends.length > 0) {
    return candidateBackends[0];
  }

  return requestedRuntimeFamily === "hermes" ? "hermes" : "docker";
}

function getDefaultRuntimeFamily(env = process.env) {
  return runtimeFamilyForBackend(getDefaultBackend(env));
}

function getDefaultDeployTarget(env = process.env, options = {}) {
  return deployTargetForBackend(getDefaultBackend(env, options));
}

function getDefaultSandboxProfile(env = process.env, options = {}) {
  return sandboxForBackend(getDefaultBackend(env, options));
}

function backendConfigIssue(backend, env = process.env) {
  switch (normalizeBackendName(backend)) {
    case "k8s":
      if (env.KUBECONFIG || env.KUBERNETES_SERVICE_HOST) return null;
      return "Kubernetes execution target requires KUBECONFIG or in-cluster Kubernetes environment variables.";
    case "proxmox":
      return PROXMOX_RELEASE_BLOCKER_ISSUE;
    default:
      return null;
  }
}

function buildCatalogEntry(backendId, env = process.env, options = {}) {
  const normalized = normalizeBackendName(backendId);
  const metadata = getBackendMetadata(normalized);
  const runtimeFamily = runtimeFamilyForBackend(normalized);
  const runtimeFamilyMetadata = getRuntimeFamilyMetadata(runtimeFamily);
  const issue = backendConfigIssue(normalized, env);
  const enabledSet = options.enabledSet || new Set(getEnabledBackends(env));
  const enabled = enabledSet.has(normalized);
  const defaultBackend =
    options.defaultBackend || getDefaultBackend(env, { runtimeFamily });
  const sandboxProfile = metadata?.sandboxProfile || sandboxForBackend(normalized);
  const deployTarget = metadata?.deployTarget || deployTargetForBackend(normalized);
  const deployTargetMetadata = getExecutionTargetMetadata(deployTarget);
  const maturityTier =
    metadata?.maturityTier ||
    resolveMaturityTier({ runtimeFamily, deployTarget, sandboxProfile });
  const maturityFields = buildMaturityFields(maturityTier);

  return {
    ...metadata,
    enabled,
    configured: issue == null,
    available: enabled && issue == null,
    issue,
    isDefault: normalized === defaultBackend,
    models: normalized === "nemoclaw" ? [...NEMOCLAW_MODELS] : [],
    defaultModel:
      normalized === "nemoclaw"
        ? env.NEMOCLAW_DEFAULT_MODEL || NEMOCLAW_MODELS[0]
        : null,
    sandboxImage:
      normalized === "nemoclaw"
        ? env.NEMOCLAW_SANDBOX_IMAGE ||
          "ghcr.io/nvidia/openshell-community/sandboxes/openclaw"
        : null,
    runtimeFamily: runtimeFamilyMetadata.id,
    runtimeFamilyLabel: runtimeFamilyMetadata.label,
    selectionId: normalized,
    selectionLabel: metadata.label,
    selectionType: selectionTypeForBackend(normalized),
    deployTarget,
    deployTargetLabel: deployTargetMetadata?.label || "Docker",
    sandboxProfile,
    sandboxProfileLabel: sandboxProfileLabel(sandboxProfile),
    legacyBackendId: normalized,
    availableForOnboarding: maturityFields.onboardingVisible && enabled && issue == null,
    ...maturityFields,
  };
}

function supportedSandboxProfilesForDeployTarget(
  runtimeFamily,
  deployTarget
) {
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);

  if (normalizedRuntimeFamily === "hermes") {
    return normalizedDeployTarget === "docker" ? ["standard"] : [];
  }

  return normalizedDeployTarget === "docker"
    ? ["standard", "nemoclaw"]
    : ["standard"];
}

function executionTargetsForRuntimeFamily(runtimeFamily) {
  return normalizeRuntimeFamilyName(runtimeFamily) === "hermes"
    ? ["docker"]
    : [...KNOWN_DEPLOY_TARGETS];
}

function buildSandboxProfileOption(
  runtimeFamily,
  deployTarget,
  sandboxProfile,
  env = process.env,
  options = {}
) {
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);
  const normalizedSandboxProfile = isKnownSandboxProfile(sandboxProfile)
    ? sandboxProfile
    : "standard";
  const legacyBackendId = backendForRuntimeSelection({
    runtimeFamily: normalizedRuntimeFamily,
    deployTarget: normalizedDeployTarget,
    sandboxProfile: normalizedSandboxProfile,
  });
  const backendEntry = buildCatalogEntry(legacyBackendId, env, options);
  const sandboxMetadata = getSandboxProfileMetadata(normalizedSandboxProfile);
  const deployTargetMetadata = getExecutionTargetMetadata(normalizedDeployTarget);

  return {
    id: normalizedSandboxProfile,
    label: sandboxMetadata.label,
    summary: sandboxMetadata.summary,
    detail: backendEntry.detail,
    badges: backendEntry.badges,
    enabled: backendEntry.enabled,
    configured: backendEntry.configured,
    available: backendEntry.available,
    issue: backendEntry.issue,
    isDefault: backendEntry.isDefault,
    runtimeFamily: backendEntry.runtimeFamily,
    runtimeFamilyLabel: backendEntry.runtimeFamilyLabel,
    deployTarget: normalizedDeployTarget,
    deployTargetLabel: deployTargetMetadata?.label || "Docker",
    sandboxProfile: normalizedSandboxProfile,
    sandboxProfileLabel: sandboxMetadata.label,
    fullLabel: backendEntry.label,
    legacyBackendId,
    models: backendEntry.models,
    defaultModel: backendEntry.defaultModel,
    sandboxImage: backendEntry.sandboxImage,
    availableForOnboarding: backendEntry.availableForOnboarding,
    ...buildMaturityFields(
      resolveMaturityTier({
        runtimeFamily: normalizedRuntimeFamily,
        deployTarget: normalizedDeployTarget,
        sandboxProfile: normalizedSandboxProfile,
      })
    ),
  };
}

function buildExecutionTargetEntry(
  runtimeFamily,
  deployTarget,
  env = process.env,
  options = {}
) {
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const normalized = normalizeDeployTargetName(deployTarget);
  const metadata = getExecutionTargetMetadata(normalized);
  const supportedSandboxProfiles = supportedSandboxProfilesForDeployTarget(
    normalizedRuntimeFamily,
    normalized
  );
  const sandboxProfiles = supportedSandboxProfiles.map((sandboxProfile) =>
    buildSandboxProfileOption(
      normalizedRuntimeFamily,
      normalized,
      sandboxProfile,
      env,
      options
    )
  );
  const enabledSandboxProfiles = sandboxProfiles
    .filter((option) => option.enabled)
    .map((option) => option.id);
  const availableSandboxProfiles = sandboxProfiles
    .filter((option) => option.available)
    .map((option) => option.id);
  const selectableSandboxProfiles = sandboxProfiles.filter(
    (option) => option.enabled && option.availableForOnboarding
  );
  const defaultBackend =
    options.defaultBackend || getDefaultBackend(env, { runtimeFamily: normalizedRuntimeFamily });
  const runtimeFamilyMetadata = getRuntimeFamilyMetadata(normalizedRuntimeFamily);
  const defaultSelection =
    sandboxProfiles.find((option) => option.legacyBackendId === defaultBackend) ||
    sandboxProfiles.find((option) => option.available) ||
    sandboxProfiles.find((option) => option.enabled) ||
    sandboxProfiles[0];
  const enabled = sandboxProfiles.some((option) => option.enabled);
  const configured = sandboxProfiles.some((option) => option.configured);
  const available = sandboxProfiles.some((option) => option.available);

  return {
    ...metadata,
    enabled,
    configured,
    available,
    issue:
      enabled && !available
        ? defaultSelection?.issue ||
          sandboxProfiles.find((option) => option.issue)?.issue ||
          null
        : null,
    isDefault:
      normalized === getDefaultDeployTarget(env, { runtimeFamily: normalizedRuntimeFamily }),
    runtimeFamily: runtimeFamilyMetadata.id,
    runtimeFamilyLabel: runtimeFamilyMetadata.label,
    defaultSandboxProfile: defaultSelection?.id || "standard",
    enabledSandboxProfiles,
    availableSandboxProfiles,
    supportedSandboxProfiles,
    supportsSandboxSelection: selectableSandboxProfiles.length > 1,
    sandboxProfiles,
    availableForOnboarding: selectableSandboxProfiles.length > 0,
    fullLabel:
      defaultSelection?.fullLabel ||
      `${runtimeFamilyMetadata.label} + ${metadata.label}`,
    ...buildMaturityFields(
      defaultSelection?.maturityTier ||
        resolveMaturityTier({
          runtimeFamily: normalizedRuntimeFamily,
          deployTarget: normalized,
          sandboxProfile: defaultSelection?.id || "standard",
        })
    ),
  };
}

function getBackendCatalog(env = process.env, options = {}) {
  const runtimeFamily = isKnownRuntimeFamily(options.runtimeFamily)
    ? normalizeRuntimeFamilyName(options.runtimeFamily)
    : null;
  const enabledSet = new Set(getEnabledBackends(env));
  const backends = runtimeFamily
    ? KNOWN_BACKENDS.filter((backendId) => runtimeFamilyForBackend(backendId) === runtimeFamily)
    : KNOWN_BACKENDS;

  return backends.map((backendId) =>
    buildCatalogEntry(backendId, env, {
      enabledSet,
      defaultBackend: getDefaultBackend(env, {
        runtimeFamily: runtimeFamilyForBackend(backendId),
      }),
    })
  );
}

function getExecutionTargetCatalog(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env)
  );
  const enabledSet = options.enabledSet || new Set(getEnabledBackends(env));
  const defaultBackend =
    options.defaultBackend || getDefaultBackend(env, { runtimeFamily });

  return executionTargetsForRuntimeFamily(runtimeFamily)
    .map((deployTarget) =>
      buildExecutionTargetEntry(runtimeFamily, deployTarget, env, {
        enabledSet,
        defaultBackend,
      })
    )
    .filter(Boolean);
}

function getSandboxProfileCatalog(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env)
  );
  const executionTargets = getExecutionTargetCatalog(env, {
    runtimeFamily,
  });
  const supportedSandboxProfiles =
    runtimeFamily === "hermes"
      ? ["standard"]
      : [...KNOWN_SANDBOX_PROFILES];

  return supportedSandboxProfiles.map((sandboxProfile) => {
    const relatedTargets = executionTargets.filter((target) =>
      target.enabled &&
      target.sandboxProfiles.some(
        (option) => option.id === sandboxProfile && option.enabled
      )
    );
    const relatedOptions = relatedTargets.flatMap((target) =>
      target.sandboxProfiles.filter((option) => option.id === sandboxProfile)
    );
    const metadata = getSandboxProfileMetadata(sandboxProfile);
    const defaultOption =
      relatedOptions.find((option) => option.isDefault) ||
      relatedOptions.find((option) => option.available) ||
      relatedOptions.find((option) => option.enabled) ||
      null;
    const fallbackMaturityTier =
      sandboxProfile === "nemoclaw" || runtimeFamily === "hermes"
        ? "experimental"
        : "ga";

    return {
      ...metadata,
      enabled: relatedOptions.some((option) => option.enabled),
      available: relatedOptions.some((option) => option.available),
      executionTargets: relatedTargets.map((target) => target.id),
      models: sandboxProfile === "nemoclaw" ? [...NEMOCLAW_MODELS] : [],
      defaultModel:
        sandboxProfile === "nemoclaw"
          ? env.NEMOCLAW_DEFAULT_MODEL || NEMOCLAW_MODELS[0]
          : null,
      sandboxImage:
        sandboxProfile === "nemoclaw"
          ? env.NEMOCLAW_SANDBOX_IMAGE ||
            "ghcr.io/nvidia/openshell-community/sandboxes/openclaw"
          : null,
      ...buildMaturityFields(defaultOption?.maturityTier || fallbackMaturityTier),
    };
  });
}

function isBackendEnabled(backend, env = process.env) {
  return getEnabledBackends(env).includes(normalizeBackendName(backend));
}

function getBackendStatus(backend, env = process.env) {
  return buildCatalogEntry(backend, env, {
    defaultBackend: getDefaultBackend(env, {
      runtimeFamily: runtimeFamilyForBackend(backend),
    }),
  });
}

function buildBackendEnablementMessage(backendOrStatus, env = process.env) {
  const status =
    backendOrStatus && typeof backendOrStatus === "object"
      ? backendOrStatus
      : getBackendStatus(backendOrStatus, env);
  const runtimeFamily =
    status?.runtimeFamily || runtimeFamilyForBackend(status?.id || "");
  const runtimeFamilyBackend = defaultBackendForRuntimeFamily(runtimeFamily);

  if (
    status?.selectionType === "runtime_family" ||
    status?.id === runtimeFamilyBackend
  ) {
    return (
      `${status.label} is not enabled. Enable it with ` +
      `ENABLED_RUNTIME_FAMILIES=${runtimeFamily} or ENABLED_BACKENDS=${status.id}.`
    );
  }

  return (
    `${status.label} is not enabled. Enable it with ` +
    `ENABLED_BACKENDS=${status.id}.`
  );
}

function getRuntimeCatalog(env = process.env) {
  const enabledSet = new Set(getEnabledBackends(env));
  const defaultRuntimeFamily = getDefaultRuntimeFamily(env);

  return getEnabledRuntimeFamilies(env).map((runtimeFamily) => {
    const metadata = getRuntimeFamilyMetadata(runtimeFamily);
    const defaultBackend = getDefaultBackend(env, { runtimeFamily });
    const executionTargets = getExecutionTargetCatalog(env, {
      runtimeFamily,
      enabledSet,
      defaultBackend,
    });
    const sandboxProfiles = getSandboxProfileCatalog(env, {
      runtimeFamily,
    });
    const enabled = executionTargets.some((target) => target.enabled);
    const configured = executionTargets.some((target) => target.configured);
    const available = executionTargets.some((target) => target.available);

    return {
      ...metadata,
      enabled,
      configured,
      available,
      isDefault: runtimeFamily === defaultRuntimeFamily,
      defaultDeployTarget: getDefaultDeployTarget(env, { runtimeFamily }),
      defaultSandboxProfile: getDefaultSandboxProfile(env, { runtimeFamily }),
      enabledDeployTargets: getEnabledDeployTargets(env, { runtimeFamily }),
      enabledSandboxProfiles: getEnabledSandboxProfiles(env, { runtimeFamily }),
      executionTargets,
      sandboxProfiles,
      availableForOnboarding: executionTargets.some(
        (target) => target.availableForOnboarding
      ),
      issue:
        enabled && !available
          ? executionTargets.find((target) => target.issue)?.issue || null
          : null,
    };
  });
}

module.exports = {
  DEFAULT_RUNTIME_FAMILY,
  KNOWN_RUNTIME_FAMILIES,
  KNOWN_BACKENDS,
  KNOWN_DEPLOY_TARGETS,
  KNOWN_SANDBOX_PROFILES,
  NEMOCLAW_MODELS,
  PROXMOX_RELEASE_BLOCKER_ISSUE,
  RUNTIME_FAMILY_METADATA,
  backendForRuntimeSelection,
  getBackendCatalog,
  buildBackendEnablementMessage,
  getBackendMetadata,
  getBackendStatus,
  getDefaultBackend,
  getDefaultDeployTarget,
  getDefaultRuntimeFamily,
  getDefaultSandboxProfile,
  getEnabledBackends,
  getEnabledDeployTargets,
  getEnabledRuntimeFamilies,
  getEnabledSandboxProfiles,
  getExecutionTargetCatalog,
  getExecutionTargetMetadata,
  getRuntimeCatalog,
  getRuntimeFamilyMetadata,
  getSandboxProfileCatalog,
  isBackendEnabled,
  isKnownBackend,
  isKnownDeployTarget,
  isKnownRuntimeFamily,
  isKnownSandboxProfile,
  normalizeBackendName,
  normalizeDeployTargetName,
  normalizeRuntimeFamilyName,
  runtimeFamilyForBackend,
  selectionTypeForBackend,
  sandboxForBackend,
  sandboxProfileLabel,
  deployTargetForBackend,
};
