// @ts-nocheck
const DEFAULT_RUNTIME_FAMILY = "openclaw";
const {
  NEMOCLAW_DEFAULT_MODEL,
  getNemoClawDefaultModel,
  getNemoClawSandboxImage,
} = require("./nemoclawDefaults");
const KNOWN_RUNTIME_FAMILIES = Object.freeze(["openclaw", "hermes"]);
const KNOWN_DEPLOY_TARGETS = Object.freeze(["docker", "k8s", "remote-docker", "proxmox"]);
const KNOWN_BACKENDS = KNOWN_DEPLOY_TARGETS;
// "external" is a recognized deploy_target VALUE for an adopted, already-running
// runtime (BYOC Phase C). It is deliberately NOT in KNOWN_DEPLOY_TARGETS: you do
// not "deploy to" external (no provisioner, no deploy-catalog card) — you adopt a
// runtime by URL + token. It only needs to normalize, carry metadata, and resolve
// a maturity tier for an existing agent row.
const EXTERNAL_DEPLOY_TARGET = "external";
const KNOWN_SANDBOX_PROFILES = Object.freeze(["standard", "nemoclaw"]);
const PROXMOX_NEMOCLAW_BLOCKER_ISSUE =
  "NemoClaw on Proxmox is not supported yet because the LXC adapter does not provide the enforced OpenShell sandbox contract.";
const DEFAULT_PROXMOX_TEMPLATE = "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst";
// Keep this in lockstep with workers/provisioner/backends/proxmox.ts. The
// catalog must reject malformed values before a deployment reaches create().
const PROXMOX_TEMPLATE_RE = /^[A-Za-z0-9_.-]+:vztmpl\/[A-Za-z0-9._+~-]+\.tar\.zst$/;
const PROXMOX_RESOURCE_ID_RE = /^[A-Za-z0-9_.-]+$/;
// Linux interface names, including Proxmox bridges, are limited to 15 bytes.
// Restricting the character set also prevents net0 option-delimiter injection.
const PROXMOX_BRIDGE_RE = /^[A-Za-z0-9_.-]{1,15}$/;
const PROXMOX_SAFE_HOST_EXECUTABLE_RE = /^(?:\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+)$/;
const PROXMOX_SAFE_HOST_HELPER_RE = /^\/[A-Za-z0-9_./-]+$/;

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
      "Deploy Nous Hermes Agent under Nora lifecycle control while keeping the OpenClaw gateway surface out of the runtime contract.",
    contractStatus: "deployment-first",
    contractStatusLabel: "Deployment-first contract",
    operatorContract: [...HERMES_OPERATOR_CONTRACT],
    operatorContractSummary:
      "Deploy/redeploy, readiness, logs, exec, and provider or integration env sync stay inside the Hermes contract. OpenClaw gateway and chat surfaces are not part of this runtime family.",
    expansionPolicy:
      "Hermes can run on execution targets that provide the Hermes API and filesystem layout expected by Nora.",
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
      "Use the Kubernetes adapter for K3s, AKS, GKE, EKS, or any conformant cluster reachable through the configured kubeconfig.",
    badges: ["Cluster workload", "Service-backed", "Kube API"],
  }),
  "remote-docker": Object.freeze({
    id: "remote-docker",
    label: "Remote Docker host",
    shortLabel: "Remote host",
    summary:
      "Run agents on an operator-owned Linux Docker server, VPS, or cloud VM reached over SSH instead of the local Docker host.",
    detail:
      "Nora connects to the remote machine's Docker daemon over SSH and runs the selected runtime there. Other Docker host types require operator validation because Nora does not publish a certified cross-OS host matrix.",
    badges: ["Bring your own compute", "SSH", "Remote daemon"],
  }),
  proxmox: Object.freeze({
    id: "proxmox",
    label: "Proxmox",
    shortLabel: "Proxmox",
    summary:
      "Run OpenClaw or a prepared Hermes image in an unprivileged Proxmox LXC managed through the Proxmox API and SSH.",
    detail:
      "Proxmox is an experimental, opt-in execution target. Nora creates an unprivileged LXC through the API, bootstraps it through pinned SSH host verification, and exposes the same lifecycle, logs, terminal, readiness, auth, and integration surfaces as other managed targets. Run the live Proxmox smoke before production use.",
    badges: ["Experimental", "Unprivileged LXC", "API + SSH"],
  }),
  external: Object.freeze({
    id: "external",
    label: "External runtime",
    shortLabel: "External",
    summary:
      "An already-running OpenClaw or Hermes runtime that Nora did not provision, adopted by its reachable URL and gateway token.",
    detail:
      "Nora monitors and proxies access to the external runtime but does not control its lifecycle. Register it from the operator console; deregistering only removes it from Nora.",
    badges: ["Bring your own compute", "Adopted", "Not provisioned"],
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
      "NVIDIA secure sandbox path for OpenClaw agents that need stronger runtime restrictions and compatible model routing.",
    detail:
      "NemoClaw + OpenClaw agents run with deny-by-default networking and capability-restricted sandbox controls on supported execution targets.",
    badges: ["Secure sandbox", "Deny-by-default network", "Capability-restricted"],
  }),
});

const NEMOCLAW_MODELS = Object.freeze([
  NEMOCLAW_DEFAULT_MODEL,
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-3-nano-30b-a3b",
]);

function normalizeRuntimeFamilyName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return KNOWN_RUNTIME_FAMILIES.includes(normalized) ? normalized : DEFAULT_RUNTIME_FAMILY;
}

function normalizeDeployTargetName(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return "docker";
  if (normalized.startsWith("k8s:")) return "k8s";
  if (normalized.startsWith("remote:")) return "remote-docker";
  if (normalized === EXTERNAL_DEPLOY_TARGET) return EXTERNAL_DEPLOY_TARGET;
  if (KNOWN_DEPLOY_TARGETS.includes(normalized)) return normalized;

  const error = new Error(`Unknown deploy target: ${normalized}`);
  error.code = "UNKNOWN_DEPLOY_TARGET";
  error.statusCode = 400;
  throw error;
}

function normalizeBackendName(value) {
  return normalizeDeployTargetName(value);
}

function normalizeExecutionTargetId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
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
      .slice(7)
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return hostId ? `remote:${hostId}` : "remote-docker";
  }
  if (normalized === EXTERNAL_DEPLOY_TARGET) return EXTERNAL_DEPLOY_TARGET;
  return KNOWN_DEPLOY_TARGETS.includes(normalized) ? normalized : null;
}

function deployTargetFromExecutionTargetId(value) {
  return normalizeDeployTargetName(normalizeExecutionTargetId(value) || value);
}

function normalizeSandboxProfileName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return KNOWN_SANDBOX_PROFILES.includes(normalized) ? normalized : "standard";
}

