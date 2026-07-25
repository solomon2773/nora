import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Save, Trash2, TriangleAlert } from "lucide-react";
import { useToast } from "../Toast";
import { fetchWithAuth } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import {
  createEmptyPolicySettings,
  createLocalRule,
  KUBERNETES_INPUT_CLASS,
  KubernetesCluster,
  KubernetesPolicyRule,
  normalizePolicySettings,
  POLICY_PORTS,
} from "../../lib/kubernetes";

type RuntimeFamily = keyof typeof POLICY_PORTS;

type Props = {
  cluster: KubernetesCluster;
  onClusterUpdated: (cluster: KubernetesCluster) => void;
  onRefresh: () => Promise<void>;
};

function SummaryCard({
  label,
  value,
  tone = "slate",
  caption,
}: {
  label: string;
  value: string;
  tone?: "slate" | "emerald" | "amber" | "red" | "sky";
  caption?: string;
}) {
  const tones = {
    slate: "bg-slate-50 text-slate-950",
    emerald: "bg-emerald-50 text-emerald-900",
    amber: "bg-amber-50 text-amber-900",
    red: "bg-red-50 text-red-900",
    sky: "bg-sky-50 text-sky-900",
  };

  return (
    <div className={`rounded-[1.5rem] border border-slate-200 p-4 ${tones[tone]}`}>
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-3 text-lg font-black tracking-tight">{value}</p>
      {caption ? <p className="mt-2 text-sm font-medium text-slate-500">{caption}</p> : null}
    </div>
  );
}

