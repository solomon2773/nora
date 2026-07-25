import { useId, type FormEvent, type ReactNode } from "react";
import { KeyRound, Loader2, Save, ServerCog, ShieldCheck } from "lucide-react";
import {
  REMOTE_HOST_INPUT_CLASS,
  type RemoteHost,
  type RemoteHostFormState,
} from "../../lib/remoteHosts";

type Props = {
  form: RemoteHostFormState;
  editing: boolean;
  host?: RemoteHost | null;
  saving: boolean;
  credentialsAllowed: boolean;
  submitLabel: string;
  onFieldChange: (field: keyof RemoteHostFormState, value: string | boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
};

function Field({
  id,
  label,
  hint,
  children,
  wide = false,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label htmlFor={id} className={wide ? "md:col-span-2" : ""}>
      <span className="block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      {hint ? <span className="mt-1 block text-xs font-medium text-slate-500">{hint}</span> : null}
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

export default function RemoteHostConfigForm({
  form,
  editing,
  host,
  saving,
  credentialsAllowed,
  submitLabel,
  onFieldChange,
  onSubmit,
  onCancel,
}: Props) {
  const prefix = useId();

  if (!credentialsAllowed) {
    return (
      <div className="rounded-[2rem] border border-amber-200 bg-amber-50 p-6 text-sm font-semibold text-amber-900">
        Credential configuration is hidden until Nora verifies self-hosted mode.
      </div>
    );
  }

  const secretHint = editing ? "Leave blank to preserve the encrypted value already stored." : "";

  return (
    <form
      onSubmit={onSubmit}
      className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-col gap-4 border-b border-slate-100 bg-brand-ink px-5 py-5 text-brand-foreground sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-cyan/15 text-brand-cyan">
            <ServerCog size={21} />
          </span>
          <div>
            <h2 className="text-lg font-black">Platform host configuration</h2>
            <p className="mt-1 max-w-2xl text-sm font-medium text-brand-foreground/65">
              Nora stores SSH credentials encrypted. Browser forms never receive stored secret
              values.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-2xl border border-brand-cyan/20 px-4 py-2.5 text-sm font-bold text-brand-foreground/80 hover:bg-brand-cyan/10 disabled:opacity-60"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-2xl bg-brand-cyan px-4 py-2.5 text-sm font-black text-brand-ink transition hover:bg-brand-cyan/85 focus:outline-none focus:ring-4 focus:ring-brand-cyan/30 disabled:opacity-60"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {submitLabel}
          </button>
        </div>
      </div>

      <div className="space-y-7 p-5 sm:p-6">
        <section>
          <div className="flex items-center gap-2">
            <ServerCog size={17} className="text-brand-ink" />
            <h3 className="font-black text-slate-950">Identity and endpoint</h3>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field
              id={`${prefix}-id`}
              label="Platform host id"
              hint="2–64 lowercase letters, numbers, or dashes."
            >
              <input
                id={`${prefix}-id`}
                value={form.id}
                onChange={(event) => onFieldChange("id", event.target.value)}
                disabled={editing}
                required
                pattern="[a-z0-9][a-z0-9-]{1,63}"
                className={REMOTE_HOST_INPUT_CLASS}
                placeholder="edge-east-1"
              />
            </Field>
            <Field id={`${prefix}-label`} label="Host label">
              <input
                id={`${prefix}-label`}
                value={form.label}
                onChange={(event) => onFieldChange("label", event.target.value)}
                required
                className={REMOTE_HOST_INPUT_CLASS}
                placeholder="Edge host — East"
              />
            </Field>
            <Field
              id={`${prefix}-ssh-host`}
              label="SSH host"
              hint="Plain hostname or IP address; do not include a scheme or port."
            >
              <input
                id={`${prefix}-ssh-host`}
                value={form.sshHost}
                onChange={(event) => onFieldChange("sshHost", event.target.value)}
                required
                autoComplete="off"
                className={REMOTE_HOST_INPUT_CLASS}
                placeholder="host.example.internal"
              />
            </Field>
            <Field id={`${prefix}-ssh-port`} label="SSH port">
              <input
                id={`${prefix}-ssh-port`}
                value={form.sshPort}
                onChange={(event) => onFieldChange("sshPort", event.target.value)}
                required
                inputMode="numeric"
                min={1}
                max={65535}
                type="number"
                className={REMOTE_HOST_INPUT_CLASS}
              />
            </Field>
            <Field id={`${prefix}-ssh-user`} label="SSH username">
              <input
                id={`${prefix}-ssh-user`}
                value={form.sshUser}
                onChange={(event) => onFieldChange("sshUser", event.target.value)}
                required
                autoComplete="username"
                className={REMOTE_HOST_INPUT_CLASS}
                placeholder="nora"
              />
            </Field>
            <Field
              id={`${prefix}-gateway-host`}
              label="Gateway host"
              hint="Optional address browsers use to reach published runtime ports. Defaults to SSH host."
            >
              <input
                id={`${prefix}-gateway-host`}
                value={form.gatewayHost}
                onChange={(event) => onFieldChange("gatewayHost", event.target.value)}
                autoComplete="off"
                className={REMOTE_HOST_INPUT_CLASS}
                placeholder="gateway.example.internal"
              />
            </Field>
            <Field id={`${prefix}-enabled`} label="Enabled for deployment" wide>
              <span className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <span>
                  <span className="block text-sm font-bold text-slate-900">
                    Surface this tested host as an execution target
                  </span>
                  <span className="mt-0.5 block text-xs font-medium text-slate-500">
                    A host still must pass Test before it becomes available.
                  </span>
                </span>
                <input
                  id={`${prefix}-enabled`}
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => onFieldChange("enabled", event.target.checked)}
                  className="h-5 w-5 rounded border-slate-300 text-brand-ink accent-brand-cyan focus:ring-brand-cyan"
                />
              </span>
            </Field>
          </div>
        </section>

        <section className="border-t border-slate-100 pt-7">
          <div className="flex items-center gap-2">
            <KeyRound size={17} className="text-brand-ink" />
            <h3 className="font-black text-slate-950">Authentication</h3>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field id={`${prefix}-auth-mode`} label="Authentication" wide>
              <select
                id={`${prefix}-auth-mode`}
                value={form.sshAuthMode}
                onChange={(event) =>
                  onFieldChange(
                    "sshAuthMode",
                    event.target.value === "password" ? "password" : "key",
                  )
                }
                className={REMOTE_HOST_INPUT_CLASS}
              >
                <option value="key">SSH private key</option>
                <option value="password">SSH password</option>
              </select>
            </Field>

            {form.sshAuthMode === "key" ? (
              <>
                <Field
                  id={`${prefix}-private-key`}
                  label="SSH private key"
                  hint={`${secretHint}${editing && host?.hasSshPrivateKey ? " A key is stored." : ""}`.trim()}
                  wide
                >
                  <textarea
                    id={`${prefix}-private-key`}
                    value={form.sshPrivateKey}
                    onChange={(event) => onFieldChange("sshPrivateKey", event.target.value)}
                    required={!editing}
                    autoComplete="new-password"
                    spellCheck={false}
                    className={`${REMOTE_HOST_INPUT_CLASS} min-h-44 font-mono text-xs`}
                    placeholder={
                      editing
                        ? "Leave blank to preserve stored key"
                        : "-----BEGIN OPENSSH PRIVATE KEY-----"
                    }
                  />
                </Field>
                <Field
                  id={`${prefix}-passphrase`}
                  label="Key passphrase"
                  hint={`${secretHint}${editing && host?.hasSshPassphrase ? " A passphrase is stored." : " Optional when the key is not encrypted."}`.trim()}
                  wide
                >
                  <input
                    id={`${prefix}-passphrase`}
                    type="password"
                    value={form.sshPassphrase}
                    onChange={(event) => onFieldChange("sshPassphrase", event.target.value)}
                    autoComplete="new-password"
                    className={REMOTE_HOST_INPUT_CLASS}
                    placeholder={editing ? "Leave blank to preserve stored passphrase" : "Optional"}
                  />
                </Field>
              </>
            ) : (
              <Field
                id={`${prefix}-password`}
                label="SSH password"
                hint={`${secretHint}${editing && host?.hasSshPassword ? " A password is stored." : ""}`.trim()}
                wide
              >
                <input
                  id={`${prefix}-password`}
                  type="password"
                  value={form.sshPassword}
                  onChange={(event) => onFieldChange("sshPassword", event.target.value)}
                  required={!editing}
                  autoComplete="new-password"
                  className={REMOTE_HOST_INPUT_CLASS}
                  placeholder={
                    editing ? "Leave blank to preserve stored password" : "Enter SSH password"
                  }
                />
              </Field>
            )}
          </div>
        </section>

        <div className="flex items-start gap-3 rounded-2xl border border-brand-cyan/30 bg-brand-cyan/10 p-4 text-sm font-medium text-brand-ink">
          <ShieldCheck size={18} className="mt-0.5 shrink-0" />
          <p>
            Saving endpoint or credential changes invalidates the previous readiness result. Run
            Test connection again before deployment; credential rotation keeps the existing SSH pin,
            while changing the SSH host or port requires Nora to pin the new endpoint.
          </p>
        </div>
      </div>
    </form>
  );
}