function isKnownRuntimeFamily(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return KNOWN_RUNTIME_FAMILIES.includes(normalized);
}

function isKnownDeployTarget(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    normalized.startsWith("k8s:") ||
    normalized.startsWith("remote:") ||
    normalized === EXTERNAL_DEPLOY_TARGET ||
    KNOWN_DEPLOY_TARGETS.includes(normalized)
  );
}

function isKnownBackend(value) {
  return isKnownDeployTarget(value);
}

function isKnownSandboxProfile(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return KNOWN_SANDBOX_PROFILES.includes(normalized);
}

function hasRuntimeSelectionValue(value) {
  return value != null && String(value).trim() !== "";
}

function firstRuntimeSelectionValue(selection, keys) {
  for (const key of keys) {
    if (hasRuntimeSelectionValue(selection[key])) return selection[key];
  }
  return null;
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

function assertKnownRuntimeSelectionInputs(selection = {}) {
  const runtimeFamily = firstRuntimeSelectionValue(selection, ["runtimeFamily", "runtime_family"]);
  if (runtimeFamily != null && !isKnownRuntimeFamily(runtimeFamily)) {
    throw unknownRuntimeSelectionError("runtime family", "UNKNOWN_RUNTIME_FAMILY", runtimeFamily);
  }

  const deployTarget = firstRuntimeSelectionValue(selection, [
    "deployTarget",
    "deploy_target",
    "backend",
    "backend_type",
  ]);
  if (deployTarget != null && !isKnownDeployTarget(deployTarget)) {
    // Preserve the canonical deploy-target error contract.
    normalizeDeployTargetName(deployTarget);
  }

  const executionTargetId = firstRuntimeSelectionValue(selection, [
    "executionTargetId",
    "execution_target_id",
  ]);
  if (executionTargetId != null && normalizeExecutionTargetId(executionTargetId) == null) {
    throw unknownRuntimeSelectionError(
      "execution target",
      "UNKNOWN_EXECUTION_TARGET",
      executionTargetId,
    );
  }

  const sandboxProfile = firstRuntimeSelectionValue(selection, [
    "sandboxProfile",
    "sandbox_profile",
    "sandbox",
    "sandbox_type",
  ]);
  if (sandboxProfile != null && !isKnownSandboxProfile(sandboxProfile)) {
    throw unknownRuntimeSelectionError(
      "sandbox profile",
      "UNKNOWN_SANDBOX_PROFILE",
      sandboxProfile,
    );
  }
}

function getRuntimeFamilyMetadata(runtimeFamily) {
  return RUNTIME_FAMILY_METADATA[normalizeRuntimeFamilyName(runtimeFamily)];
}

const KUBERNETES_PROVIDER_METADATA = Object.freeze({
  aks: Object.freeze({
    id: "aks",
    label: "AKS",
    fullLabel: "Kubernetes on AKS",
    summary:
      "Run agents as workloads on Azure Kubernetes Service through Nora's Kubernetes adapter.",
    detail:
      "The Kubernetes adapter is connected to AKS through the mounted kubeconfig and exposes agents through AKS load balancer Services.",
    badges: ["AKS", "Cluster workload", "LoadBalancer", "Kube API"],
  }),
  gke: Object.freeze({
    id: "gke",
    label: "GKE",
    fullLabel: "Kubernetes on GKE",
    summary:
      "Run agents as workloads on Google Kubernetes Engine through Nora's Kubernetes adapter.",
    detail:
      "The Kubernetes adapter is connected to GKE through the mounted kubeconfig and exposes agents through GKE load balancer Services.",
    badges: ["GKE", "Cluster workload", "LoadBalancer", "Kube API"],
  }),
  eks: Object.freeze({
    id: "eks",
    label: "EKS",
    fullLabel: "Kubernetes on EKS",
    summary:
      "Run agents as workloads on Amazon Elastic Kubernetes Service through Nora's Kubernetes adapter.",
    detail:
      "The Kubernetes adapter is connected to EKS through the mounted kubeconfig and exposes agents through EKS load balancer Services.",
    badges: ["EKS", "Cluster workload", "LoadBalancer", "Kube API"],
  }),
  k3s: Object.freeze({
    id: "k3s",
    label: "K3s",
    fullLabel: "Kubernetes on K3s",
    summary:
      "Run agents as workloads on a lightweight self-hosted K3s cluster through Nora's Kubernetes adapter.",
    detail:
      "The Kubernetes adapter is connected to K3s through the mounted kubeconfig and usually exposes agents through NodePort Services.",
    badges: ["K3s", "Cluster workload", "NodePort", "Kube API"],
  }),
  kubernetes: Object.freeze({
    id: "kubernetes",
    label: "Kubernetes",
    fullLabel: "Kubernetes",
    summary:
      "Run agents as workloads on the Kubernetes cluster reachable through Nora's configured kubeconfig.",
    detail:
      "The Kubernetes adapter provisions Deployments and Services in the configured cluster namespace.",
    badges: ["Cluster workload", "Service-backed", "Kube API"],
  }),
});

function normalizeKubernetesProviderName(value) {
  const explicit = String(value || "")
    .trim()
    .toLowerCase();
  if (["aks", "azure", "azure-aks"].includes(explicit)) return "aks";
  if (["gke", "google", "google-gke"].includes(explicit)) return "gke";
  if (["eks", "aws", "aws-eks"].includes(explicit)) return "eks";
  if (["k3s", "rancher-k3s"].includes(explicit)) return "k3s";
  if (["k8s", "kubernetes", "generic"].includes(explicit)) return "kubernetes";

  return "kubernetes";
}

function getKubernetesProviderMetadata(options = {}) {
  const providerId = normalizeKubernetesProviderName(
    typeof options === "string" ? options : options.provider || options.providerId,
  );
  const metadata =
    KUBERNETES_PROVIDER_METADATA[providerId] || KUBERNETES_PROVIDER_METADATA.kubernetes;
  const customLabel = typeof options === "object" ? String(options.providerLabel || "").trim() : "";
  return customLabel
    ? {
        ...metadata,
        label: customLabel,
        fullLabel: `Kubernetes on ${customLabel}`,
      }
    : metadata;
}

function getExecutionTargetMetadata(deployTarget, env = process.env) {
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);
  const metadata = EXECUTION_TARGET_METADATA[normalizedDeployTarget];
  if (normalizedDeployTarget !== "k8s") return metadata;

  const provider = getKubernetesProviderMetadata(env);
  return {
    ...metadata,
    label: provider.fullLabel,
    shortLabel: provider.label,
    summary: provider.summary,
    detail: provider.detail,
    badges: provider.badges,
    providerId: provider.id,
    providerLabel: provider.label,
  };
}

