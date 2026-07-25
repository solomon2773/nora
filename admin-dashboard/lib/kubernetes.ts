export type KubernetesPolicyRule = {
  id?: string;
  cidr: string;
  ports: number[];
  description?: string;
};

export type KubernetesPolicySettings = {
  ingressRules: {
    openclaw: KubernetesPolicyRule[];
    hermes: KubernetesPolicyRule[];
  };
};

export type KubernetesPolicySettingsStatus = {
  state?: string | null;
  desiredHash?: string | null;
  appliedHash?: string | null;
  customPolicyIssue?: string | null;
  customPolicyAppliedAt?: string | null;
  updatedAt?: string | null;
  lastAppliedNamespaces?: Record<string, string[]> | null;
};

export type KubernetesCluster = {
  id: string;
  label: string;
  provider?: string;
  providerLabel?: string;
  clusterName?: string;
  enabled?: boolean;
  isDefault?: boolean;
  credentialMode?: string;
  kubeconfigPath?: string;
  kubeContext?: string;
  namespace?: string;
  openclawNamespace?: string;
  hermesNamespace?: string;
  exposureMode?: string;
  runtimeHost?: string;
  runtimeNodePort?: number | null;
  gatewayNodePort?: number | null;
  serviceAnnotations?: Record<string, string>;
  loadBalancerSourceRanges?: string[];
  loadBalancerClass?: string;
  loadBalancerReadyTimeoutMs?: number;
  loadBalancerReadyIntervalMs?: number;
  supportsNetworkPolicy?: boolean;
  policyEngine?: string | null;
  policySupportStatus?: string | null;
  policyIssue?: string | null;
  policySettings?: KubernetesPolicySettings;
  policySettingsStatus?: KubernetesPolicySettingsStatus;
  customPolicyConfigured?: boolean;
  customIngressConfigured?: boolean;
  customPolicyApplied?: boolean;
  customPolicyIssue?: string | null;
  customPolicyState?: string | null;
  customPolicyDesiredHash?: string | null;
  customPolicyAppliedAt?: string | null;
  customIngressRuleCounts?: {
    openclaw?: number;
    hermes?: number;
  };
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  issue?: string | null;
  lastTestStatus?: string | null;
  lastTestMessage?: string | null;
  lastTestedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ClusterFormState = {
  id: string;
  label: string;
  provider: string;
  clusterName: string;
  enabled: boolean;
  isDefault: boolean;
  credentialMode: string;
  kubeconfigPath: string;
  kubeconfigContent: string;
  kubeContext: string;
  namespace: string;
  openclawNamespace: string;
  hermesNamespace: string;
  exposureMode: string;
  runtimeHost: string;
  runtimeNodePort: string;
  gatewayNodePort: string;
  serviceAnnotationsJson: string;
  loadBalancerSourceRanges: string;
  loadBalancerClass: string;
  loadBalancerReadyTimeoutMs: string;
  loadBalancerReadyIntervalMs: string;
};

export const EMPTY_CLUSTER_FORM: ClusterFormState = {
  id: "",
  label: "",
  provider: "kubernetes",
  clusterName: "",
  enabled: true,
  isDefault: false,
  credentialMode: "mounted_path",
  kubeconfigPath: "",
  kubeconfigContent: "",
  kubeContext: "",
  namespace: "openclaw-agents",
  openclawNamespace: "",
  hermesNamespace: "",
  exposureMode: "cluster-ip",
  runtimeHost: "",
  runtimeNodePort: "",
  gatewayNodePort: "",
  serviceAnnotationsJson: "{}",
  loadBalancerSourceRanges: "",
  loadBalancerClass: "",
  loadBalancerReadyTimeoutMs: "600000",
  loadBalancerReadyIntervalMs: "5000",
};

export const KUBERNETES_INPUT_CLASS =
  "w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-red-300 focus:bg-white focus:ring-4 focus:ring-red-100 disabled:opacity-60";

export const POLICY_PORTS = {
  openclaw: [18789, 9090],
  hermes: [8642, 9119],
} as const;

export function slugifyClusterId(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function updateClusterFormField(
  current: ClusterFormState,
  field: keyof ClusterFormState,
  value: string | boolean,
) {
  const next = { ...current, [field]: value } as ClusterFormState;
  if (field === "label" && !current.id) {
    next.id = slugifyClusterId(String(value));
  }
  if (field === "id") {
    next.id = slugifyClusterId(String(value));
  }
  return next;
}

function parseJsonObject(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Service annotations must be a JSON object.");
  }
  return parsed;
}

export function buildClusterForm(cluster: KubernetesCluster | null = null): ClusterFormState {
  if (!cluster) return { ...EMPTY_CLUSTER_FORM };
  return {
    ...EMPTY_CLUSTER_FORM,
    id: cluster.id || "",
    label: cluster.label || "",
    provider: cluster.provider || "kubernetes",
    clusterName: cluster.clusterName || "",
    enabled: cluster.enabled !== false,
    isDefault: Boolean(cluster.isDefault),
    credentialMode: cluster.credentialMode || "mounted_path",
    kubeconfigPath: cluster.kubeconfigPath || "",
    kubeconfigContent: "",
    kubeContext: cluster.kubeContext || "",
    namespace: cluster.namespace || "openclaw-agents",
    openclawNamespace: cluster.openclawNamespace || "",
    hermesNamespace: cluster.hermesNamespace || "",
    exposureMode: cluster.exposureMode || "cluster-ip",
    runtimeHost: cluster.runtimeHost || "",
    runtimeNodePort: cluster.runtimeNodePort ? String(cluster.runtimeNodePort) : "",
    gatewayNodePort: cluster.gatewayNodePort ? String(cluster.gatewayNodePort) : "",
    serviceAnnotationsJson: JSON.stringify(cluster.serviceAnnotations || {}, null, 2),
    loadBalancerSourceRanges: (cluster.loadBalancerSourceRanges || []).join(", "),
    loadBalancerClass: cluster.loadBalancerClass || "",
    loadBalancerReadyTimeoutMs: String(cluster.loadBalancerReadyTimeoutMs || 600000),
    loadBalancerReadyIntervalMs: String(cluster.loadBalancerReadyIntervalMs || 5000),
  };
}

export function buildClusterPayload(form: ClusterFormState) {
  return {
    id: form.id,
    label: form.label,
    provider: form.provider,
    clusterName: form.clusterName,
    enabled: form.enabled,
    isDefault: form.isDefault,
    credentialMode: form.credentialMode,
    kubeconfigPath: form.credentialMode === "mounted_path" ? form.kubeconfigPath : "",
    kubeconfigContent: form.credentialMode === "encrypted_kubeconfig" ? form.kubeconfigContent : "",
    kubeContext: form.kubeContext,
    namespace: form.namespace,
    openclawNamespace: form.openclawNamespace,
    hermesNamespace: form.hermesNamespace,
    exposureMode: form.exposureMode,
    runtimeHost: form.runtimeHost,
    runtimeNodePort: form.runtimeNodePort,
    gatewayNodePort: form.gatewayNodePort,
    serviceAnnotations: parseJsonObject(form.serviceAnnotationsJson),
    loadBalancerSourceRanges: form.loadBalancerSourceRanges,
    loadBalancerClass: form.loadBalancerClass,
    loadBalancerReadyTimeoutMs: form.loadBalancerReadyTimeoutMs,
    loadBalancerReadyIntervalMs: form.loadBalancerReadyIntervalMs,
  };
}

export function statusClass(status?: string | null) {
  if (status === "ok") return "bg-emerald-100 text-emerald-700";
  if (status === "failed") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-600";
}

export function registryCardClass(cluster: KubernetesCluster, selected: boolean) {
  if (!selected) return "border-slate-200 bg-slate-50 hover:bg-white";
  if (cluster.lastTestStatus === "ok") return "border-emerald-300 bg-emerald-50";
  if (cluster.lastTestStatus === "failed") return "border-red-300 bg-red-50";
  return "border-slate-300 bg-white ring-2 ring-slate-100";
}

export function policyStateClass(state?: string | null) {
  if (state === "applied") return "bg-emerald-100 text-emerald-700";
  if (state === "failed") return "bg-red-100 text-red-700";
  if (state === "applying") return "bg-amber-100 text-amber-700";
  if (state === "queued") return "bg-sky-100 text-sky-700";
  return "bg-slate-100 text-slate-600";
}

export function createEmptyPolicySettings(): KubernetesPolicySettings {
  return {
    ingressRules: {
      openclaw: [],
      hermes: [],
    },
  };
}

export function normalizePolicySettings(
  settings?: Partial<KubernetesPolicySettings> | null,
): KubernetesPolicySettings {
  return {
    ingressRules: {
      openclaw: Array.isArray(settings?.ingressRules?.openclaw)
        ? settings?.ingressRules?.openclaw.map((rule) => ({
            id: rule.id,
            cidr: rule.cidr || "",
            ports: Array.isArray(rule.ports) ? rule.ports.map((port) => Number(port)) : [],
            description: rule.description || "",
          }))
        : [],
      hermes: Array.isArray(settings?.ingressRules?.hermes)
        ? settings?.ingressRules?.hermes.map((rule) => ({
            id: rule.id,
            cidr: rule.cidr || "",
            ports: Array.isArray(rule.ports) ? rule.ports.map((port) => Number(port)) : [],
            description: rule.description || "",
          }))
        : [],
    },
  };
}

export function createLocalRule(runtimeFamily: keyof typeof POLICY_PORTS): KubernetesPolicyRule {
  const randomId =
    typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: randomId,
    cidr: "",
    ports: [...POLICY_PORTS[runtimeFamily]],
    description: "",
  };
}
