import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Loader2,
  Network,
  Power,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import ClusterConfigForm from "../../components/kubernetes/ClusterConfigForm";
import NetworkPolicyTab from "../../components/kubernetes/NetworkPolicyTab";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import {
  buildClusterForm,
  buildClusterPayload,
  ClusterFormState,
  KubernetesCluster,
  policyStateClass,
  statusClass,
} from "../../lib/kubernetes";

type TabKey = "overview" | "config" | "policy";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] bg-slate-50 px-4 py-4">
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Boxes;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition-colors ${
        active
          ? "bg-red-600 text-white shadow-sm"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800"
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

export default function KubernetesClusterDetailPage() {
  const router = useRouter();
  const toast = useToast();
  const { id } = router.query;
  const [cluster, setCluster] = useState<KubernetesCluster | null>(null);
  const [form, setForm] = useState<ClusterFormState>(buildClusterForm(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  const clusterId = useMemo(() => String(id || "").trim(), [id]);

  const loadCluster = useCallback(
    async (options?: { background?: boolean }) => {
      if (!clusterId) return;
      const background = options?.background === true;
      if (!background) {
        setLoading(true);
      }
      try {
        setErrorMessage("");
        const response = await fetchWithAuth(
          `/api/admin/kubernetes-clusters/${encodeURIComponent(clusterId)}/policy-settings`,
        );
        const payload = await response.json().catch(() => ({}));
        if (response.status === 404) {
          setCluster(null);
          return;
        }
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load Kubernetes cluster");
        }
        setCluster(payload);
        if (!background) {
          setForm(buildClusterForm(payload));
        }
      } catch (error) {
        console.error("Failed to load Kubernetes cluster detail:", error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load Kubernetes cluster",
        );
      } finally {
        if (!background) {
          setLoading(false);
        }
      }
    },
    [clusterId],
  );

  useEffect(() => {
    void loadCluster();
  }, [loadCluster]);

  function updateField(field: keyof ClusterFormState, value: string | boolean) {
    setForm((current) => ({ ...current, [field]: value }) as ClusterFormState);
  }

  async function saveCluster(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cluster) return;
    setSaving(true);
    try {
      const response = await fetchWithAuth(
        `/api/admin/kubernetes-clusters/${encodeURIComponent(cluster.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildClusterPayload(form)),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save Kubernetes cluster");
      }
      toast.success("Kubernetes cluster saved");
      setCluster(payload);
      setForm(buildClusterForm(payload));
      await loadCluster();
    } catch (error) {
      console.error("Failed to save Kubernetes cluster:", error);
      toast.error(error instanceof Error ? error.message : "Failed to save Kubernetes cluster");
    } finally {
      setSaving(false);
    }
  }

  async function testCluster() {
    if (!cluster) return;
    setTesting(true);
    try {
      const response = await fetchWithAuth(
        `/api/admin/kubernetes-clusters/${encodeURIComponent(cluster.id)}/test`,
        { method: "POST" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Kubernetes test failed");
      }
      toast.success(payload.lastTestStatus === "ok" ? "Kubernetes API reachable" : "Test recorded");
      await loadCluster();
    } catch (error) {
      console.error("Failed to test Kubernetes cluster:", error);
      toast.error(error instanceof Error ? error.message : "Failed to test Kubernetes cluster");
    } finally {
      setTesting(false);
    }
  }

  async function toggleClusterEnabled() {
    if (!cluster) return;
    setToggling(true);
    try {
      const response = await fetchWithAuth(
        `/api/admin/kubernetes-clusters/${encodeURIComponent(cluster.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildClusterPayload({ ...form, enabled: !form.enabled })),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to update Kubernetes cluster");
      }
      toast.success(!form.enabled ? "Kubernetes cluster enabled" : "Kubernetes cluster disabled");
      setCluster(payload);
      setForm(buildClusterForm(payload));
      await loadCluster();
    } catch (error) {
      console.error("Failed to update Kubernetes cluster:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update Kubernetes cluster");
    } finally {
      setToggling(false);
    }
  }

  async function deleteCluster() {
    if (!cluster) return;
    if (!window.confirm(`Delete ${cluster.label}? This removes the registered cluster target.`)) {
      return;
    }
    setDeleting(true);
    try {
      const response = await fetchWithAuth(
        `/api/admin/kubernetes-clusters/${encodeURIComponent(cluster.id)}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to delete Kubernetes cluster");
      }
      toast.success("Kubernetes cluster deleted");
      await router.push("/kubernetes");
    } catch (error) {
      console.error("Failed to delete Kubernetes cluster:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete Kubernetes cluster");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex h-80 items-center justify-center rounded-[2rem] border border-slate-200 bg-white shadow-sm">
          <Loader2 size={32} className="animate-spin text-red-500" />
        </div>
      </AdminLayout>
    );
  }

  if (!cluster) {
    return (
      <AdminLayout>
        <div className="flex h-80 flex-col items-center justify-center rounded-[2rem] border border-slate-200 bg-white text-center shadow-sm">
          <p className="text-lg font-black text-slate-950">Cluster not found</p>
          <Link
            href="/kubernetes"
            className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-red-600"
          >
            <ArrowLeft size={15} />
            Back to Kubernetes
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const namespaceSummary =
    cluster.openclawNamespace === cluster.hermesNamespace
      ? cluster.openclawNamespace || cluster.namespace || "openclaw-agents"
      : `${cluster.openclawNamespace || cluster.namespace || "openclaw-agents"} / ${cluster.hermesNamespace || cluster.namespace || "hermes-agents"}`;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-5">
          <Link
            href="/kubernetes"
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-800"
          >
            <ArrowLeft size={15} />
            Back to Kubernetes
          </Link>

          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
                Cluster Detail
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                {cluster.label}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                    cluster.lastTestStatus,
                  )}`}
                >
                  {cluster.lastTestStatus || "untested"}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  {cluster.providerLabel || cluster.provider || "kubernetes"}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  {cluster.exposureMode || "cluster-ip"}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${policyStateClass(
                    cluster.customPolicyState ||
                      (cluster.supportsNetworkPolicy ? "applied" : "failed"),
                  )}`}
                >
                  policy {cluster.customPolicyState || cluster.policySupportStatus || "unknown"}
                </span>
                {cluster.isDefault ? (
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">
                    default
                  </span>
                ) : null}
                {!cluster.enabled ? (
                  <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-bold text-slate-600">
                    disabled
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void loadCluster()}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <RefreshCw size={15} />
                Refresh
              </button>
              <button
                type="button"
                onClick={toggleClusterEnabled}
                disabled={toggling}
                className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold disabled:opacity-60 ${
                  cluster.enabled
                    ? "border-slate-200 text-slate-700 hover:bg-slate-50"
                    : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                }`}
              >
                {toggling ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
                {cluster.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={testCluster}
                disabled={testing}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {testing ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={15} />
                )}
                Test
              </button>
              <button
                type="button"
                onClick={deleteCluster}
                disabled={deleting}
                className="inline-flex items-center gap-2 rounded-2xl border border-red-200 px-4 py-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
              >
                {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                Delete
              </button>
            </div>
          </div>
        </header>

        {errorMessage ? (
          <div className="rounded-[1.5rem] border border-red-100 bg-red-50 px-4 py-4 text-sm font-semibold text-red-800">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <TabButton
            active={activeTab === "overview"}
            icon={Boxes}
            label="Overview"
            onClick={() => setActiveTab("overview")}
          />
          <TabButton
            active={activeTab === "config"}
            icon={Settings2}
            label="Cluster Config"
            onClick={() => setActiveTab("config")}
          />
          <TabButton
            active={activeTab === "policy"}
            icon={Network}
            label="Network Policy"
            onClick={() => setActiveTab("policy")}
          />
        </div>

        {activeTab === "overview" ? (
          <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
            <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-black tracking-tight text-slate-950">Cluster overview</h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                Last-known registration, connection, and policy state for this target.
              </p>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <InfoRow
                  label="Provider"
                  value={cluster.providerLabel || cluster.provider || "kubernetes"}
                />
                <InfoRow label="Actual cluster name" value={cluster.clusterName || cluster.id} />
                <InfoRow label="Exposure mode" value={cluster.exposureMode || "cluster-ip"} />
                <InfoRow label="Kube context" value={cluster.kubeContext || "Default context"} />
                <InfoRow label="Namespaces" value={namespaceSummary} />
                <InfoRow
                  label="Runtime host"
                  value={cluster.runtimeHost || "Only required for NodePort targets"}
                />
                <InfoRow
                  label="Last tested"
                  value={cluster.lastTestedAt ? formatDateTime(cluster.lastTestedAt) : "Never"}
                />
              </div>
            </section>

            <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-black tracking-tight text-slate-950">Policy overview</h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                Baseline NetworkPolicy capability plus the latest custom ingress apply state.
              </p>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <InfoRow
                  label="Baseline support"
                  value={cluster.supportsNetworkPolicy ? "supported" : "degraded"}
                />
                <InfoRow label="Policy engine" value={cluster.policyEngine || "Unknown"} />
                <InfoRow
                  label="OpenClaw rules"
                  value={String(cluster.customIngressRuleCounts?.openclaw || 0)}
                />
                <InfoRow
                  label="Hermes rules"
                  value={String(cluster.customIngressRuleCounts?.hermes || 0)}
                />
                <InfoRow
                  label="Last applied"
                  value={
                    cluster.customPolicyAppliedAt
                      ? formatDateTime(cluster.customPolicyAppliedAt)
                      : "Not yet applied"
                  }
                />
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
            </section>
          </div>
        ) : null}

        {activeTab === "config" ? (
          <ClusterConfigForm
            title="Cluster config"
            description="Edit registration, credential, namespace, and exposure settings for this target."
            form={form}
            editing
            cluster={cluster}
            saving={saving}
            testing={testing}
            toggling={toggling}
            onFieldChange={updateField}
            onSubmit={saveCluster}
            onTest={testCluster}
            onToggleEnabled={toggleClusterEnabled}
          />
        ) : null}

        {activeTab === "policy" ? (
          <NetworkPolicyTab
            cluster={cluster}
            onClusterUpdated={(nextCluster) => {
              setCluster(nextCluster);
            }}
            onRefresh={() => loadCluster({ background: true })}
          />
        ) : null}
      </div>
    </AdminLayout>
  );
}