function getSandboxProfileMetadata(sandboxProfile) {
  return SANDBOX_PROFILE_METADATA[normalizeSandboxProfileName(sandboxProfile)];
}

function runtimeFamilyForBackend() {
  return DEFAULT_RUNTIME_FAMILY;
}

function deployTargetForBackend(backend) {
  return normalizeDeployTargetName(backend);
}

function sandboxForBackend() {
  return "standard";
}

function backendForRuntimeSelection({ deployTarget = "docker" } = {}) {
  return normalizeDeployTargetName(deployTarget);
}

function selectionTypeForBackend() {
  return "deploy_target";
}

function getBackendMetadata(backend, env = process.env) {
  const deployTarget = normalizeDeployTargetName(backend);
  const metadata = getExecutionTargetMetadata(deployTarget, env);
  return {
    ...metadata,
    id: deployTarget,
    runtimeFamily: DEFAULT_RUNTIME_FAMILY,
    deployTarget,
    sandboxProfile: "standard",
    label: `${getRuntimeFamilyMetadata(DEFAULT_RUNTIME_FAMILY).label} + ${metadata.label}`,
    maturityTier: resolveMaturityTier({
      runtimeFamily: DEFAULT_RUNTIME_FAMILY,
      deployTarget,
      sandboxProfile: "standard",
    }),
  };
}

function sandboxProfileLabel(sandboxProfile) {
  return getSandboxProfileMetadata(sandboxProfile)?.label || "Standard";
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

function resolveMaturityTier({ deployTarget, sandboxProfile }) {
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);

  if (
    normalizedDeployTarget === "proxmox" &&
    normalizeSandboxProfileName(sandboxProfile) === "nemoclaw"
  ) {
    return "blocked";
  }
  if (normalizedDeployTarget === "proxmox") return "experimental";
  if (normalizedDeployTarget === "remote-docker") return "experimental";
  if (normalizedDeployTarget === EXTERNAL_DEPLOY_TARGET) return "experimental";
  if (normalizeSandboxProfileName(sandboxProfile) === "nemoclaw") return "experimental";
  return "ga";
}

function parseList(rawValue, isKnown, normalize) {
  const seen = new Set();
  const parsed = [];
  for (const entry of String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!isKnown(entry)) continue;
    const normalized = normalize(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    parsed.push(normalized);
  }
  return parsed;
}

function parseEnabledBackendList(rawValue) {
  return parseList(
    rawValue,
    (value) =>
      ["docker", "k8s", "proxmox"].includes(
        String(value || "")
          .trim()
          .toLowerCase(),
      ),
    normalizeDeployTargetName,
  );
}

function parseEnabledRuntimeFamilyList(rawValue) {
  return parseList(rawValue, isKnownRuntimeFamily, normalizeRuntimeFamilyName);
}

function parseEnabledSandboxProfileList(rawValue) {
  return parseList(rawValue, isKnownSandboxProfile, normalizeSandboxProfileName);
}

function getEnabledBackends(env = process.env) {
  const explicit = parseEnabledBackendList(env.ENABLED_BACKENDS);
  return explicit.length > 0 ? explicit : ["docker"];
}

function getEnabledRuntimeFamilies(env = process.env) {
  const explicit = parseEnabledRuntimeFamilyList(env.ENABLED_RUNTIME_FAMILIES);
  return explicit.length > 0 ? explicit : [DEFAULT_RUNTIME_FAMILY];
}

function getEnabledSandboxProfiles(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  if (runtimeFamily === "hermes") return ["standard"];

  const explicit = parseEnabledSandboxProfileList(env.ENABLED_SANDBOX_PROFILES);
  return explicit.length > 0 ? explicit : ["standard"];
}

function executionTargetsForRuntimeFamily(runtimeFamily) {
  return normalizeRuntimeFamilyName(runtimeFamily) === "hermes"
    ? ["docker", "k8s", "remote-docker", "proxmox"]
    : [...KNOWN_DEPLOY_TARGETS];
}

function supportedSandboxProfilesForDeployTarget(runtimeFamily) {
  return normalizeRuntimeFamilyName(runtimeFamily) === "hermes"
    ? ["standard"]
    : [...KNOWN_SANDBOX_PROFILES];
}

function getEnabledDeployTargets(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const supportedTargets = new Set(executionTargetsForRuntimeFamily(runtimeFamily));
  return getEnabledBackends(env).filter((target) => supportedTargets.has(target));
}

function isProxmoxApiTokenId(value) {
  const tokenId = String(value || "").trim();
  return /^[^@!\s]+@[^@!\s]+![^!\s]+$/.test(tokenId);
}

function isEnvFlag(value, expected) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === expected
  );
}

function getProxmoxProductionSecurityIssue(env = process.env) {
  if (!isEnvFlag(env.NODE_ENV, "production")) return null;
  if (isEnvFlag(env.PROXMOX_ALLOW_INSECURE_HTTP, "true")) {
    return "PROXMOX_ALLOW_INSECURE_HTTP=true is not allowed when NODE_ENV=production.";
  }
  if (isEnvFlag(env.PROXMOX_VERIFY_TLS, "false")) {
    return "PROXMOX_VERIFY_TLS=false is not allowed when NODE_ENV=production.";
  }
  if (isEnvFlag(env.PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY, "true")) {
    return "PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY=true is not allowed when NODE_ENV=production.";
  }
  return null;
}

function validateProxmoxFile(filePath, label, options = {}) {
  const readFileSync = options.readFileSync || require("fs").readFileSync;
  try {
    const contents = readFileSync(filePath, "utf8");
    if (!String(contents || "").trim()) return `${label} is empty.`;
  } catch (error) {
    return `${label} could not be read: ${error.message}`;
  }
  return null;
}

function isProxmoxTemplateRef(value) {
  return PROXMOX_TEMPLATE_RE.test(String(value || "").trim());
}

function getProxmoxTemplateIssue(value, envName) {
  const template = String(value || "").trim();
  if (!template) return `${envName} is required.`;
  if (!isProxmoxTemplateRef(template)) {
    return `${envName} must use storage:vztmpl/template.tar.zst format.`;
  }
  return null;
}

function normalizeProxmoxHostExecutable(value, envName, fallback) {
  const executable = String(value || fallback || "").trim();
  const basename = executable.replace(/\/+$/, "").split("/").pop();
  if (
    !PROXMOX_SAFE_HOST_EXECUTABLE_RE.test(executable) ||
    executable.startsWith("-") ||
    basename === "." ||
    basename === ".."
  ) {
    const error = new Error(
      `${envName} must be a single command name or absolute executable path without arguments`,
    );
    error.code = `${envName}_INVALID`;
    throw error;
  }
  return executable;
}

