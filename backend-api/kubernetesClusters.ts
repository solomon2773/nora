// @ts-nocheck
const { createHash, randomUUID } = require("crypto");
const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const ipaddr = require("ipaddr.js");
const {
  getExecutionTargetMetadata,
  normalizeDeployTargetName,
  normalizeExecutionTargetId,
} = require("../agent-runtime/lib/backendCatalog");

const PROVIDERS = new Set(["kubernetes", "k3s", "aks", "gke", "eks"]);
const CREDENTIAL_MODES = new Set(["encrypted_kubeconfig", "mounted_path"]);
const EXPOSURE_MODES = new Set(["cluster-ip", "node-port", "load-balancer"]);
const POLICY_STATUS_STATES = new Set(["queued", "applying", "applied", "failed"]);
const POLICY_INGRESS_PORTS = Object.freeze({
  openclaw: Object.freeze([18789, 9090]),
  hermes: Object.freeze([8642, 9119]),
});
const POLICY_RULE_DESCRIPTION_MAX_LENGTH = 200;
let k8sClient = null;

function getK8sClient() {
  if (!k8sClient) {
    k8sClient = require("@kubernetes/client-node");
  }
  return k8sClient;
}

function formatKubeconfigLoadError(profile, error) {
  const label = profile.label || profile.executionTargetId || profile.id || "Kubernetes cluster";
  const kubeconfigPath = normalizeText(profile.kubeconfigPath);
  if (kubeconfigPath && error?.code === "ENOENT") {
    return `${label} mounted kubeconfig file was not found at ${kubeconfigPath}. Make sure NORA_KUBECONFIGS_DIR is mounted with docker-compose.kubernetes.yml and contains this file, or update the Admin Kubeconfig path to the file visible inside the Nora containers.`;
  }
  if (kubeconfigPath && error?.code === "EACCES") {
    return `${label} mounted kubeconfig file is not readable at ${kubeconfigPath}. Make sure the file is readable by the backend-api and worker-provisioner containers.`;
  }
  if (kubeconfigPath) {
    return `${label} mounted kubeconfig file at ${kubeconfigPath} could not be loaded: ${error?.message || "unknown error"}`;
  }
  return error?.message || "Kubernetes kubeconfig could not be loaded.";
}

