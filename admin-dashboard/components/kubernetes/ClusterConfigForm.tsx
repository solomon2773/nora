import type { FormEvent, ReactNode } from "react";
import { Boxes, CheckCircle2, Loader2, Power, Save, TriangleAlert, X } from "lucide-react";
import { ClusterFormState, KUBERNETES_INPUT_CLASS, KubernetesCluster } from "../../lib/kubernetes";

type Props = {
  title: string;
  description: string;
  submitLabel?: string;
  form: ClusterFormState;
  editing: boolean;
  cluster?: KubernetesCluster | null;
  saving: boolean;
  testing: boolean;
  toggling: boolean;
  onFieldChange: (field: keyof ClusterFormState, value: string | boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTest?: () => void;
  onToggleEnabled?: () => void;
  onCancel?: () => void;
};

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "md:col-span-2" : ""}>
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

export default function ClusterConfigForm({
  title,
  description,
  submitLabel = "Save",
  form,
  editing,
  cluster,
  saving,
  testing,
  toggling,
  onFieldChange,
  onSubmit,
  onTest,
  onToggleEnabled,
  onCancel,
}: Props) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="mb-5 flex flex-col gap-3 border-b border-slate-200 pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-100 text-red-700">
            <Boxes size={20} />
          </span>
          <div>
            <h2 className="text-lg font-black text-slate-950">{title}</h2>
            <p className="mt-1 text-sm font-medium text-slate-500">{description}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Execution target id: {form.id ? `k8s:${form.id}` : "k8s:<cluster-id>"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={onToggleEnabled}
                disabled={toggling}
                className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-bold disabled:opacity-60 ${
                  form.enabled
                    ? "border-slate-200 text-slate-700 hover:bg-slate-50"
                    : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                }`}
              >
                {toggling ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
                {form.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={onTest}
                disabled={testing}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {testing ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={15} />
                )}
                Test
              </button>
            </>
          ) : null}
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              <X size={15} />
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 size={15} className="animate-spin" />
            ) : submitLabel === "Register" ? (
              <CheckCircle2 size={15} />
            ) : (
              <Save size={15} />
            )}
            {submitLabel}
          </button>
        </div>
      </div>

      {cluster?.lastTestStatus === "failed" ? (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" />
          <p className="font-semibold">{cluster.lastTestMessage}</p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Cluster id">
          <input
            value={form.id}
            onChange={(event) => onFieldChange("id", event.target.value)}
            disabled={editing}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="aks-eastus2"
          />
        </Field>
        <Field label="Label">
          <input
            value={form.label}
            onChange={(event) => onFieldChange("label", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="AKS East US 2"
          />
        </Field>
        <Field label="Provider">
          <select
            value={form.provider}
            onChange={(event) => onFieldChange("provider", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
          >
            <option value="kubernetes">Generic Kubernetes</option>
            <option value="k3s">K3s</option>
            <option value="aks">AKS</option>
            <option value="gke">GKE</option>
            <option value="eks">EKS</option>
          </select>
        </Field>
        <Field label="Actual cluster name">
          <input
            value={form.clusterName}
            onChange={(event) => onFieldChange("clusterName", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="nora-dns-vjb9kjjz"
          />
        </Field>
        <Field label="Credential mode">
          <select
            value={form.credentialMode}
            onChange={(event) => onFieldChange("credentialMode", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
          >
            <option value="mounted_path">Mounted kubeconfig path</option>
            <option value="encrypted_kubeconfig">Encrypted kubeconfig</option>
          </select>
        </Field>
        <Field label="Kube context">
          <input
            value={form.kubeContext}
            onChange={(event) => onFieldChange("kubeContext", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="optional"
          />
        </Field>

        {form.credentialMode === "mounted_path" ? (
          <Field label="Kubeconfig path" wide>
            <input
              value={form.kubeconfigPath}
              onChange={(event) => onFieldChange("kubeconfigPath", event.target.value)}
              className={KUBERNETES_INPUT_CLASS}
              placeholder="/kubeconfigs/aks-eastus2"
            />
          </Field>
        ) : (
          <Field label="Kubeconfig content" wide>
            <textarea
              value={form.kubeconfigContent}
              onChange={(event) => onFieldChange("kubeconfigContent", event.target.value)}
              className={`${KUBERNETES_INPUT_CLASS} min-h-32 font-mono text-xs`}
              placeholder={
                editing ? "Leave empty to keep the stored kubeconfig" : "Paste kubeconfig YAML"
              }
            />
          </Field>
        )}

        <Field label="Fallback namespace">
          <input
            value={form.namespace}
            onChange={(event) => onFieldChange("namespace", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
          />
        </Field>
        <Field label="OpenClaw namespace">
          <input
            value={form.openclawNamespace}
            onChange={(event) => onFieldChange("openclawNamespace", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder={form.namespace}
          />
        </Field>
        <Field label="Hermes namespace">
          <input
            value={form.hermesNamespace}
            onChange={(event) => onFieldChange("hermesNamespace", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder={form.namespace}
          />
        </Field>
        <Field label="Exposure mode">
          <select
            value={form.exposureMode}
            onChange={(event) => onFieldChange("exposureMode", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
          >
            <option value="cluster-ip">ClusterIP</option>
            <option value="node-port">NodePort</option>
            <option value="load-balancer">LoadBalancer</option>
          </select>
        </Field>
        <Field label="Runtime host">
          <input
            value={form.runtimeHost}
            onChange={(event) => onFieldChange("runtimeHost", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="NodePort host only"
          />
        </Field>
        <Field label="Runtime node port">
          <input
            value={form.runtimeNodePort}
            onChange={(event) => onFieldChange("runtimeNodePort", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            inputMode="numeric"
          />
        </Field>
        <Field label="Gateway node port">
          <input
            value={form.gatewayNodePort}
            onChange={(event) => onFieldChange("gatewayNodePort", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            inputMode="numeric"
          />
        </Field>
        <Field label="Load balancer class">
          <input
            value={form.loadBalancerClass}
            onChange={(event) => onFieldChange("loadBalancerClass", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
          />
        </Field>
        <Field label="Source ranges">
          <input
            value={form.loadBalancerSourceRanges}
            onChange={(event) => onFieldChange("loadBalancerSourceRanges", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            placeholder="203.0.113.10/32, 198.51.100.0/24"
          />
        </Field>
        <Field label="LB timeout ms">
          <input
            value={form.loadBalancerReadyTimeoutMs}
            onChange={(event) => onFieldChange("loadBalancerReadyTimeoutMs", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            inputMode="numeric"
          />
        </Field>
        <Field label="LB interval ms">
          <input
            value={form.loadBalancerReadyIntervalMs}
            onChange={(event) => onFieldChange("loadBalancerReadyIntervalMs", event.target.value)}
            className={KUBERNETES_INPUT_CLASS}
            inputMode="numeric"
          />
        </Field>
        <Field label="Service annotations JSON" wide>
          <textarea
            value={form.serviceAnnotationsJson}
            onChange={(event) => onFieldChange("serviceAnnotationsJson", event.target.value)}
            className={`${KUBERNETES_INPUT_CLASS} min-h-28 font-mono text-xs`}
          />
        </Field>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
        <div className="flex flex-wrap gap-4">
          <label className="inline-flex items-center gap-2 text-sm font-bold text-slate-700">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => onFieldChange("enabled", event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Enabled
          </label>
          <label className="inline-flex items-center gap-2 text-sm font-bold text-slate-700">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) => onFieldChange("isDefault", event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Default target
          </label>
        </div>
      </div>
    </form>
  );
}