function normalizeProxmoxSudoCommand(value, sshUser) {
  const configured = String(value || "").trim();
  if (!configured) return sshUser === "root" ? [] : ["sudo", "-n"];

  const match = configured.match(/^([^ ]+) -n$/);
  if (!match) {
    const error = new Error(
      "PROXMOX_SUDO must be exactly 'sudo -n' or an absolute sudo path followed by '-n'",
    );
    error.code = "PROXMOX_SUDO_INVALID";
    throw error;
  }
  const executable = normalizeProxmoxHostExecutable(match[1], "PROXMOX_SUDO", "sudo");
  if (executable.replace(/\/+$/, "").split("/").pop() !== "sudo") {
    const error = new Error(
      "PROXMOX_SUDO must invoke the sudo executable with only the non-interactive -n option",
    );
    error.code = "PROXMOX_SUDO_INVALID";
    throw error;
  }
  return [executable, "-n"];
}

function normalizeProxmoxOfflineStageCommand(value, { required = false } = {}) {
  const configured = String(value || "").trim();
  if (!configured) {
    if (!required) return "";
    const error = new Error(
      "Non-root Proxmox SSH requires PROXMOX_OFFLINE_STAGE_COMMAND as one absolute operator-installed helper path",
    );
    error.code = "PROXMOX_OFFLINE_STAGE_COMMAND_REQUIRED";
    throw error;
  }

  const pathSegments = configured.split("/");
  if (
    !PROXMOX_SAFE_HOST_HELPER_RE.test(configured) ||
    configured.endsWith("/") ||
    pathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    const error = new Error(
      "PROXMOX_OFFLINE_STAGE_COMMAND must be one absolute executable path without arguments, traversal, or shell syntax",
    );
    error.code = "PROXMOX_OFFLINE_STAGE_COMMAND_INVALID";
    throw error;
  }
  return configured;
}

function getProxmoxConfigIssue(env = process.env, options = {}) {
  const rawApiUrl = String(env.PROXMOX_API_URL || "").trim();
  if (!rawApiUrl) return "Proxmox requires PROXMOX_API_URL.";

  let apiUrl;
  try {
    apiUrl = new URL(rawApiUrl);
  } catch {
    return "PROXMOX_API_URL must be a valid URL.";
  }
  const productionSecurityIssue = getProxmoxProductionSecurityIssue(env);
  if (productionSecurityIssue) return productionSecurityIssue;
  const allowInsecureHttp = isEnvFlag(env.PROXMOX_ALLOW_INSECURE_HTTP, "true");
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && allowInsecureHttp)) {
    return "PROXMOX_API_URL must use HTTPS (or explicitly set PROXMOX_ALLOW_INSECURE_HTTP=true for an isolated test environment).";
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    return "PROXMOX_API_URL must not contain credentials, query parameters, or a fragment.";
  }
  const apiPath = apiUrl.pathname.replace(/\/+$/, "");
  if (apiPath && apiPath !== "/api2/json") {
    return "PROXMOX_API_URL must point to the Proxmox origin or end in /api2/json.";
  }

  const inlineCa = String(env.PROXMOX_CA_CERT || "");
  const caPath = String(env.PROXMOX_CA_CERT_PATH || "").trim();
  if (!inlineCa && caPath) {
    const caIssue = validateProxmoxFile(caPath, "Proxmox CA certificate", options);
    if (caIssue) return caIssue;
  }

  if (!isProxmoxApiTokenId(env.PROXMOX_TOKEN_ID)) {
    return "PROXMOX_TOKEN_ID must use user@realm!tokenname API-token format.";
  }
  if (!String(env.PROXMOX_TOKEN_SECRET || "").trim()) {
    return "Proxmox requires PROXMOX_TOKEN_SECRET.";
  }
  if (!String(env.PROXMOX_SSH_HOST || "").trim()) {
    return "Proxmox requires PROXMOX_SSH_HOST.";
  }
  const sshUser = String(env.PROXMOX_SSH_USER || "").trim();
  if (!sshUser) {
    return "Proxmox requires PROXMOX_SSH_USER.";
  }
  try {
    normalizeProxmoxHostExecutable(env.PROXMOX_PCT_COMMAND, "PROXMOX_PCT_COMMAND", "pct");
    normalizeProxmoxSudoCommand(env.PROXMOX_SUDO, sshUser);
    normalizeProxmoxOfflineStageCommand(env.PROXMOX_OFFLINE_STAGE_COMMAND, {
      required: sshUser !== "root",
    });
  } catch (error) {
    return error.message;
  }

  const node = String(env.PROXMOX_NODE || "pve").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(node)) {
    return "PROXMOX_NODE contains unsupported characters.";
  }

  const templateIssue = getProxmoxTemplateIssue(
    env.PROXMOX_TEMPLATE || DEFAULT_PROXMOX_TEMPLATE,
    "PROXMOX_TEMPLATE",
  );
  if (templateIssue) return templateIssue;

  const rootfsStorage = String(env.PROXMOX_ROOTFS_STORAGE || "local-lvm").trim();
  if (!PROXMOX_RESOURCE_ID_RE.test(rootfsStorage)) {
    return "PROXMOX_ROOTFS_STORAGE contains unsupported characters.";
  }

  const bridge = String(env.PROXMOX_BRIDGE || "vmbr0").trim();
  if (!PROXMOX_BRIDGE_RE.test(bridge)) {
    return "PROXMOX_BRIDGE must be a 1-15 character interface name using only letters, numbers, dots, underscores, or hyphens.";
  }

  const rawSshPort = String(env.PROXMOX_SSH_PORT || "22").trim();
  const sshPort = Number(rawSshPort);
  if (!/^\d+$/.test(rawSshPort) || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    return "PROXMOX_SSH_PORT must be between 1 and 65535.";
  }

  const inlinePrivateKey = String(env.PROXMOX_SSH_PRIVATE_KEY || "");
  const privateKeyPath = String(env.PROXMOX_SSH_PRIVATE_KEY_PATH || "").trim();
  const password = String(env.PROXMOX_SSH_PASSWORD || "");
  if (!inlinePrivateKey.trim() && !privateKeyPath && !password) {
    return "Proxmox SSH requires PROXMOX_SSH_PRIVATE_KEY, PROXMOX_SSH_PRIVATE_KEY_PATH, or PROXMOX_SSH_PASSWORD.";
  }
  if (!inlinePrivateKey.trim() && privateKeyPath) {
    const keyIssue = validateProxmoxFile(privateKeyPath, "Proxmox SSH private key", options);
    if (keyIssue) return keyIssue;
  }

  if (
    !String(env.PROXMOX_SSH_HOST_FINGERPRINT || "").trim() &&
    !isEnvFlag(env.PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY, "true")
  ) {
    return "Proxmox SSH requires PROXMOX_SSH_HOST_FINGERPRINT (or the explicit test-only PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY=true override).";
  }
  const fingerprint = String(env.PROXMOX_SSH_HOST_FINGERPRINT || "")
    .trim()
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "");
  if (fingerprint && !/^[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
    return "PROXMOX_SSH_HOST_FINGERPRINT must be an OpenSSH SHA256 fingerprint.";
  }
  return null;
}