function hasText(value) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSlug(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function normalizeClusterId(value, fallbackLabel = "") {
  const normalized = normalizeSlug(value) || normalizeSlug(fallbackLabel);
  if (!normalized) {
    const error = new Error("Cluster id is required");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
    const error = new Error("Cluster id must be 2-64 lowercase letters, numbers, or dashes");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeProvider(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["azure", "azure-aks"].includes(normalized)) return "aks";
  if (["google", "google-gke"].includes(normalized)) return "gke";
  if (["aws", "aws-eks"].includes(normalized)) return "eks";
  return PROVIDERS.has(normalized) ? normalized : "kubernetes";
}

function normalizeCredentialMode(value, fallback = "mounted_path") {
  const normalized = normalizeText(value).toLowerCase();
  return CREDENTIAL_MODES.has(normalized) ? normalized : fallback;
}

function normalizeExposureMode(value, fallback = "cluster-ip") {
  const normalized = normalizeText(value).toLowerCase();
  const canonical = normalized === "loadbalancer" ? "load-balancer" : normalized;
  return EXPOSURE_MODES.has(canonical) ? canonical : fallback;
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInteger(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value) {
  const parsed = parseInteger(value, null);
  if (!Number.isFinite(parsed)) return null;
  return parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function parseJsonObject(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

// Network policy normalization

function createPolicyValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function buildEmptyPolicySettings() {
  return {
    ingressRules: {
      openclaw: [],
      hermes: [],
    },
  };
}

function parseStructuredObject(value, fieldName, { lenient = false, fallback = {} } = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      if (lenient) return fallback;
      throw createPolicyValidationError(`${fieldName} must be a JSON object.`);
    }
    if (lenient) return fallback;
    throw createPolicyValidationError(`${fieldName} must be a JSON object.`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (lenient) return fallback;
  throw createPolicyValidationError(`${fieldName} must be an object.`);
}

function normalizeCidr(value, { lenient = false } = {}) {
  const raw = normalizeText(value);
  if (!raw) {
    if (lenient) return "";
    throw createPolicyValidationError("Ingress rules require a CIDR block.");
  }

  try {
    const [address, prefix] = ipaddr.parseCIDR(raw);
    const normalizedAddress =
      address.kind() === "ipv6"
        ? address.toRFC5952String()
        : typeof address.toString === "function"
          ? address.toString()
          : String(address);
    return `${normalizedAddress}/${prefix}`;
  } catch {
    if (lenient) return "";
    throw createPolicyValidationError(`Invalid CIDR block: ${raw}`);
  }
}

function normalizeIngressPorts(runtimeFamily, ports, { lenient = false } = {}) {
  if (!Array.isArray(ports) || ports.length === 0) {
    if (lenient) return [];
    throw createPolicyValidationError(
      `${runtimeFamily} ingress rules must include a non-empty ports array.`,
    );
  }

  const allowedPorts = new Set(POLICY_INGRESS_PORTS[runtimeFamily] || []);
  const normalized = [];
  for (const value of ports) {
    const parsed = parsePort(value);
    if (!parsed) {
      if (lenient) continue;
      throw createPolicyValidationError(
        `${runtimeFamily} ingress rules may only contain valid TCP ports.`,
      );
    }
    if (!allowedPorts.has(parsed)) {
      throw createPolicyValidationError(
        `${runtimeFamily} ingress rules may only target ports ${POLICY_INGRESS_PORTS[
          runtimeFamily
        ].join(" and ")}.`,
      );
    }
    normalized.push(parsed);
  }

  return Array.from(new Set(normalized)).sort((left, right) => left - right);
}

/**
 * Validate and canonicalize one runtime family's CIDR-based ingress rules.
 * Strict input rejects duplicate CIDRs and ports outside Nora's runtime baseline.
 *
 * @param {string} runtimeFamily - Supported runtime family whose ports are allowed.
 * @param {Array} rules - Ingress rules to normalize.
 * @param {Object} [options={}] - Optional lenient persisted-data handling.
 * @returns {Array} Canonical rules with stable shapes and unique CIDRs.
 */
function normalizeIngressPolicyRules(runtimeFamily, rules, options = {}) {
  const { lenient = false } = options;
  if (!Object.prototype.hasOwnProperty.call(POLICY_INGRESS_PORTS, runtimeFamily)) {
    throw createPolicyValidationError(`Unsupported runtime family: ${runtimeFamily}`);
  }
  if (rules == null) return [];
  if (!Array.isArray(rules)) {
    if (lenient) return [];
    throw createPolicyValidationError(`${runtimeFamily} ingress rules must be an array.`);
  }

  const deduped = new Map();
  const seenCidrs = new Set();
  for (const rawRule of rules) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      if (lenient) continue;
      throw createPolicyValidationError(`${runtimeFamily} ingress rules must be objects.`);
    }

    const cidr = normalizeCidr(rawRule.cidr, { lenient });
    const normalizedPorts = normalizeIngressPorts(runtimeFamily, rawRule.ports, { lenient });
    if (!cidr || normalizedPorts.length === 0) continue;

    const descriptionRaw = rawRule.description == null ? "" : String(rawRule.description);
    const description = normalizeText(descriptionRaw);
    if (description.length > POLICY_RULE_DESCRIPTION_MAX_LENGTH) {
      throw createPolicyValidationError(
        `${runtimeFamily} ingress rule descriptions must be ${POLICY_RULE_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      );
    }

    const dedupeKey = `${runtimeFamily}|${cidr}|${normalizedPorts.join(",")}`;
    if (seenCidrs.has(cidr)) {
      if (lenient) continue;
      throw createPolicyValidationError(
        `${runtimeFamily} ingress already includes ${cidr}. Edit the existing rule instead of adding a duplicate CIDR.`,
      );
    }
    seenCidrs.add(cidr);
    if (deduped.has(dedupeKey)) continue;

    deduped.set(dedupeKey, {
      id: normalizeText(rawRule.id) || randomUUID(),
      cidr,
      ports: normalizedPorts,
      description: description || null,
    });
  }

  return Array.from(deduped.values());
}

function normalizeLastAppliedNamespaces(value, { lenient = false } = {}) {
  if (value == null || value === "") return null;
  const input = parseStructuredObject(value, "policySettingsStatus.lastAppliedNamespaces", {
    lenient,
    fallback: {},
  });
  const normalized = {};
  for (const runtimeFamily of Object.keys(POLICY_INGRESS_PORTS)) {
    const rawNamespaces = input[runtimeFamily];
    const values = Array.isArray(rawNamespaces) ? rawNamespaces : [rawNamespaces];
    const namespaces = Array.from(
      new Set(values.map((entry) => normalizeText(entry)).filter(Boolean)),
    );
    if (namespaces.length > 0) {
      normalized[runtimeFamily] = namespaces;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeTimestamp(value, fieldName, { lenient = false } = {}) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    if (lenient) return null;
    throw createPolicyValidationError(`${fieldName} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

/**
 * Normalize the full custom ingress-policy document for OpenClaw and Hermes runtimes.
 * Omitted runtime-family buckets are treated as empty replacement lists.
 *
 * @param {Object} [input={}] - Policy settings candidate.
 * @param {Object|null} [existing=null] - Fallback for missing roots or lenient persisted reads.
 * @param {Object} [options={}] - Optional lenient persisted-data handling.
 * @returns {Object} Canonical policy settings.
 */
function normalizePolicySettings(input = {}, existing = null, options = {}) {
  const { lenient = false } = options;
  const existingInput =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const root = parseStructuredObject(input, "policySettings", {
    lenient,
    fallback: existingInput,
  });
  const ingressRules = parseStructuredObject(root.ingressRules, "policySettings.ingressRules", {
    lenient,
    fallback: {},
  });

  return {
    ingressRules: {
      openclaw: normalizeIngressPolicyRules("openclaw", ingressRules.openclaw ?? [], { lenient }),
      hermes: normalizeIngressPolicyRules("hermes", ingressRules.hermes ?? [], { lenient }),
    },
  };
}

/**
 * Hash normalized policy state for desired-versus-applied reconciliation checks.
 * Deterministic hashes require stable rule IDs; normalization generates missing IDs.
 *
 * @param {Object} policySettings - Policy settings to fingerprint.
 * @returns {string} SHA-256 hash of the normalized document.
 */
function buildPolicySettingsHash(policySettings) {
  const normalized = normalizePolicySettings(policySettings, buildEmptyPolicySettings(), {
    lenient: true,
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Normalize worker reconciliation status, hashes, namespaces, issues, and timestamps.
 *
 * @param {Object} [input={}] - Status fields to normalize.
 * @param {Object|null} [existing=null] - Existing status used for omitted values.
 * @param {Object|null} [policySettings=null] - Desired settings used to derive a fallback hash.
 * @param {Object} [options={}] - Optional lenient persisted-data handling.
 * @returns {Object} Canonical policy reconciliation status.
 */
function normalizePolicySettingsStatus(
  input = {},
  existing = null,
  policySettings = null,
  options = {},
) {
  const { lenient = false } = options;
  const fallback =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const root = parseStructuredObject(input, "policySettingsStatus", { lenient, fallback });
  const desiredHashFallback = policySettings ? buildPolicySettingsHash(policySettings) : null;
  const state = normalizeText(root.state ?? fallback.state).toLowerCase();
  if (state && !POLICY_STATUS_STATES.has(state)) {
    if (!lenient) {
      throw createPolicyValidationError(
        `policySettingsStatus.state must be one of ${Array.from(POLICY_STATUS_STATES).join(", ")}.`,
      );
    }
  }

  const normalized = {
    state: POLICY_STATUS_STATES.has(state) ? state : null,
    desiredHash:
      normalizeText(root.desiredHash ?? root.desired_hash ?? fallback.desiredHash) ||
      desiredHashFallback ||
      null,
    appliedHash:
      normalizeText(root.appliedHash ?? root.applied_hash ?? fallback.appliedHash) || null,
    lastAppliedNamespaces: normalizeLastAppliedNamespaces(
      root.lastAppliedNamespaces ?? root.last_applied_namespaces ?? fallback.lastAppliedNamespaces,
      { lenient },
    ),
    customPolicyIssue:
      normalizeText(
        root.customPolicyIssue ?? root.custom_policy_issue ?? fallback.customPolicyIssue,
      ) || null,
    customPolicyAppliedAt: normalizeTimestamp(
      root.customPolicyAppliedAt ?? root.custom_policy_applied_at ?? fallback.customPolicyAppliedAt,
      "policySettingsStatus.customPolicyAppliedAt",
      { lenient },
    ),
    updatedAt: normalizeTimestamp(
      root.updatedAt ?? root.updated_at ?? fallback.updatedAt,
      "policySettingsStatus.updatedAt",
      { lenient },
    ),
  };

  return Object.values(normalized).some((value) => value != null) ? normalized : {};
}

/**
 * Summarize whether custom policy is configured and applied to the current desired hash.
 *
 * @param {Object} policySettings - Desired policy settings.
 * @param {Object} [policySettingsStatus={}] - Latest worker reconciliation status.
 * @returns {Object} Public capability and reconciliation summary fields.
 */
function buildPolicySettingsSummary(policySettings, policySettingsStatus = {}) {
  const normalizedSettings = normalizePolicySettings(policySettings, buildEmptyPolicySettings(), {
    lenient: true,
  });
  const normalizedStatus = normalizePolicySettingsStatus(
    policySettingsStatus,
    null,
    normalizedSettings,
    { lenient: true },
  );
  const openclawCount = normalizedSettings.ingressRules.openclaw.length;
  const hermesCount = normalizedSettings.ingressRules.hermes.length;
  const configured = openclawCount + hermesCount > 0;
  const currentSettingsHash = buildPolicySettingsHash(normalizedSettings);
  const desiredHash =
    configured || normalizedStatus.state
      ? currentSettingsHash
      : normalizedStatus.desiredHash || null;
  const applied =
    configured &&
    normalizedStatus.state === "applied" &&
    Boolean(normalizedStatus.appliedHash) &&
    normalizedStatus.appliedHash === currentSettingsHash;

  return {
    customPolicyConfigured: configured,
    customIngressConfigured: configured,
    customPolicyApplied: applied,
    customPolicyIssue: normalizedStatus.customPolicyIssue || null,
    customPolicyState: normalizedStatus.state || null,
    customPolicyDesiredHash: desiredHash,
    customPolicyAppliedAt: normalizedStatus.customPolicyAppliedAt || null,
    customIngressRuleCounts: {
      openclaw: openclawCount,
      hermes: hermesCount,
    },
  };
}

// Cluster profile normalization

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean);
  }
  return normalizeText(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function normalizeNullableBool(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function detectPolicyEngineFromDaemonSets(items = []) {
  const names = items
    .map((item) => normalizeText(item?.metadata?.name).toLowerCase())
    .filter(Boolean);
  if (names.some((name) => name.includes("cilium"))) return "cilium";
  if (names.some((name) => name.includes("calico"))) return "calico";
  if (names.some((name) => name.includes("azure-npm") || name.includes("npm-"))) {
    return "azure-npm";
  }
  return "";
}

function maskCluster(row) {
  const profile = rowToProfile(row, { includeSecret: false });
  return {
    ...profile,
    hasEncryptedKubeconfig: Boolean(row?.kubeconfig_encrypted),
    kubeconfigContent: undefined,
  };
}

/**
 * Convert a cluster row into its provisioning profile and derived policy/availability state.
 * Kubeconfig content is decrypted only when explicitly requested by a trusted internal caller.
 *
 * @param {Object} row - Kubernetes-cluster database row.
 * @param {Object} [options={}] - Profile serialization options.
 * @returns {Object|null} Normalized cluster profile.
 */
function rowToProfile(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const id = normalizeClusterId(row.id || row.cluster_id || row.label || "cluster");
  const provider = normalizeProvider(row.provider);
  const namespace = normalizeText(row.namespace) || "openclaw-agents";
  const openclawNamespace = normalizeText(row.openclaw_namespace) || namespace;
  const hermesNamespace = normalizeText(row.hermes_namespace) || namespace;
  const executionTargetId = `k8s:${id}`;
  const exposureMode = normalizeExposureMode(row.exposure_mode);
  const metadata = getExecutionTargetMetadata("k8s", {
    provider,
    providerLabel: row.provider_label || "",
  });
  const clusterName = normalizeText(row.cluster_name);
  const label = normalizeText(row.label) || clusterName || metadata.label || "Kubernetes";
  const configured =
    row.credential_mode === "encrypted_kubeconfig"
      ? Boolean(row.kubeconfig_encrypted)
      : Boolean(normalizeText(row.kubeconfig_path));
  const testedOk = row.last_test_status === "ok";
  const supportsNetworkPolicy = row.supports_network_policy === true;
  const policyEngine = normalizeText(row.policy_engine);
  const policySettings = normalizePolicySettings(row.policy_settings, buildEmptyPolicySettings(), {
    lenient: true,
  });
  const policySettingsStatus = normalizePolicySettingsStatus(
    row.policy_settings_status,
    {},
    policySettings,
    { lenient: true },
  );
  const policySettingsSummary = buildPolicySettingsSummary(policySettings, policySettingsStatus);
  const issue = !configured
    ? row.credential_mode === "encrypted_kubeconfig"
      ? "Kubernetes cluster requires encrypted kubeconfig content."
      : "Kubernetes cluster requires a mounted kubeconfig path."
    : !testedOk
      ? row.last_test_status === "failed"
        ? row.last_test_message || "Kubernetes cluster connection test failed."
        : "Kubernetes cluster must pass the Admin connection test before deployment."
      : null;

  let kubeconfigContent = null;
  if (includeSecret && row.kubeconfig_encrypted) {
    kubeconfigContent = decrypt(row.kubeconfig_encrypted);
  }

  return {
    id,
    executionTargetId,
    adapter: "k8s",
    deployTarget: "k8s",
    label,
    shortLabel: label,
    provider,
    providerId: provider,
    providerLabel: metadata.providerLabel || metadata.shortLabel || metadata.label,
    clusterName,
    enabled: row.enabled !== false,
    isDefault: row.is_default === true,
    credentialMode: row.credential_mode || "mounted_path",
    kubeconfigPath: normalizeText(row.kubeconfig_path),
    kubeconfigContent,
    kubeContext: normalizeText(row.kube_context),
    namespace,
    openclawNamespace,
    hermesNamespace,
    runtimeNamespaces: {
      openclaw: openclawNamespace,
      hermes: hermesNamespace,
    },
    exposureMode,
    runtimeHost: normalizeText(row.runtime_host),
    runtimeNodePort: parsePort(row.runtime_node_port),
    gatewayNodePort: parsePort(row.gateway_node_port),
    serviceAnnotations: parseJsonObject(row.service_annotations, {}),
    loadBalancerSourceRanges: parseStringArray(row.load_balancer_source_ranges),
    loadBalancerClass: normalizeText(row.load_balancer_class),
    loadBalancerReadyTimeoutMs: parsePositiveInteger(row.load_balancer_ready_timeout_ms, 600000),
    loadBalancerReadyIntervalMs: parsePositiveInteger(row.load_balancer_ready_interval_ms, 5000),
    supportsNetworkPolicy,
    policyEngine: policyEngine || null,
    policySupportStatus: supportsNetworkPolicy ? "supported" : "degraded",
    policyIssue: supportsNetworkPolicy
      ? null
      : "Cluster does not currently advertise Kubernetes NetworkPolicy support. Nora will deploy in degraded mode and skip pod-level policy enforcement.",
    policySettings,
    policySettingsStatus,
    configured,
    connected: testedOk,
    available: row.enabled !== false && configured && testedOk,
    issue,
    summary:
      clusterName && clusterName !== label
        ? `${metadata.summary} Cluster: ${clusterName}.`
        : metadata.summary,
    detail:
      `${clusterName ? `Cluster ${clusterName}` : metadata.detail} · ` +
      `${openclawNamespace === hermesNamespace ? `namespace ${openclawNamespace}` : `OpenClaw ${openclawNamespace}, Hermes ${hermesNamespace}`} · ` +
      exposureMode,
    badges: [
      metadata.providerLabel || metadata.shortLabel || "Kubernetes",
      exposureMode,
      openclawNamespace,
    ].filter(Boolean),
    lastTestStatus: row.last_test_status || null,
    lastTestMessage: row.last_test_message || null,
    lastTestedAt: row.last_tested_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    ...policySettingsSummary,
  };
}

/**
 * Normalize cluster registry input, encrypting kubeconfig content and preserving omitted fields.
 *
 * @param {Object} [input={}] - Requested cluster fields.
 * @param {Object|null} [existing=null] - Existing row for update semantics.
 * @returns {Object} Database-facing cluster configuration.
 */
function normalizeClusterInput(input = {}, existing = null) {
  const label = normalizeText(input.label ?? existing?.label);
  const id = existing
    ? normalizeClusterId(existing.id)
    : normalizeClusterId(input.id || input.clusterId, label);
  const credentialMode = normalizeCredentialMode(
    input.credentialMode ?? input.credential_mode,
    existing?.credential_mode || "mounted_path",
  );
  const kubeconfigContent = normalizeText(input.kubeconfigContent ?? input.kubeconfig_content);
  const clearKubeconfig = normalizeBool(input.clearKubeconfig ?? input.clear_kubeconfig, false);

  if (credentialMode === "encrypted_kubeconfig" && kubeconfigContent) {
    ensureEncryptionConfigured("Kubernetes kubeconfig storage");
  }

  let kubeconfigEncrypted = existing?.kubeconfig_encrypted || null;
  if (clearKubeconfig) kubeconfigEncrypted = null;
  if (credentialMode === "encrypted_kubeconfig" && kubeconfigContent) {
    kubeconfigEncrypted = encrypt(kubeconfigContent);
  }

  const serviceAnnotations = parseJsonObject(
    input.serviceAnnotations ?? input.service_annotations,
    existing?.service_annotations || {},
  );
  const policySettings = normalizePolicySettings(
    input.policySettings ?? input.policy_settings ?? existing?.policy_settings,
    buildEmptyPolicySettings(),
    { lenient: true },
  );
  const policySettingsStatus = normalizePolicySettingsStatus(
    input.policySettingsStatus ??
      input.policy_settings_status ??
      existing?.policy_settings_status ??
      {},
    existing?.policy_settings_status,
    policySettings,
    { lenient: true },
  );

  return {
    id,
    label: label || id,
    provider: normalizeProvider(input.provider ?? existing?.provider),
    clusterName: normalizeText(input.clusterName ?? input.cluster_name ?? existing?.cluster_name),
    enabled: normalizeBool(input.enabled, existing?.enabled ?? true),
    isDefault: normalizeBool(input.isDefault ?? input.is_default, existing?.is_default ?? false),
    credentialMode,
    kubeconfigPath: normalizeText(
      input.kubeconfigPath ?? input.kubeconfig_path ?? existing?.kubeconfig_path,
    ),
    kubeconfigEncrypted,
    kubeContext: normalizeText(input.kubeContext ?? input.kube_context ?? existing?.kube_context),
    namespace:
      normalizeText(input.namespace ?? existing?.namespace) ||
      normalizeText(input.openclawNamespace ?? input.openclaw_namespace) ||
      "openclaw-agents",
    openclawNamespace: normalizeText(
      input.openclawNamespace ?? input.openclaw_namespace ?? existing?.openclaw_namespace,
    ),
    hermesNamespace: normalizeText(
      input.hermesNamespace ?? input.hermes_namespace ?? existing?.hermes_namespace,
    ),
    exposureMode: normalizeExposureMode(
      input.exposureMode ?? input.exposure_mode,
      existing?.exposure_mode,
    ),
    runtimeHost: normalizeText(input.runtimeHost ?? input.runtime_host ?? existing?.runtime_host),
    runtimeNodePort:
      parsePort(input.runtimeNodePort ?? input.runtime_node_port) ??
      existing?.runtime_node_port ??
      null,
    gatewayNodePort:
      parsePort(input.gatewayNodePort ?? input.gateway_node_port) ??
      existing?.gateway_node_port ??
      null,
    serviceAnnotations,
    loadBalancerSourceRanges: parseStringArray(
      input.loadBalancerSourceRanges ??
        input.load_balancer_source_ranges ??
        existing?.load_balancer_source_ranges,
    ),
    loadBalancerClass: normalizeText(
      input.loadBalancerClass ?? input.load_balancer_class ?? existing?.load_balancer_class,
    ),
    loadBalancerReadyTimeoutMs: parsePositiveInteger(
      input.loadBalancerReadyTimeoutMs ??
        input.load_balancer_ready_timeout_ms ??
        existing?.load_balancer_ready_timeout_ms,
      600000,
    ),
    loadBalancerReadyIntervalMs: parsePositiveInteger(
      input.loadBalancerReadyIntervalMs ??
        input.load_balancer_ready_interval_ms ??
        existing?.load_balancer_ready_interval_ms,
      5000,
    ),
    supportsNetworkPolicy: normalizeNullableBool(
      input.supportsNetworkPolicy ??
        input.supports_network_policy ??
        existing?.supports_network_policy,
      null,
    ),
    policyEngine: normalizeText(
      input.policyEngine ?? input.policy_engine ?? existing?.policy_engine,
    ),
    policySettings,
    policySettingsStatus,
  };
}

function clusterConnectionInputChanged(existing, cluster) {
  if (!existing) return false;
  return (
    normalizeText(existing.credential_mode) !== cluster.credentialMode ||
    normalizeText(existing.kubeconfig_path) !== cluster.kubeconfigPath ||
    normalizeText(existing.kubeconfig_encrypted) !== normalizeText(cluster.kubeconfigEncrypted) ||
    normalizeText(existing.kube_context) !== cluster.kubeContext
  );
}

// Registry persistence and policy state

async function listKubernetesClusters(options = {}) {
  const includeDisabled = options.includeDisabled !== false;
  const includeSecret = options.includeSecret === true;
  try {
    const result = await db.query(
      `SELECT *
         FROM kubernetes_clusters
        ${includeDisabled ? "" : "WHERE enabled = true"}
        ORDER BY is_default DESC, label ASC, id ASC`,
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return rows.map((row) =>
      includeSecret ? rowToProfile(row, { includeSecret: true }) : maskCluster(row),
    );
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

async function listKubernetesExecutionTargets() {
  const clusters = await listKubernetesClusters({ includeDisabled: false });
  return clusters.filter((cluster) => cluster.available);
}

async function getClusterRow(clusterId) {
  const id = normalizeClusterId(clusterId);
  const result = await db.query("SELECT * FROM kubernetes_clusters WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function getKubernetesClusterPolicySettings(clusterId) {
  const row = await getClusterRow(clusterId);
  if (!row) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  return maskCluster(row);
}

/**
 * Persist a worker policy status update without letting a stale hash mark newer settings applied.
 *
 * @param {string} clusterId - Cluster whose reconciliation state should be updated.
 * @param {Object} [statusPayload={}] - Worker state, hashes, namespaces, and issue details.
 * @returns {Promise<Object>} Updated masked cluster profile.
 */
async function markKubernetesClusterPolicyStatus(clusterId, statusPayload = {}) {
  const existing = await getClusterRow(clusterId);
  if (!existing) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  const policySettings = normalizePolicySettings(
    existing.policy_settings,
    buildEmptyPolicySettings(),
    {
      lenient: true,
    },
  );
  const currentStatus = normalizePolicySettingsStatus(
    existing.policy_settings_status,
    {},
    policySettings,
    { lenient: true },
  );
  let nextStatus = normalizePolicySettingsStatus(
    { ...currentStatus, ...(statusPayload || {}) },
    currentStatus,
    policySettings,
  );
  const currentDesiredHash = buildPolicySettingsHash(policySettings);
  const staleStatusUpdate =
    POLICY_STATUS_STATES.has(nextStatus.state) &&
    Boolean(nextStatus.desiredHash) &&
    nextStatus.desiredHash !== currentDesiredHash;
  if (staleStatusUpdate) {
    const terminalUpdate = ["applied", "failed"].includes(nextStatus.state);
    const preserveCurrentActiveState =
      ["queued", "applying"].includes(currentStatus.state) &&
      currentStatus.desiredHash === currentDesiredHash;
    nextStatus = normalizePolicySettingsStatus(
      {
        ...(terminalUpdate ? nextStatus : currentStatus),
        state: preserveCurrentActiveState ? currentStatus.state : "queued",
        desiredHash: currentDesiredHash,
        customPolicyIssue: currentStatus.customPolicyIssue || null,
        customPolicyAppliedAt: currentStatus.customPolicyAppliedAt || null,
        updatedAt: new Date().toISOString(),
      },
      currentStatus,
      policySettings,
    );
  }
  const result = await db.query(
    `UPDATE kubernetes_clusters
        SET policy_settings_status = $2::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [existing.id, JSON.stringify(nextStatus)],
  );
  return maskCluster(result.rows[0]);
}

/**
 * Replace custom ingress policy and mark reconciliation queued against its new desired
 * hash. The caller owns queue submission; applied evidence remains until worker update.
 *
 * @param {string} clusterId - Cluster whose desired policy should be replaced.
 * @param {Object} [input={}] - Full policy settings document.
 * @returns {Promise<Object>} Updated masked cluster profile in queued state.
 */
async function updateKubernetesClusterPolicySettings(clusterId, input = {}) {
  const existing = await getClusterRow(clusterId);
  if (!existing) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }

  const policySettings = normalizePolicySettings(
    input.policySettings ?? input.policy_settings ?? input,
    existing.policy_settings,
  );
  const desiredHash = buildPolicySettingsHash(policySettings);
  const currentStatus = normalizePolicySettingsStatus(
    existing.policy_settings_status,
    {},
    policySettings,
    { lenient: true },
  );
  const nextStatus = normalizePolicySettingsStatus(
    {
      state: "queued",
      desiredHash,
      appliedHash: currentStatus.appliedHash,
      lastAppliedNamespaces: currentStatus.lastAppliedNamespaces,
      customPolicyIssue: null,
      updatedAt: new Date().toISOString(),
    },
    currentStatus,
    policySettings,
  );
  const result = await db.query(
    `UPDATE kubernetes_clusters
        SET policy_settings = $2::jsonb,
            policy_settings_status = $3::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [existing.id, JSON.stringify(policySettings), JSON.stringify(nextStatus)],
  );
  return maskCluster(result.rows[0]);
}

/**
 * Register a Kubernetes cluster and encrypt supplied kubeconfig content. Selecting it
 * as default clears other defaults in a separate, non-atomic statement.
 *
 * @param {Object} [input={}] - Cluster registration fields.
 * @returns {Promise<Object>} Persisted masked cluster profile.
 */
async function createKubernetesCluster(input = {}) {
  const cluster = normalizeClusterInput(input);
  const result = await db.query(
    `INSERT INTO kubernetes_clusters(
       id, label, provider, cluster_name, enabled, is_default, credential_mode,
       kubeconfig_path, kubeconfig_encrypted, kube_context, namespace,
       openclaw_namespace, hermes_namespace, exposure_mode, runtime_host,
       runtime_node_port, gateway_node_port, service_annotations,
       load_balancer_source_ranges, load_balancer_class,
       load_balancer_ready_timeout_ms, load_balancer_ready_interval_ms,
       supports_network_policy, policy_engine, policy_settings, policy_settings_status
     ) VALUES(
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18::jsonb,
       $19::text[], $20,
       $21, $22, $23, $24, $25::jsonb, $26::jsonb
     )
     RETURNING *`,
    [
      cluster.id,
      cluster.label,
      cluster.provider,
      cluster.clusterName,
      cluster.enabled,
      cluster.isDefault,
      cluster.credentialMode,
      cluster.kubeconfigPath,
      cluster.kubeconfigEncrypted,
      cluster.kubeContext,
      cluster.namespace,
      cluster.openclawNamespace,
      cluster.hermesNamespace,
      cluster.exposureMode,
      cluster.runtimeHost,
      cluster.runtimeNodePort,
      cluster.gatewayNodePort,
      JSON.stringify(cluster.serviceAnnotations),
      cluster.loadBalancerSourceRanges,
      cluster.loadBalancerClass,
      cluster.loadBalancerReadyTimeoutMs,
      cluster.loadBalancerReadyIntervalMs,
      cluster.supportsNetworkPolicy === true,
      cluster.policyEngine,
      JSON.stringify(cluster.policySettings),
      JSON.stringify(cluster.policySettingsStatus),
    ],
  );
  if (cluster.isDefault) {
    await db.query("UPDATE kubernetes_clusters SET is_default = false WHERE id <> $1", [
      cluster.id,
    ]);
  }
  return maskCluster(result.rows[0]);
}

/**
 * Update a cluster and invalidate its connectivity test when credential inputs change.
 * Selecting it as default clears other defaults in a separate, non-atomic statement.
 *
 * @param {string} clusterId - Cluster to update.
 * @param {Object} [input={}] - Replacement cluster fields.
 * @returns {Promise<Object>} Updated masked cluster profile.
 */
async function updateKubernetesCluster(clusterId, input = {}) {
  const existing = await getClusterRow(clusterId);
  if (!existing) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  const cluster = normalizeClusterInput(input, existing);
  const connectionInputChanged = clusterConnectionInputChanged(existing, cluster);
  const result = await db.query(
    `UPDATE kubernetes_clusters
        SET label = $2,
            provider = $3,
            cluster_name = $4,
            enabled = $5,
            is_default = $6,
            credential_mode = $7,
            kubeconfig_path = $8,
            kubeconfig_encrypted = $9,
            kube_context = $10,
            namespace = $11,
            openclaw_namespace = $12,
            hermes_namespace = $13,
            exposure_mode = $14,
            runtime_host = $15,
            runtime_node_port = $16,
            gateway_node_port = $17,
            service_annotations = $18::jsonb,
            load_balancer_source_ranges = $19::text[],
            load_balancer_class = $20,
            load_balancer_ready_timeout_ms = $21,
            load_balancer_ready_interval_ms = $22,
            supports_network_policy = COALESCE($23, supports_network_policy),
            policy_engine = CASE WHEN $24 = '' THEN policy_engine ELSE $24 END,
            policy_settings = $25::jsonb,
            policy_settings_status = $26::jsonb,
            last_test_status = CASE WHEN $27 THEN NULL ELSE last_test_status END,
            last_test_message = CASE WHEN $27 THEN NULL ELSE last_test_message END,
            last_tested_at = CASE WHEN $27 THEN NULL ELSE last_tested_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      existing.id,
      cluster.label,
      cluster.provider,
      cluster.clusterName,
      cluster.enabled,
      cluster.isDefault,
      cluster.credentialMode,
      cluster.kubeconfigPath,
      cluster.kubeconfigEncrypted,
      cluster.kubeContext,
      cluster.namespace,
      cluster.openclawNamespace,
      cluster.hermesNamespace,
      cluster.exposureMode,
      cluster.runtimeHost,
      cluster.runtimeNodePort,
      cluster.gatewayNodePort,
      JSON.stringify(cluster.serviceAnnotations),
      cluster.loadBalancerSourceRanges,
      cluster.loadBalancerClass,
      cluster.loadBalancerReadyTimeoutMs,
      cluster.loadBalancerReadyIntervalMs,
      cluster.supportsNetworkPolicy,
      cluster.policyEngine,
      JSON.stringify(cluster.policySettings),
      JSON.stringify(cluster.policySettingsStatus),
      connectionInputChanged,
    ],
  );
  if (cluster.isDefault) {
    await db.query("UPDATE kubernetes_clusters SET is_default = false WHERE id <> $1", [
      existing.id,
    ]);
  }
  return maskCluster(result.rows[0]);
}

/**
 * Delete a cluster only when no non-deleted agent still references its execution target.
 *
 * @param {string} clusterId - Cluster to delete.
 * @returns {Promise<Object>} Deleted masked cluster profile.
 */
async function deleteKubernetesCluster(clusterId) {
  const id = normalizeClusterId(clusterId);
  const executionTargetId = `k8s:${id}`;
  const usage = await db.query(
    "SELECT COUNT(*)::int AS count FROM agents WHERE execution_target_id = $1 AND status <> 'deleted'",
    [executionTargetId],
  );
  if ((usage.rows[0]?.count || 0) > 0) {
    const error = new Error("Cannot delete a Kubernetes cluster while agents still reference it");
    error.statusCode = 409;
    throw error;
  }
  const result = await db.query("DELETE FROM kubernetes_clusters WHERE id = $1 RETURNING *", [id]);
  if (!result.rows[0]) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  return maskCluster(result.rows[0]);
}

/**
 * Load a secret-bearing cluster profile for trusted provisioning callers.
 * This lookup does not enforce enabled, configured, or tested availability.
 *
 * @param {string} executionTargetId - Target in `k8s:<id>` form.
 * @returns {Promise<Object|null>} Decrypted provisioning profile or `null`.
 */
async function getKubernetesClusterProfile(executionTargetId) {
  const normalized = normalizeExecutionTargetId(executionTargetId);
  if (!normalized || normalized === "k8s") return null;
  if (!normalized.startsWith("k8s:")) return null;

  const row = await getClusterRow(normalized.slice(4));
  return rowToProfile(row, { includeSecret: true });
}

/**
 * Validate that a Kubernetes deployment selects a registered, enabled, configured, and tested cluster.
 * NetworkPolicy support may remain degraded without blocking deployment.
 *
 * @param {Object} [runtimeFields={}] - Runtime selection containing the cluster execution target.
 * @returns {Promise<Object|null>} Available secret-bearing profile, or `null` for other targets.
 */
async function assertKubernetesExecutionTargetAvailable(runtimeFields = {}) {
  if (normalizeDeployTargetName(runtimeFields.deploy_target) !== "k8s") return null;
  const executionTargetId = normalizeExecutionTargetId(
    runtimeFields.execution_target_id ||
      runtimeFields.executionTargetId ||
      runtimeFields.deploy_target,
  );
  if (!executionTargetId || executionTargetId === "k8s" || !executionTargetId.startsWith("k8s:")) {
    const error = new Error(
      "Kubernetes deployments require an Admin-registered cluster target such as k8s:aks-eastus2.",
    );
    error.statusCode = 400;
    throw error;
  }

  const profile = await getKubernetesClusterProfile(executionTargetId);
  if (!profile) {
    const error = new Error(`Unknown Kubernetes execution target: ${executionTargetId}`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.enabled) {
    const error = new Error(`${profile.label} is disabled for new deployments.`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.configured) {
    const error = new Error(profile.issue || `${profile.label} is not configured.`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.connected) {
    const error = new Error(
      profile.issue || `${profile.label} must pass the Admin connection test before deployment.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return profile;
}

// Connectivity and capability probing

/**
 * Build a Kubernetes client configuration from decrypted content, a mounted path, or in-cluster credentials.
 *
 * @param {Object} profile - Secret-bearing cluster profile.
 * @returns {Object} Configured Kubernetes client context.
 */
function buildKubeConfig(profile) {
  const k8s = getK8sClient();
  const kc = new k8s.KubeConfig();
  try {
    if (profile.kubeconfigContent) {
      kc.loadFromString(profile.kubeconfigContent);
    } else if (profile.kubeconfigPath) {
      kc.loadFromFile(profile.kubeconfigPath);
    } else {
      kc.loadFromCluster();
    }
  } catch (error) {
    const wrapped = new Error(formatKubeconfigLoadError(profile, error));
    wrapped.cause = error;
    throw wrapped;
  }
  if (profile.kubeContext && typeof kc.setCurrentContext === "function") {
    kc.setCurrentContext(profile.kubeContext);
  }
  return kc;
}

function unwrapKubernetesClientResponse(response) {
  if (!response || typeof response !== "object") {
    return response;
  }
  return response.body && typeof response.body === "object" ? response.body : response;
}

/**
 * Best-effort probe NetworkPolicy engine detection and create permission across Nora namespaces.
 *
 * @param {Object} profile - Secret-bearing cluster profile.
 * @returns {Promise<Object>} Capability flag, detected engine, and operator-facing message.
 */
async function probeKubernetesNetworkPolicySupport(profile) {
  const k8s = getK8sClient();
  const kc = buildKubeConfig(profile);
  const result = {
    supportsNetworkPolicy: false,
    policyEngine: "",
    message: "Kubernetes API is reachable, but NetworkPolicy support could not be confirmed.",
  };

  if (!k8s.NetworkingV1Api || !k8s.AuthorizationV1Api) {
    return result;
  }

  try {
    const appsApi = k8s.AppsV1Api ? kc.makeApiClient(k8s.AppsV1Api) : null;
    if (appsApi?.listNamespacedDaemonSet) {
      const daemonSets = await appsApi.listNamespacedDaemonSet({
        namespace: "kube-system",
        limit: 100,
      });
      const daemonSetList = unwrapKubernetesClientResponse(daemonSets);
      result.policyEngine = detectPolicyEngineFromDaemonSets(daemonSetList?.items || []);
    }
  } catch {
    // Best-effort signal only.
  }

  try {
    const authApi = kc.makeApiClient(k8s.AuthorizationV1Api);
    const namespaces = Array.from(
      new Set(
        [
          normalizeText(profile.openclawNamespace),
          normalizeText(profile.hermesNamespace),
          normalizeText(profile.namespace),
        ].filter(Boolean),
      ),
    );
    const reviews = await Promise.all(
      namespaces.map((namespace) =>
        authApi.createSelfSubjectAccessReview({
          body: {
            apiVersion: "authorization.k8s.io/v1",
            kind: "SelfSubjectAccessReview",
            spec: {
              resourceAttributes: {
                namespace,
                group: "networking.k8s.io",
                resource: "networkpolicies",
                verb: "create",
              },
            },
          },
        }),
      ),
    );
    const allowed = reviews.every(
      (review) => unwrapKubernetesClientResponse(review)?.status?.allowed === true,
    );
    result.supportsNetworkPolicy = allowed && Boolean(result.policyEngine);
    result.message = result.supportsNetworkPolicy
      ? `Kubernetes API is reachable and NetworkPolicy support was detected${result.policyEngine ? ` (${result.policyEngine})` : ""}.`
      : allowed
        ? "Kubernetes API is reachable, but NetworkPolicy enforcement could not be confirmed from cluster signals."
        : `Kubernetes API is reachable, but this kubeconfig cannot create NetworkPolicy resources in all required Nora namespaces (${namespaces.join(", ")}).`;
  } catch (error) {
    result.message =
      error?.message || "Kubernetes API is reachable, but NetworkPolicy probing failed.";
  }

  return result;
}

/**
 * Test Kubernetes API connectivity and persist NetworkPolicy capability metadata.
 * Connectivity and capability probe failures are stored and returned rather than thrown.
 *
 * @param {string} clusterId - Cluster to test.
 * @returns {Promise<Object>} Updated masked cluster profile with test results.
 */
async function testKubernetesCluster(clusterId) {
  const profile = await getKubernetesClusterProfile(`k8s:${clusterId}`);
  if (!profile) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  let status = "ok";
  let message = "Kubernetes API is reachable.";
  let supportsNetworkPolicy = normalizeBool(profile.supportsNetworkPolicy, false);
  let policyEngine = normalizeText(profile.policyEngine);
  if (!profile.configured) {
    status = "failed";
    message = profile.issue || "Kubernetes cluster is not configured.";
  } else {
    try {
      const k8s = getK8sClient();
      const kc = buildKubeConfig(profile);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      await coreApi.listNamespace({ limit: 1 });
      const policyProbe = await probeKubernetesNetworkPolicySupport(profile);
      supportsNetworkPolicy = policyProbe.supportsNetworkPolicy;
      policyEngine = policyProbe.policyEngine;
      message = policyProbe.message || message;
    } catch (error) {
      status = "failed";
      message = error?.message || "Kubernetes API test failed.";
    }
  }
  const result = await db.query(
    `UPDATE kubernetes_clusters
        SET last_test_status = $2,
            last_test_message = $3,
            supports_network_policy = $4,
            policy_engine = $5,
            last_tested_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [profile.id, status, message, supportsNetworkPolicy, policyEngine],
  );
  return maskCluster(result.rows[0]);
}

module.exports = {
  assertKubernetesExecutionTargetAvailable,
  buildPolicySettingsHash,
  buildPolicySettingsSummary,
  createKubernetesCluster,
  deleteKubernetesCluster,
  getKubernetesClusterProfile,
  getKubernetesClusterPolicySettings,
  listKubernetesClusters,
  listKubernetesExecutionTargets,
  markKubernetesClusterPolicyStatus,
  normalizeIngressPolicyRules,
  normalizePolicySettings,
  normalizePolicySettingsStatus,
  rowToProfile,
  testKubernetesCluster,
  updateKubernetesCluster,
  updateKubernetesClusterPolicySettings,
};
