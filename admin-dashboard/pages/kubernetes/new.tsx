import Link from "next/link";
import { useRouter } from "next/router";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Boxes, CheckCircle2, Shield } from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import ClusterConfigForm from "../../components/kubernetes/ClusterConfigForm";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import {
  buildClusterPayload,
  ClusterFormState,
  EMPTY_CLUSTER_FORM,
  updateClusterFormField,
} from "../../lib/kubernetes";

export default function NewKubernetesClusterPage() {
  const router = useRouter();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ClusterFormState>(EMPTY_CLUSTER_FORM);

  function updateField(field: keyof ClusterFormState, value: string | boolean) {
    setForm((current) => updateClusterFormField(current, field, value));
  }

  async function saveCluster(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = buildClusterPayload(form);
      const response = await fetchWithAuth("/api/admin/kubernetes-clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saved = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(saved.error || "Failed to save Kubernetes cluster");
      }
      toast.success("Kubernetes cluster created");
      await router.push(`/kubernetes/${encodeURIComponent(saved.id)}`);
    } catch (error) {
      console.error("Failed to save Kubernetes cluster:", error);
      toast.error(error instanceof Error ? error.message : "Failed to save Kubernetes cluster");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminLayout>
      <div className="space-y-8">
        <Link
          href="/kubernetes"
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-800"
        >
          <ArrowLeft size={15} />
          Back to Kubernetes
        </Link>

        <header className="grid gap-6 xl:grid-cols-[1.25fr,0.75fr]">
          <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-lg shadow-red-500/20">
                <Boxes size={26} strokeWidth={2.3} />
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
                  Runtime Placement
                </p>
                <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                  Register Kubernetes Cluster
                </h1>
              </div>
            </div>

            <p className="max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
              Create a dedicated execution target for Nora, then open its detail page to test
              connectivity, adjust exposure settings, and manage ingress policy for OpenClaw or
              Hermes runtimes.
            </p>

            <div className="mt-6 rounded-[1.5rem] border border-red-100 bg-red-50 px-5 py-5">
              <p className="text-xs font-black uppercase tracking-widest text-red-700">
                Fast path to registration
              </p>
              <p className="mt-2 text-sm leading-relaxed text-red-700/80">
                Start by naming the target, pointing Nora at the right kubeconfig or context, and
                choosing the namespaces where runtimes should land. After save, use the cluster
                detail page to run a live connectivity test and confirm NetworkPolicy support.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4 rounded-[2rem] border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center gap-3">
              <Shield size={20} className="text-red-400" />
              <div>
                <p className="text-sm font-bold text-white">What this page creates</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  A Nora-managed execution target, not a new Kubernetes cluster.
                </p>
              </div>
            </div>

            <div className="space-y-3 text-sm text-slate-300">
              <div className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
                <span>Stores the cluster profile Nora will use for future deployments.</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
                <span>
                  Defines fallback, OpenClaw, and Hermes namespaces for runtime placement.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
                <span>
                  Feeds the detail page where testing, enablement, and policy edits happen.
                </span>
              </div>
            </div>
          </div>
        </header>

        <ClusterConfigForm
          title="Cluster Registration"
          description="Register a Kubernetes execution target for Nora control-plane use."
          submitLabel="Register"
          form={form}
          editing={false}
          saving={saving}
          testing={false}
          toggling={false}
          onFieldChange={updateField}
          onSubmit={saveCluster}
          onCancel={() => void router.push("/kubernetes")}
        />
      </div>
    </AdminLayout>
  );
}