function baseDeployTargetIssue(deployTarget, env = process.env, selection = {}) {
  switch (normalizeDeployTargetName(deployTarget)) {
    case "k8s":
      if (
        normalizeExecutionTargetId(
          selection.executionTargetId || selection.execution_target_id,
        )?.startsWith("k8s:")
      ) {
        return null;
      }
      return "Kubernetes execution target requires an Admin-registered cluster such as k8s:aks-eastus2.";
    case "remote-docker":
      if (
        normalizeExecutionTargetId(
          selection.executionTargetId || selection.execution_target_id,
        )?.startsWith("remote:")
      ) {
        return null;
      }
      return "Remote Docker execution target requires a registered host such as remote:my-laptop.";
    case "proxmox":
      return getProxmoxConfigIssue(env);
    default:
      return null;
  }
}

function runtimeSelectionIssue(selection = {}, env = process.env) {
  const {
    runtimeFamily = DEFAULT_RUNTIME_FAMILY,
    deployTarget = "docker",
    sandboxProfile = "standard",
  } = selection;
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);
  const normalizedSandboxProfile = normalizeSandboxProfileName(sandboxProfile);
  const normalizedExecutionTargetId =
    normalizeExecutionTargetId(
      selection.executionTargetId || selection.execution_target_id || normalizedDeployTarget,
    ) || normalizedDeployTarget;
  const executionDeployTarget = deployTargetFromExecutionTargetId(normalizedExecutionTargetId);

  if (executionDeployTarget !== normalizedDeployTarget) {
    return `Execution target ${normalizedExecutionTargetId} belongs to deploy target ${executionDeployTarget}, not ${normalizedDeployTarget}.`;
  }

  if (!executionTargetsForRuntimeFamily(normalizedRuntimeFamily).includes(normalizedDeployTarget)) {
    return `${getRuntimeFamilyMetadata(normalizedRuntimeFamily).label} does not support the ${getExecutionTargetMetadata(normalizedDeployTarget, env).label} execution target.`;
  }

  if (normalizedDeployTarget === "proxmox" && normalizedSandboxProfile === "nemoclaw") {
    return PROXMOX_NEMOCLAW_BLOCKER_ISSUE;
  }

  if (
    !supportedSandboxProfilesForDeployTarget(
      normalizedRuntimeFamily,
      normalizedDeployTarget,
    ).includes(normalizedSandboxProfile)
  ) {
    return `${getRuntimeFamilyMetadata(normalizedRuntimeFamily).label} does not support the ${sandboxProfileLabel(normalizedSandboxProfile)} sandbox profile.`;
  }

  const targetIssue = baseDeployTargetIssue(normalizedDeployTarget, env, {
    ...selection,
    executionTargetId:
      selection.executionTargetId ||
      selection.execution_target_id ||
      normalizeExecutionTargetId(selection.deployTarget || selection.deploy_target),
  });
  if (targetIssue) return targetIssue;

  if (normalizedDeployTarget === "proxmox" && normalizedRuntimeFamily === "hermes") {
    const hermesTemplate = String(env.PROXMOX_HERMES_TEMPLATE || "").trim();
    if (!hermesTemplate) {
      return "Hermes on Proxmox requires PROXMOX_HERMES_TEMPLATE.";
    }
    const hermesTemplateIssue = getProxmoxTemplateIssue(hermesTemplate, "PROXMOX_HERMES_TEMPLATE");
    if (hermesTemplateIssue) return hermesTemplateIssue;
  }

  return null;
}

function backendConfigIssue(backend, env = process.env) {
  return baseDeployTargetIssue(backend, env);
}

function getRuntimeSelectionStatus(selection = {}, env = process.env) {
  assertKnownRuntimeSelectionInputs(selection);
  const runtimeFamily = normalizeRuntimeFamilyName(
    selection.runtimeFamily || selection.runtime_family,
  );
  const deployTarget = normalizeDeployTargetName(
    selection.deployTarget ||
      selection.deploy_target ||
      selection.backend ||
      selection.backend_type,
  );
  const sandboxProfile = normalizeSandboxProfileName(
    selection.sandboxProfile ||
      selection.sandbox_profile ||
      selection.sandbox ||
      selection.sandbox_type,
  );
  const executionTargetId =
    normalizeExecutionTargetId(
      selection.executionTargetId ||
        selection.execution_target_id ||
        selection.deployTarget ||
        selection.deploy_target,
    ) || deployTarget;
  const hasRegisteredKubernetesTarget =
    deployTarget === "k8s" && String(executionTargetId || "").startsWith("k8s:");
  const hasRegisteredRemoteTarget =
    deployTarget === "remote-docker" && String(executionTargetId || "").startsWith("remote:");
  const deployTargetEnabled =
    hasRegisteredKubernetesTarget ||
    hasRegisteredRemoteTarget ||
    getEnabledDeployTargets(env, { runtimeFamily }).includes(deployTarget);
  const enabled =
    getEnabledRuntimeFamilies(env).includes(runtimeFamily) &&
    deployTargetEnabled &&
    getEnabledSandboxProfiles(env, { runtimeFamily }).includes(sandboxProfile);
  const issue = runtimeSelectionIssue(
    { runtimeFamily, deployTarget, executionTargetId, sandboxProfile },
    env,
  );
  return {
    enabled,
    configured: issue == null,
    available: enabled && issue == null,
    issue,
    runtimeFamily,
    deployTarget,
    executionTargetId,
    sandboxProfile,
  };
}

function firstAvailable(candidates) {
  return (
    candidates.find((candidate) => candidate.available) ||
    candidates.find((candidate) => candidate.enabled) ||
    candidates[0] ||
    null
  );
}

function getDefaultRuntimeFamily(env = process.env) {
  const enabledFamilies = getEnabledRuntimeFamilies(env);
  const available = enabledFamilies.find((runtimeFamily) =>
    getEnabledDeployTargets(env, { runtimeFamily }).some((deployTarget) =>
      getEnabledSandboxProfiles(env, { runtimeFamily }).some(
        (sandboxProfile) =>
          getRuntimeSelectionStatus({ runtimeFamily, deployTarget, sandboxProfile }, env).available,
      ),
    ),
  );
  return available || enabledFamilies[0] || DEFAULT_RUNTIME_FAMILY;
}

