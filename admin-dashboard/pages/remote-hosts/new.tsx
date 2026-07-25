import Link from "next/link";
import { useRouter } from "next/router";
import { useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Server, ShieldCheck } from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import RemoteHostConfigForm from "../../components/remote-hosts/RemoteHostConfigForm";
import RemoteHostsAvailability from "../../components/remote-hosts/RemoteHostsAvailability";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import { useVerifiedPlatformMode } from "../../lib/platform";
import {
  buildRemoteHostPayload,
  EMPTY_REMOTE_HOST_FORM,
  errorMessage,
  responseError,
  updateRemoteHostFormField,
  type RemoteHost,
  type RemoteHostFormState,
} from "../../lib/remoteHosts";

export default function NewRemoteHostPage() {
  const router = useRouter();
  const toast = useToast();
  const platformMode = useVerifiedPlatformMode();
  const [form, setForm] = useState<RemoteHostFormState>({ ...EMPTY_REMOTE_HOST_FORM });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");

  function updateField(field: keyof RemoteHostFormState, value: string | boolean) {
    setForm((current) => updateRemoteHostFormField(current, field, value));
  }

  async function createHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (platformMode !== "selfhosted") return;
    setSaving(true);
    setActionError("");
    try {
      const response = await fetchWithAuth("/api/admin/remote-hosts", {
        method: "POST",
        body: JSON.stringify(buildRemoteHostPayload(form)),
      });
      if (!response.ok) {
        const failure = await responseError(response, "Failed to create platform host");
        throw new Error(failure.message);
      }
      const host = (await response.json().catch(() => ({}))) as Partial<RemoteHost>;
      toast.success("Platform host created. Run Test connection before deployment.");
      await router.push(`/remote-hosts/${encodeURIComponent(host.id || form.id)}`);
    } catch (error) {
      const message = errorMessage(error, "Failed to create platform host");
      setActionError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  if (platformMode !== "selfhosted") {
    return (
      <AdminLayout>
        <RemoteHostsAvailability mode={platformMode} />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <Link
          href="/remote-hosts"
          className="inline-flex items-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-800 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20"
        >
          <ArrowLeft size={15} />
          Back to Remote Hosts
        </Link>

        <header className="grid gap-5 lg:grid-cols-[1.05fr,0.95fr]">
          <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-cyan/20 text-brand-ink">
              <Server size={23} />
            </span>
            <p className="mt-5 text-[11px] font-black uppercase tracking-[0.2em] text-brand-ink/55">
              Platform registry
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Add platform host
            </h1>
            <p className="mt-3 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Register a Linux Docker server, VPS, or cloud VM for platform-level Remote Docker
              placement. Access can be granted after registration.
            </p>
          </div>

          <div className="rounded-[2rem] border border-brand-cyan/15 bg-brand-ink p-6 text-brand-foreground shadow-sm">
            <div className="flex items-center gap-3">
              <ShieldCheck size={20} className="text-brand-cyan" />
              <h2 className="font-black">Registration safety</h2>
            </div>
            <div className="mt-5 space-y-3 text-sm font-medium text-brand-foreground/70">
              <p className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-brand-cyan" />
                Credentials are accepted only after verified self-hosted mode.
              </p>
              <p className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-brand-cyan" />
                The first successful test pins the SSH host key.
              </p>
              <p className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-brand-cyan" />
                New hosts are not deployable until testing succeeds.
              </p>
            </div>
          </div>
        </header>

        {actionError ? (
          <div
            role="alert"
            className="rounded-[1.5rem] border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800"
          >
            {actionError}
          </div>
        ) : null}

        <RemoteHostConfigForm
          form={form}
          editing={false}
          saving={saving}
          credentialsAllowed
          submitLabel="Create platform host"
          onFieldChange={updateField}
          onSubmit={createHost}
          onCancel={() => void router.push("/remote-hosts")}
        />
      </div>
    </AdminLayout>
  );
}