function RuleCard({
  runtimeFamily,
  namespace,
  rule,
  duplicateError,
  onRuntimeChange,
  onChange,
  onTogglePort,
  onRemove,
}: {
  runtimeFamily: RuntimeFamily;
  namespace: string;
  rule: KubernetesPolicyRule;
  duplicateError?: string | null;
  onRuntimeChange: (runtimeFamily: RuntimeFamily) => void;
  onChange: (field: "cidr" | "description", value: string) => void;
  onTogglePort: (port: number) => void;
  onRemove: () => void;
}) {
  const familyLabel = runtimeFamily === "openclaw" ? "OpenClaw" : "Hermes";

  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-black text-slate-950">{familyLabel} ingress rule</p>
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500 ring-1 ring-slate-200">
              {namespace}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-9 w-9 items-center justify-center text-red-700 hover:text-red-800"
          aria-label="Remove rule"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label>
          <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            CIDR
          </span>
          <input
            value={rule.cidr || ""}
            onChange={(event) => onChange("cidr", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="203.0.113.10/32"
          />
          {duplicateError ? (
            <span className="mt-2 block text-xs font-semibold text-red-700">{duplicateError}</span>
          ) : null}
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Description
          </span>
          <input
            value={rule.description || ""}
            onChange={(event) => onChange("description", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="corp vpn"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Runtime
          </span>
          <div className="inline-flex rounded-2xl bg-white p-1 ring-1 ring-slate-200">
            {(["openclaw", "hermes"] as RuntimeFamily[]).map((family) => {
              const selected = family === runtimeFamily;
              return (
                <button
                  key={family}
                  type="button"
                  onClick={() => onRuntimeChange(family)}
                  className={`rounded-[0.9rem] px-3 py-2 text-xs font-black transition-colors ${
                    selected
                      ? "bg-red-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {family === "openclaw" ? "OpenClaw" : "Hermes"}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Allowed ports
          </span>
          <div className="flex flex-wrap gap-2">
            {POLICY_PORTS[runtimeFamily].map((port) => {
              const selected = Array.isArray(rule.ports) && rule.ports.includes(port);
              return (
                <button
                  key={port}
                  type="button"
                  onClick={() => onTogglePort(port)}
                  className={`rounded-full px-3 py-2 text-xs font-black transition-colors ${
                    selected
                      ? "bg-red-600 text-white shadow-sm"
                      : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                  }`}
                >
                  {port}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleSummaryRow({
  runtimeFamily,
  namespace,
  rule,
  onRemove,
}: {
  runtimeFamily: RuntimeFamily;
  namespace: string;
  rule: KubernetesPolicyRule;
  onRemove: () => void;
}) {
  const familyLabel = runtimeFamily === "openclaw" ? "OpenClaw" : "Hermes";
  const cidr = String(rule.cidr || "").trim() || "New rule";
  const description = String(rule.description || "").trim();
  const ports = (
    Array.isArray(rule.ports) && rule.ports.length > 0
      ? rule.ports
      : [...POLICY_PORTS[runtimeFamily]]
  ).join(", ");

  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <span className="mt-0.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-600">
            {familyLabel}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-sm font-black text-slate-950">{cidr}</p>
              {description ? (
                <p className="text-sm font-medium text-slate-500">{description}</p>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-slate-500">
              <span>{namespace}</span>
              <span>Ports {ports}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-9 w-9 items-center justify-center text-red-700 hover:text-red-800"
          aria-label="Delete saved rule"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

export default function NetworkPolicyTab({ cluster, onClusterUpdated, onRefresh }: Props) {
  const toast = useToast();
  const normalizedSettings = useMemo(
    () => normalizePolicySettings(cluster.policySettings || createEmptyPolicySettings()),
    [cluster.policySettings],
  );
  const [draftSettings, setDraftSettings] = useState(normalizedSettings);
  const [saving, setSaving] = useState(false);
  const lastServerSnapshotRef = useRef(JSON.stringify(normalizedSettings));

  useEffect(() => {
    const nextServerSnapshot = JSON.stringify(normalizedSettings);
    setDraftSettings((current) => {
      const currentSnapshot = JSON.stringify(current);
      const previousServerSnapshot = lastServerSnapshotRef.current;
      lastServerSnapshotRef.current = nextServerSnapshot;

      const hasUnsavedLocalChanges =
        currentSnapshot !== previousServerSnapshot && currentSnapshot !== nextServerSnapshot;

      return hasUnsavedLocalChanges ? current : normalizedSettings;
    });
  }, [normalizedSettings]);

  useEffect(() => {
    if (!["queued", "applying"].includes(cluster.customPolicyState || "")) return undefined;
    const handle = window.setInterval(() => {
      void onRefresh();
    }, 5000);
    return () => window.clearInterval(handle);
  }, [cluster.customPolicyState, onRefresh]);

  const isDirty = JSON.stringify(draftSettings) !== JSON.stringify(normalizedSettings);
  const namespaceSummary =
    cluster.openclawNamespace === cluster.hermesNamespace
      ? cluster.openclawNamespace || cluster.namespace || "openclaw-agents"
      : `${cluster.openclawNamespace || cluster.namespace || "openclaw-agents"} / ${cluster.hermesNamespace || cluster.namespace || "hermes-agents"}`;
  const familySections: Array<{
    family: RuntimeFamily;
    label: string;
    namespace: string;
    description: string;
    baselinePorts: number[];
  }> = [
    {
      family: "openclaw",
      label: "OpenClaw ingress",
      namespace: cluster.openclawNamespace || cluster.namespace || "openclaw-agents",
      description: "Rules for gateway and runtime ingress on Nora-managed OpenClaw pods.",
      baselinePorts: [...POLICY_PORTS.openclaw],
    },
    {
      family: "hermes",
      label: "Hermes ingress",
      namespace: cluster.hermesNamespace || cluster.namespace || "hermes-agents",
      description: "Rules for runtime and dashboard ingress on Nora-managed Hermes pods.",
      baselinePorts: [...POLICY_PORTS.hermes],
    },
  ];
  const familyMeta = familySections.reduce(
    (acc, section) => {
      acc[section.family] = section;
      return acc;
    },
    {} as Record<RuntimeFamily, (typeof familySections)[number]>,
  );

  const duplicateRuleErrors = useMemo(() => {
    return familySections.reduce(
      (acc, section) => {
        const seen = new Set<string>();
        const duplicates = new Map<string, string>();
        for (const rule of draftSettings.ingressRules[section.family]) {
          const cidr = String(rule.cidr || "").trim();
          if (!cidr) continue;
          if (seen.has(cidr)) {
            duplicates.set(
              String(rule.id),
              `${cidr} already exists in ${section.label.toLowerCase()}. Edit the existing rule instead.`,
            );
            continue;
          }
          seen.add(cidr);
        }
        acc[section.family] = duplicates;
        return acc;
      },
      {} as Record<RuntimeFamily, Map<string, string>>,
    );
  }, [draftSettings, familySections]);

  const hasDuplicateRules = useMemo(
    () => familySections.some((section) => (duplicateRuleErrors[section.family]?.size || 0) > 0),
    [duplicateRuleErrors, familySections],
  );
  const combinedRules = useMemo(
    () =>
      familySections.flatMap((section) =>
        draftSettings.ingressRules[section.family].map((rule) => ({
          runtimeFamily: section.family,
          namespace: section.namespace,
          rule,
        })),
      ),
    [draftSettings, familySections],
  );
  const persistedRuleIds = useMemo(
    () =>
      new Set(
        familySections.flatMap((section) =>
          normalizedSettings.ingressRules[section.family]
            .map((rule) => String(rule.id || ""))
            .filter(Boolean),
        ),
      ),
    [familySections, normalizedSettings],
  );
  const persistedRules = useMemo(
    () => combinedRules.filter(({ rule }) => persistedRuleIds.has(String(rule.id || ""))),
    [combinedRules, persistedRuleIds],
  );
  const draftOnlyRules = useMemo(
    () => combinedRules.filter(({ rule }) => !persistedRuleIds.has(String(rule.id || ""))),
    [combinedRules, persistedRuleIds],
  );

  function buildSettingsWithoutRule(
    settings: ReturnType<typeof normalizePolicySettings>,
    runtimeFamily: RuntimeFamily,
    ruleId: string | undefined,
  ) {
    return {
      ingressRules: {
        ...settings.ingressRules,
        [runtimeFamily]: settings.ingressRules[runtimeFamily].filter((rule) => rule.id !== ruleId),
      },
    };
  }

  function updateRule(
    runtimeFamily: RuntimeFamily,
    ruleId: string | undefined,
    updater: (rule: KubernetesPolicyRule) => KubernetesPolicyRule,
  ) {
    setDraftSettings((current) => ({
      ingressRules: {
        ...current.ingressRules,
        [runtimeFamily]: current.ingressRules[runtimeFamily].map((rule) =>
          rule.id === ruleId ? updater(rule) : rule,
        ),
      },
    }));
  }

  function addRule(runtimeFamily: RuntimeFamily = "openclaw") {
    const rule = createLocalRule(runtimeFamily);
    setDraftSettings((current) => ({
      ingressRules: {
        ...current.ingressRules,
        [runtimeFamily]: [...current.ingressRules[runtimeFamily], rule],
      },
    }));
  }

  function removeDraftRule(runtimeFamily: RuntimeFamily, ruleId: string | undefined) {
    setDraftSettings((current) => ({
      ingressRules: {
        ...current.ingressRules,
        [runtimeFamily]: current.ingressRules[runtimeFamily].filter((rule) => rule.id !== ruleId),
      },
    }));
  }

  function moveRule(
    sourceRuntimeFamily: RuntimeFamily,
    targetRuntimeFamily: RuntimeFamily,
    ruleId: string | undefined,
  ) {
    if (sourceRuntimeFamily === targetRuntimeFamily) return;
    setDraftSettings((current) => {
      const sourceRules = current.ingressRules[sourceRuntimeFamily];
      const targetRules = current.ingressRules[targetRuntimeFamily];
      const rule = sourceRules.find((entry) => entry.id === ruleId);
      if (!rule) return current;
      return {
        ingressRules: {
          ...current.ingressRules,
          [sourceRuntimeFamily]: sourceRules.filter((entry) => entry.id !== ruleId),
          [targetRuntimeFamily]: [
            ...targetRules,
            {
              ...rule,
              ports: [...POLICY_PORTS[targetRuntimeFamily]],
            },
          ],
        },
      };
    });
  }

  async function persistPolicySettings(
    nextSettings: ReturnType<typeof normalizePolicySettings>,
    successMessage = "Network policy settings saved",
  ) {
    setSaving(true);
    try {
      const response = await fetchWithAuth(
        `/api/admin/kubernetes-clusters/${encodeURIComponent(cluster.id)}/policy-settings`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextSettings),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save network policy settings");
      }
      onClusterUpdated(payload);
      toast.success(successMessage);
    } catch (error) {
      console.error("Failed to save network policy settings:", error);
      toast.error(error instanceof Error ? error.message : "Failed to save network policy");
      throw error;
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings() {
    if (hasDuplicateRules) {
      toast.error("Duplicate CIDR entries are not allowed. Edit the existing rule instead.");
      return;
    }
    await persistPolicySettings(draftSettings);
  }

  async function removePersistedRule(runtimeFamily: RuntimeFamily, ruleId: string | undefined) {
    const previousDraftSettings = draftSettings;
    const nextDraftSettings = buildSettingsWithoutRule(
      previousDraftSettings,
      runtimeFamily,
      ruleId,
    );
    const nextPersistedSettings = buildSettingsWithoutRule(
      normalizedSettings,
      runtimeFamily,
      ruleId,
    );

    setDraftSettings(nextDraftSettings);
    try {
      await persistPolicySettings(nextPersistedSettings, "Rule deleted");
    } catch {
      setDraftSettings(previousDraftSettings);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          <SummaryCard
            label="NetworkPolicy support"
            value={cluster.supportsNetworkPolicy ? "supported" : "degraded"}
            tone={cluster.supportsNetworkPolicy ? "emerald" : "amber"}
            caption={
              cluster.policyEngine ? `Engine: ${cluster.policyEngine}` : "No policy engine detected"
            }
          />
          <SummaryCard
            label="Namespaces"
            value={namespaceSummary}
            caption="OpenClaw and Hermes runtime placement"
          />
          <SummaryCard
            label="Last test"
            value={cluster.lastTestStatus || "untested"}
            caption={cluster.lastTestedAt ? formatDateTime(cluster.lastTestedAt) : "Never tested"}
          />
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-black tracking-tight text-slate-950">
              Custom ingress rules
            </h3>
            <p className="mt-1 text-sm font-medium text-slate-500">
              Add trusted CIDRs and choose which runtime family each rule should apply to.
            </p>
          </div>
        </div>

        {cluster.policyIssue ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm font-semibold text-amber-800">
            {cluster.policyIssue}
          </div>
        ) : null}

        {cluster.customPolicyIssue ? (
          <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm font-semibold text-red-800">
            {cluster.customPolicyIssue}
          </div>
        ) : null}

        {hasDuplicateRules ? (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
            <TriangleAlert size={18} className="mt-0.5 shrink-0" />
            <p className="font-semibold">
              Duplicate CIDR entries are present in the draft. Each runtime family should contain a
              CIDR only once.
            </p>
          </div>
        ) : null}

        <div className="mt-5 rounded-[1.5rem] border border-emerald-200 bg-emerald-50 px-4 py-4">
          <p className="text-sm font-black text-emerald-950">Nora baseline ingress</p>
          <p className="mt-1 text-sm font-medium text-emerald-800">
            Nora tells Kubernetes to allow the required runtime ports. Custom rules add trusted
            CIDRs and do not replace that baseline.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full bg-white px-3 py-2 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200">
              OpenClaw: {POLICY_PORTS.openclaw.join(", ")}
            </span>
            <span className="rounded-full bg-white px-3 py-2 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200">
              Hermes: {POLICY_PORTS.hermes.join(", ")}
            </span>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          {combinedRules.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-sm font-medium text-slate-500">
              No custom ingress rules saved yet.
            </div>
          ) : (
            persistedRules.map(({ runtimeFamily, namespace, rule }) => {
              return (
                <div
                  key={rule.id || `${runtimeFamily}-${rule.cidr}-${rule.ports.join("-")}`}
                  className="space-y-3"
                >
                  <RuleSummaryRow
                    runtimeFamily={runtimeFamily}
                    namespace={namespace}
                    rule={rule}
                    onRemove={() => {
                      void removePersistedRule(runtimeFamily, rule.id);
                    }}
                  />
                </div>
              );
            })
          )}

          {draftOnlyRules.map(({ runtimeFamily, namespace, rule }) => (
            <div
              key={rule.id || `${runtimeFamily}-${rule.cidr}-${rule.ports.join("-")}`}
              className="space-y-3"
            >
              <RuleCard
                runtimeFamily={runtimeFamily}
                namespace={namespace}
                rule={rule}
                duplicateError={duplicateRuleErrors[runtimeFamily]?.get(String(rule.id)) || null}
                onRuntimeChange={(nextRuntimeFamily) =>
                  moveRule(runtimeFamily, nextRuntimeFamily, rule.id)
                }
                onChange={(field, value) =>
                  updateRule(runtimeFamily, rule.id, (current) => ({
                    ...current,
                    [field]: value,
                  }))
                }
                onTogglePort={(port) =>
                  updateRule(runtimeFamily, rule.id, (current) => {
                    const selected = Array.isArray(current.ports) ? current.ports : [];
                    const nextPorts = selected.includes(port)
                      ? selected.filter((entry) => entry !== port)
                      : [...selected, port];
                    return {
                      ...current,
                      ports: nextPorts.sort((left, right) => left - right),
                    };
                  })
                }
                onRemove={() => removeDraftRule(runtimeFamily, rule.id)}
              />
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-[1.5rem] border border-slate-200 bg-slate-50 px-4 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-black text-slate-950">Add rule</p>
              <p className="mt-1 text-sm font-medium text-slate-500">
                New rules open below the saved list and stay editable until you save.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => addRule("openclaw")}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                <Plus size={15} />
                Add rule
              </button>
              <button
                type="button"
                onClick={saveSettings}
                disabled={saving || !isDirty || hasDuplicateRules}
                className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Save rules
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