function getDefaultDeployTarget(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const sandboxProfile =
    options.sandbox === "nemoclaw" || options.sandboxProfile === "nemoclaw"
      ? "nemoclaw"
      : "standard";
  const requested = options.backend ? normalizeDeployTargetName(options.backend) : null;
  const candidates = getEnabledDeployTargets(env, { runtimeFamily })
    .filter((deployTarget) =>
      executionTargetsForRuntimeFamily(runtimeFamily).includes(deployTarget),
    )
    .map((deployTarget) => ({
      deployTarget,
      ...getRuntimeSelectionStatus({ runtimeFamily, deployTarget, sandboxProfile }, env),
    }));
  if (requested && candidates.some((candidate) => candidate.deployTarget === requested)) {
    return requested;
  }
  return firstAvailable(candidates)?.deployTarget || "docker";
}

function getDefaultSandboxProfile(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const deployTarget = normalizeDeployTargetName(
    options.deployTarget || getDefaultDeployTarget(env, { runtimeFamily }),
  );
  const requested =
    options.sandbox === "nemoclaw" || options.sandboxProfile === "nemoclaw" ? "nemoclaw" : null;
  const candidates = getEnabledSandboxProfiles(env, { runtimeFamily })
    .filter((sandboxProfile) =>
      supportedSandboxProfilesForDeployTarget(runtimeFamily, deployTarget).includes(sandboxProfile),
    )
    .map((sandboxProfile) => ({
      sandboxProfile,
      ...getRuntimeSelectionStatus({ runtimeFamily, deployTarget, sandboxProfile }, env),
    }));
  if (requested && candidates.some((candidate) => candidate.sandboxProfile === requested)) {
    return requested;
  }
  return firstAvailable(candidates)?.sandboxProfile || "standard";
}

function getDefaultBackend(env = process.env, options = {}) {
  return getDefaultDeployTarget(env, options);
}

function buildSandboxProfileOption(runtimeFamily, deployTarget, sandboxProfile, env = process.env) {
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);
  const normalizedSandboxProfile = normalizeSandboxProfileName(sandboxProfile);
  const runtimeFamilyMetadata = getRuntimeFamilyMetadata(normalizedRuntimeFamily);
  const deployTargetMetadata = getExecutionTargetMetadata(normalizedDeployTarget, env);
  const sandboxMetadata = getSandboxProfileMetadata(normalizedSandboxProfile);
  const status = getRuntimeSelectionStatus(
    {
      runtimeFamily: normalizedRuntimeFamily,
      deployTarget: normalizedDeployTarget,
      sandboxProfile: normalizedSandboxProfile,
    },
    env,
  );
  const maturityFields = buildMaturityFields(
    resolveMaturityTier({
      runtimeFamily: normalizedRuntimeFamily,
      deployTarget: normalizedDeployTarget,
      sandboxProfile: normalizedSandboxProfile,
    }),
  );
  const fullLabel =
    normalizedSandboxProfile === "nemoclaw"
      ? `${runtimeFamilyMetadata.label} + ${deployTargetMetadata.label} + ${sandboxMetadata.label}`
      : `${runtimeFamilyMetadata.label} + ${deployTargetMetadata.label}`;

  return {
    ...sandboxMetadata,
    ...status,
    isDefault:
      normalizedDeployTarget ===
        getDefaultDeployTarget(env, { runtimeFamily: normalizedRuntimeFamily }) &&
      normalizedSandboxProfile ===
        getDefaultSandboxProfile(env, {
          runtimeFamily: normalizedRuntimeFamily,
          deployTarget: normalizedDeployTarget,
        }),
    runtimeFamily: normalizedRuntimeFamily,
    runtimeFamilyLabel: runtimeFamilyMetadata.label,
    deployTarget: normalizedDeployTarget,
    deployTargetLabel: deployTargetMetadata.label,
    sandboxProfile: normalizedSandboxProfile,
    sandboxProfileLabel: sandboxMetadata.label,
    fullLabel,
    legacyBackendId: normalizedDeployTarget,
    selectionId: `${normalizedRuntimeFamily}:${normalizedDeployTarget}:${normalizedSandboxProfile}`,
    selectionType: "sandbox_profile",
    models: normalizedSandboxProfile === "nemoclaw" ? [...NEMOCLAW_MODELS] : [],
    defaultModel: normalizedSandboxProfile === "nemoclaw" ? getNemoClawDefaultModel(env) : null,
    sandboxImage: normalizedSandboxProfile === "nemoclaw" ? getNemoClawSandboxImage(env) : null,
    availableForOnboarding: maturityFields.onboardingVisible && status.available,
    ...maturityFields,
  };
}

function buildExecutionTargetEntry(runtimeFamily, deployTarget, env = process.env) {
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const normalizedDeployTarget = normalizeDeployTargetName(deployTarget);
  const metadata = getExecutionTargetMetadata(normalizedDeployTarget, env);
  const runtimeFamilyMetadata = getRuntimeFamilyMetadata(normalizedRuntimeFamily);
  const supportedSandboxProfiles = supportedSandboxProfilesForDeployTarget(
    normalizedRuntimeFamily,
    normalizedDeployTarget,
  );
  const sandboxProfiles = supportedSandboxProfiles.map((sandboxProfile) =>
    buildSandboxProfileOption(normalizedRuntimeFamily, normalizedDeployTarget, sandboxProfile, env),
  );
  const enabledSandboxProfiles = sandboxProfiles
    .filter((option) => option.enabled)
    .map((option) => option.id);
  const availableSandboxProfiles = sandboxProfiles
    .filter((option) => option.available)
    .map((option) => option.id);
  const selectableSandboxProfiles = sandboxProfiles.filter(
    (option) => option.enabled && option.availableForOnboarding,
  );
  const defaultSelection =
    sandboxProfiles.find((option) => option.isDefault) ||
    sandboxProfiles.find((option) => option.available) ||
    sandboxProfiles.find((option) => option.enabled) ||
    sandboxProfiles[0];
  const enabled = sandboxProfiles.some((option) => option.enabled);
  const configured = sandboxProfiles.some((option) => option.configured);
  const available = sandboxProfiles.some((option) => option.available);
  const maturityFields = buildMaturityFields(
    defaultSelection?.maturityTier ||
      resolveMaturityTier({
        runtimeFamily: normalizedRuntimeFamily,
        deployTarget: normalizedDeployTarget,
        sandboxProfile: defaultSelection?.id || "standard",
      }),
  );

  return {
    ...metadata,
    enabled,
    configured,
    available,
    issue:
      enabled && !available
        ? defaultSelection?.issue || sandboxProfiles.find((option) => option.issue)?.issue || null
        : null,
    isDefault:
      normalizedDeployTarget ===
      getDefaultDeployTarget(env, { runtimeFamily: normalizedRuntimeFamily }),
    runtimeFamily: runtimeFamilyMetadata.id,
    runtimeFamilyLabel: runtimeFamilyMetadata.label,
    defaultSandboxProfile: defaultSelection?.id || "standard",
    enabledSandboxProfiles,
    availableSandboxProfiles,
    supportedSandboxProfiles,
    supportsSandboxSelection: selectableSandboxProfiles.length > 1,
    sandboxProfiles,
    availableForOnboarding: selectableSandboxProfiles.length > 0,
    fullLabel: defaultSelection?.fullLabel || `${runtimeFamilyMetadata.label} + ${metadata.label}`,
    ...maturityFields,
  };
}

function buildKubernetesClusterExecutionTargetEntry(
  runtimeFamily,
  cluster = {},
  env = process.env,
) {
  const base = buildExecutionTargetEntry(runtimeFamily, "k8s", env);
  const runtimeFamilyMetadata = getRuntimeFamilyMetadata(runtimeFamily);
  const normalizedRuntimeFamily = normalizeRuntimeFamilyName(runtimeFamily);
  const executionTargetId =
    normalizeExecutionTargetId(
      cluster.executionTargetId ||
        cluster.execution_target_id ||
        (cluster.id ? `k8s:${cluster.id}` : "k8s"),
    ) || "k8s";
  const label = cluster.label || cluster.clusterName || base.label;
  const providerLabel =
    cluster.providerLabel || cluster.provider || base.providerLabel || "Kubernetes";
  const runtimeFamilyEnabled = getEnabledRuntimeFamilies(env).includes(normalizedRuntimeFamily);
  const enabled = runtimeFamilyEnabled && cluster.enabled !== false;
  const configured = cluster.configured !== false;
  const available = enabled && configured && cluster.available !== false;
  const supportsNetworkPolicy = cluster.supportsNetworkPolicy === true;
  const policyEngine = String(cluster.policyEngine || "").trim() || null;
  const policySupportStatus =
    cluster.policySupportStatus || (supportsNetworkPolicy ? "supported" : "degraded");
  const policyIssue =
    cluster.policyIssue ||
    (supportsNetworkPolicy
      ? null
      : "Cluster does not currently advertise Kubernetes NetworkPolicy support. Nora will deploy in degraded mode.");
  const issue = available
    ? null
    : cluster.issue || (!enabled ? `${label} is disabled.` : `${label} is not configured.`);
  const sandboxProfiles = base.sandboxProfiles.map((option) => {
    const optionEnabled =
      enabled &&
      supportedSandboxProfilesForDeployTarget(normalizedRuntimeFamily, "k8s").includes(option.id) &&
      getEnabledSandboxProfiles(env, { runtimeFamily: normalizedRuntimeFamily }).includes(
        option.id,
      );
    const optionAvailable = available && optionEnabled;

    return {
      ...option,
      enabled: optionEnabled,
      configured,
      available: optionAvailable,
      issue,
      supportsNetworkPolicy,
      policyEngine,
      policySupportStatus,
      policyIssue,
      deployTarget: "k8s",
      executionTargetId,
      deployTargetLabel: label,
      fullLabel:
        option.id === "nemoclaw"
          ? `${runtimeFamilyMetadata.label} + ${label} + ${option.sandboxProfileLabel}`
          : `${runtimeFamilyMetadata.label} + ${label}`,
      legacyBackendId: "k8s",
      selectionId: `${runtimeFamilyMetadata.id}:${executionTargetId}:${option.id}`,
      availableForOnboarding: option.onboardingVisible !== false && optionAvailable,
    };
  });
  const enabledSandboxProfiles = sandboxProfiles
    .filter((option) => option.enabled)
    .map((option) => option.id);
  const availableSandboxProfiles = sandboxProfiles
    .filter((option) => option.available)
    .map((option) => option.id);
  const selectableSandboxProfiles = sandboxProfiles.filter(
    (option) => option.enabled && option.availableForOnboarding && option.available,
  );
  const defaultSelection =
    sandboxProfiles.find((option) => option.isDefault) ||
    sandboxProfiles.find((option) => option.available) ||
    sandboxProfiles.find((option) => option.enabled) ||
    sandboxProfiles[0];

  return {
    ...base,
    id: executionTargetId,
    executionTargetId,
    adapter: "k8s",
    deployTarget: "k8s",
    legacyBackendId: "k8s",
    label,
    shortLabel: cluster.shortLabel || label,
    summary: cluster.summary || base.summary,
    detail: cluster.detail || base.detail,
    badges: cluster.badges || base.badges,
    providerId: cluster.providerId || cluster.provider || base.providerId,
    providerLabel,
    clusterName: cluster.clusterName || cluster.cluster_name || "",
    namespace: cluster.openclawNamespace || cluster.namespace || "",
    exposureMode: cluster.exposureMode || cluster.exposure_mode || "",
    supportsNetworkPolicy,
    policyEngine,
    policySupportStatus,
    policyIssue,
    enabled,
    configured,
    available,
    issue,
    isDefault: Boolean(cluster.isDefault || cluster.is_default),
    defaultSandboxProfile: defaultSelection?.id || "standard",
    enabledSandboxProfiles,
    availableSandboxProfiles,
    supportsSandboxSelection: selectableSandboxProfiles.length > 1,
    sandboxProfiles,
    availableForOnboarding: selectableSandboxProfiles.length > 0,
    fullLabel: defaultSelection?.fullLabel || `${runtimeFamilyMetadata.label} + ${label}`,
  };
}

function getExecutionTargetCatalog(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const kubernetesClusters = Array.isArray(options.kubernetesClusters)
    ? options.kubernetesClusters
    : [];
  return executionTargetsForRuntimeFamily(runtimeFamily).flatMap((deployTarget) => {
    if (deployTarget === "k8s") {
      return kubernetesClusters.map((cluster) =>
        buildKubernetesClusterExecutionTargetEntry(runtimeFamily, cluster, env),
      );
    }
    return [buildExecutionTargetEntry(runtimeFamily, deployTarget, env)];
  });
}

function getSandboxProfileCatalog(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const executionTargets = getExecutionTargetCatalog(env, {
    runtimeFamily,
    kubernetesClusters: options.kubernetesClusters,
  });
  const supportedSandboxProfiles =
    runtimeFamily === "hermes" ? ["standard"] : [...KNOWN_SANDBOX_PROFILES];

  return supportedSandboxProfiles.map((sandboxProfile) => {
    const relatedTargets = executionTargets.filter(
      (target) =>
        target.enabled &&
        target.sandboxProfiles.some((option) => option.id === sandboxProfile && option.enabled),
    );
    const relatedOptions = relatedTargets.flatMap((target) =>
      target.sandboxProfiles.filter((option) => option.id === sandboxProfile),
    );
    const metadata = getSandboxProfileMetadata(sandboxProfile);
    const defaultOption =
      relatedOptions.find((option) => option.isDefault) ||
      relatedOptions.find((option) => option.available) ||
      relatedOptions.find((option) => option.enabled) ||
      null;
    const maturityFields = buildMaturityFields(
      defaultOption?.maturityTier ||
        (sandboxProfile === "nemoclaw" || runtimeFamily === "hermes" ? "experimental" : "ga"),
    );

    return {
      ...metadata,
      enabled: relatedOptions.some((option) => option.enabled),
      configured: relatedOptions.some((option) => option.configured),
      available: relatedOptions.some((option) => option.available),
      issue:
        relatedOptions.length > 0 && !relatedOptions.some((option) => option.available)
          ? relatedOptions.find((option) => option.issue)?.issue || null
          : null,
      executionTargets: relatedTargets.map((target) => target.id),
      models: sandboxProfile === "nemoclaw" ? [...NEMOCLAW_MODELS] : [],
      defaultModel: sandboxProfile === "nemoclaw" ? getNemoClawDefaultModel(env) : null,
      sandboxImage: sandboxProfile === "nemoclaw" ? getNemoClawSandboxImage(env) : null,
      availableForOnboarding:
        maturityFields.onboardingVisible && relatedOptions.some((option) => option.available),
      ...maturityFields,
    };
  });
}

function buildCatalogEntry(backendId, env = process.env, options = {}) {
  const deployTarget = normalizeDeployTargetName(backendId);
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const target = buildExecutionTargetEntry(runtimeFamily, deployTarget, env);
  const metadata = getBackendMetadata(deployTarget, env);
  return {
    ...metadata,
    ...target,
    id: deployTarget,
    deployTarget,
    deployTargetLabel: target.label,
    sandboxProfile: target.defaultSandboxProfile,
    sandboxProfileLabel: sandboxProfileLabel(target.defaultSandboxProfile),
    selectionId: deployTarget,
    selectionLabel: target.fullLabel,
    selectionType: "deploy_target",
    legacyBackendId: deployTarget,
  };
}

function getBackendCatalog(env = process.env, options = {}) {
  const runtimeFamily = normalizeRuntimeFamilyName(
    options.runtimeFamily || getDefaultRuntimeFamily(env),
  );
  const kubernetesClusters = Array.isArray(options.kubernetesClusters)
    ? options.kubernetesClusters
    : [];
  return KNOWN_DEPLOY_TARGETS.flatMap((backendId) => {
    if (backendId === "k8s") {
      return kubernetesClusters.map((cluster) => {
        const target = buildKubernetesClusterExecutionTargetEntry(runtimeFamily, cluster, env);
        return {
          ...target,
          id: target.id,
          deployTarget: "k8s",
          deployTargetLabel: target.label,
          sandboxProfile: target.defaultSandboxProfile,
          sandboxProfileLabel: sandboxProfileLabel(target.defaultSandboxProfile),
          selectionId: target.id,
          selectionLabel: target.fullLabel,
          selectionType: "deploy_target",
          legacyBackendId: "k8s",
        };
      });
    }
    return [buildCatalogEntry(backendId, env, { runtimeFamily })];
  });
}

function isBackendEnabled(backend, env = process.env) {
  return getEnabledBackends(env).includes(normalizeDeployTargetName(backend));
}

function getBackendStatus(backend, env = process.env) {
  return buildCatalogEntry(backend, env);
}

function buildBackendEnablementMessage(backendOrStatus, env = process.env) {
  const status =
    backendOrStatus && typeof backendOrStatus === "object"
      ? backendOrStatus
      : getBackendStatus(backendOrStatus, env);
  if (status.id === "k8s") {
    return `${status.label} is not enabled. Register a Kubernetes cluster in Admin -> Kubernetes.`;
  }
  return `${status.label} is not enabled. Enable it with ` + `ENABLED_BACKENDS=${status.id}.`;
}

function getRuntimeCatalog(env = process.env, options = {}) {
  const defaultRuntimeFamily = getDefaultRuntimeFamily(env);

  return getEnabledRuntimeFamilies(env).map((runtimeFamily) => {
    const metadata = getRuntimeFamilyMetadata(runtimeFamily);
    const executionTargets = getExecutionTargetCatalog(env, {
      runtimeFamily,
      kubernetesClusters: options.kubernetesClusters,
    });
    const sandboxProfiles = getSandboxProfileCatalog(env, {
      runtimeFamily,
      kubernetesClusters: options.kubernetesClusters,
    });
    const enabled = executionTargets.some((target) => target.enabled);
    const configured = executionTargets.some((target) => target.configured);
    const available = executionTargets.some((target) => target.available);
    const enabledDeployTargets = Array.from(
      new Set([
        ...getEnabledDeployTargets(env, { runtimeFamily }),
        ...executionTargets
          .filter((target) => target.enabled)
          .map((target) => target.deployTarget || target.id),
      ]),
    ).filter(Boolean);

    return {
      ...metadata,
      enabled,
      configured,
      available,
      isDefault: runtimeFamily === defaultRuntimeFamily,
      defaultDeployTarget: getDefaultDeployTarget(env, { runtimeFamily }),
      defaultSandboxProfile: getDefaultSandboxProfile(env, { runtimeFamily }),
      enabledDeployTargets,
      enabledSandboxProfiles: getEnabledSandboxProfiles(env, { runtimeFamily }),
      executionTargets,
      sandboxProfiles,
      availableForOnboarding: executionTargets.some((target) => target.availableForOnboarding),
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
  PROXMOX_NEMOCLAW_BLOCKER_ISSUE,
  RUNTIME_FAMILY_METADATA,
  backendConfigIssue,
  backendForRuntimeSelection,
  buildBackendEnablementMessage,
  buildKubernetesClusterExecutionTargetEntry,
  deployTargetFromExecutionTargetId,
  deployTargetForBackend,
  getBackendCatalog,
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
  getProxmoxConfigIssue,
  getProxmoxProductionSecurityIssue,
  getRuntimeCatalog,
  getRuntimeFamilyMetadata,
  getRuntimeSelectionStatus,
  getSandboxProfileCatalog,
  getSandboxProfileMetadata,
  isBackendEnabled,
  isKnownBackend,
  isKnownDeployTarget,
  isKnownRuntimeFamily,
  isKnownSandboxProfile,
  isProxmoxApiTokenId,
  normalizeBackendName,
  normalizeDeployTargetName,
  normalizeExecutionTargetId,
  normalizeProxmoxHostExecutable,
  normalizeProxmoxOfflineStageCommand,
  normalizeProxmoxSudoCommand,
  normalizeRuntimeFamilyName,
  normalizeSandboxProfileName,
  runtimeFamilyForBackend,
  runtimeSelectionIssue,
  sandboxForBackend,
  sandboxProfileLabel,
  selectionTypeForBackend,
};
