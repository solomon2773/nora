import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { fetchWithAuth } from "../lib/api";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";
import { formatBytes, formatDateTime } from "../lib/format";

type StorageBackend = "local" | "s3" | "r2" | "ssh";
type CapacityState = "ok" | "warning" | "halted";

interface LogStorageSettings {
  storageBackend: StorageBackend;
  storageBackendSource: "database" | "env" | "default";
  localPath: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyConfigured: boolean;
  s3AccessKeyMasked: string;
  s3SecretConfigured: boolean;
  s3SecretMasked: string;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshRemotePath: string;
  sshPrivateKeyConfigured: boolean;
  sshPrivateKeyMasked: string;
  sshPasswordConfigured: boolean;
  sshPasswordMasked: string;
  capacity: {
    usedBytes: number;
    limitBytes: number | null; // null == no configured limit (Infinity doesn't survive JSON)
    state: CapacityState;
  };
}

interface MigrationStatus {
  status: "none" | "running" | "paused" | "completed" | "failed";
  jobId?: string;
  fromBackend?: string;
  toBackend?: string;
  segmentsTotal?: number;
  segmentsMigrated?: number;
  startedAt?: string;
  completedAt?: string;
}

const EMPTY: LogStorageSettings = {
  storageBackend: "local",
  storageBackendSource: "default",
  localPath: "/var/lib/nora-logs",
  s3Bucket: "",
  s3Region: "",
  s3Endpoint: "",
  s3AccessKeyConfigured: false,
  s3AccessKeyMasked: "",
  s3SecretConfigured: false,
  s3SecretMasked: "",
  sshHost: "",
  sshPort: 22,
  sshUsername: "",
  sshRemotePath: "",
  sshPrivateKeyConfigured: false,
  sshPrivateKeyMasked: "",
  sshPasswordConfigured: false,
  sshPasswordMasked: "",
  capacity: { usedBytes: 0, limitBytes: null, state: "ok" },
};

const BACKEND_LABELS: Record<StorageBackend, string> = {
  local: "Local disk",
  s3: "Amazon S3",
  r2: "Cloudflare R2",
  ssh: "SSH / SFTP",
};

const MIGRATION_POLL_INTERVAL_MS = 3000;
const ACTIVE_MIGRATION_STATUSES = new Set(["running", "paused"]);

type FormState = Partial<{
  storageBackend: StorageBackend;
  localPath: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  clearS3AccessKey: boolean;
  clearS3SecretAccessKey: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshRemotePath: string;
  sshPrivateKey: string;
  sshPassword: string;
  clearSshPrivateKey: boolean;
  clearSshPassword: boolean;
  keepSourceCopies: boolean;
}>;

export default function LogStorageSettingsCard() {
  const { t } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState<LogStorageSettings>(EMPTY);
  const [form, setForm] = useState<FormState>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  const [retrying, setRetrying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const loadMigrationStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/admin/log-storage/migration");
      if (!res.ok) return;
      const payload = (await res.json()) as MigrationStatus;
      setMigration(payload);
      return payload;
    } catch {
      // Best-effort polling — a transient failure here shouldn't blow away
      // whatever progress state is already on screen.
      return null;
    }
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/admin/log-storage");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const payload = (await res.json()) as LogStorageSettings;
      setSettings(payload);
      setForm({});
    } catch (err: any) {
      toast.error(err?.message || t("Failed to load log storage settings"));
    } finally {
      setLoading(false);
    }
    // A migration can already be running/paused from before this page ever
    // loaded (e.g. a reload mid-migration) — check once on mount so the
    // progress panel and the disabled-form state are correct immediately,
    // not only after the next save.
    loadMigrationStatus();
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while a migration is actually in flight; stop the moment it
  // reaches a terminal state (or there's none), so this doesn't poll
  // forever on a page left open.
  useEffect(() => {
    const active = migration && ACTIVE_MIGRATION_STATUSES.has(migration.status);
    if (!active) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(loadMigrationStatus, MIGRATION_POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [migration, loadMigrationStatus]);

  const migrationActive = Boolean(migration && ACTIVE_MIGRATION_STATUSES.has(migration.status));

  async function handleRetryMigration() {
    setRetrying(true);
    try {
      const res = await fetchWithAuth("/api/admin/log-storage/migration/retry", { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `Retry failed (${res.status})`);
      }
      toast.success(t("Retrying the migration"));
      setMigration((prev) => ({ ...(prev as MigrationStatus), status: "running" }));
      await loadMigrationStatus();
    } catch (err: any) {
      toast.error(err?.message || t("Retry failed"));
    } finally {
      setRetrying(false);
    }
  }
  const selectedBackend = form.storageBackend ?? settings.storageBackend;

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        storageBackend: selectedBackend,
        keepSourceCopies: Boolean(form.keepSourceCopies),
      };

      if (selectedBackend === "local") {
        body.localPath = form.localPath ?? settings.localPath;
      } else if (selectedBackend === "s3" || selectedBackend === "r2") {
        body.s3Bucket = form.s3Bucket ?? settings.s3Bucket;
        body.s3Region = form.s3Region ?? settings.s3Region;
        body.s3Endpoint = form.s3Endpoint ?? settings.s3Endpoint;
        if (form.clearS3AccessKey) body.clearS3AccessKey = true;
        else if (form.s3AccessKeyId) body.s3AccessKeyId = form.s3AccessKeyId;
        if (form.clearS3SecretAccessKey) body.clearS3SecretAccessKey = true;
        else if (form.s3SecretAccessKey) body.s3SecretAccessKey = form.s3SecretAccessKey;
      } else if (selectedBackend === "ssh") {
        body.sshHost = form.sshHost ?? settings.sshHost;
        body.sshPort = form.sshPort ?? settings.sshPort;
        body.sshUsername = form.sshUsername ?? settings.sshUsername;
        body.sshRemotePath = form.sshRemotePath ?? settings.sshRemotePath;
        if (form.clearSshPrivateKey) body.clearSshPrivateKey = true;
        else if (form.sshPrivateKey) body.sshPrivateKey = form.sshPrivateKey;
        if (form.clearSshPassword) body.clearSshPassword = true;
        else if (form.sshPassword) body.sshPassword = form.sshPassword;
      }

      const res = await fetchWithAuth("/api/admin/log-storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `Save failed (${res.status})`);
      }

      const startedMigration = payload?.migration;

      // PUT's response body is the settings fields plus `migration` — it
      // never includes `capacity` (that's assembled separately in the GET
      // handler from retentionSweeper). Re-fetching via load() rather than
      // setting state from the PUT response directly keeps `capacity`
      // accurate (it can genuinely change once a migration starts) and
      // avoids ever putting the settings object into a state that's
      // missing a field the render below unconditionally reads.
      await load();

      if (startedMigration?.error) {
        toast.error(
          `${t("Destination saved, but the storage migration could not start")}: ${startedMigration.error}`,
        );
      } else if (startedMigration) {
        toast.success(t("Destination saved — migrating existing logs in the background"));
      } else {
        toast.success(t("Log storage settings saved"));
      }
    } catch (err: any) {
      toast.error(err?.message || t("Save failed"));
    } finally {
      setSaving(false);
    }
  }

  const capacityTone =
    settings.capacity.state === "halted"
      ? "border-red-200 bg-red-50 text-red-700"
      : settings.capacity.state === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-emerald-200 bg-emerald-50 text-emerald-700";

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex items-center gap-3 mb-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <Database size={22} />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-black tracking-tight text-slate-950">{t("Log Storage")}</h2>
          <p className="text-xs text-slate-500">
            {t(
              "Platform-wide destination for collected runtime/gateway logs and traces. Changing it migrates existing logs in the background.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-1 text-[11px] font-black uppercase tracking-widest ${capacityTone}`}
        >
          {settings.capacity.state === "ok" ? (
            <CheckCircle2 size={12} />
          ) : (
            <AlertTriangle size={12} />
          )}
          {settings.capacity.state === "halted"
            ? t("Capacity halted")
            : settings.capacity.state === "warning"
              ? t("Nearing capacity")
              : t("Capacity ok")}
        </span>
        <span className="text-xs font-semibold text-slate-500">
          {formatBytes(settings.capacity.usedBytes)}
          {settings.capacity.limitBytes != null ? ` / ${formatBytes(settings.capacity.limitBytes)}` : ` (${t("no limit configured")})`}
        </span>
        {settings.storageBackendSource === "env" ? (
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {t("Set via environment, not yet saved to the database")}
          </span>
        ) : null}
      </div>

      {migration && migration.status !== "none" ? (
        <MigrationProgress
          migration={migration}
          t={t}
          onRetry={handleRetryMigration}
          retrying={retrying}
        />
      ) : null}

      <form onSubmit={handleSave} className="space-y-4">
        <fieldset disabled={migrationActive} className="space-y-4 disabled:opacity-60">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
              {t("Destination")}
            </span>
            <select
              value={selectedBackend}
              onChange={(e) => update("storageBackend", e.target.value as StorageBackend)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-300"
            >
              {(Object.keys(BACKEND_LABELS) as StorageBackend[]).map((key) => (
                <option key={key} value={key}>
                  {BACKEND_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          {selectedBackend === "local" ? (
            <Field
              label={t("Local path")}
              value={form.localPath ?? settings.localPath}
              onChange={(v) => update("localPath", v)}
              placeholder="/var/lib/nora-logs"
            />
          ) : null}

          {selectedBackend === "s3" || selectedBackend === "r2" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label={t("Bucket")}
                value={form.s3Bucket ?? settings.s3Bucket}
                onChange={(v) => update("s3Bucket", v)}
              />
              <Field
                label={t("Region")}
                value={form.s3Region ?? settings.s3Region}
                onChange={(v) => update("s3Region", v)}
                placeholder={selectedBackend === "r2" ? "auto" : "us-east-1"}
              />
              <Field
                label={t("Endpoint (optional)")}
                value={form.s3Endpoint ?? settings.s3Endpoint}
                onChange={(v) => update("s3Endpoint", v)}
                placeholder={selectedBackend === "r2" ? "https://<account>.r2.cloudflarestorage.com" : ""}
              />
              <div />
              <Field
                label={t("Access key ID")}
                value={form.s3AccessKeyId ?? ""}
                onChange={(v) => update("s3AccessKeyId", v)}
                placeholder={settings.s3AccessKeyMasked || t("Leave blank to keep")}
                disabled={Boolean(form.clearS3AccessKey)}
              />
              <Field
                label={t("Secret access key")}
                type="password"
                value={form.s3SecretAccessKey ?? ""}
                onChange={(v) => update("s3SecretAccessKey", v)}
                placeholder={settings.s3SecretMasked || t("Leave blank to keep")}
                autoComplete="new-password"
                disabled={Boolean(form.clearS3SecretAccessKey)}
              />
              {settings.s3AccessKeyConfigured ? (
                <ClearCheckbox
                  label={t("Clear stored access key")}
                  checked={Boolean(form.clearS3AccessKey)}
                  onChange={(v) => update("clearS3AccessKey", v)}
                />
              ) : (
                <div />
              )}
              {settings.s3SecretConfigured ? (
                <ClearCheckbox
                  label={t("Clear stored secret key")}
                  checked={Boolean(form.clearS3SecretAccessKey)}
                  onChange={(v) => update("clearS3SecretAccessKey", v)}
                />
              ) : (
                <div />
              )}
            </div>
          ) : null}

          {selectedBackend === "ssh" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label={t("Host")}
                value={form.sshHost ?? settings.sshHost}
                onChange={(v) => update("sshHost", v)}
              />
              <Field
                label={t("Port")}
                type="number"
                value={String(form.sshPort ?? settings.sshPort)}
                onChange={(v) => update("sshPort", Number(v))}
              />
              <Field
                label={t("Username")}
                value={form.sshUsername ?? settings.sshUsername}
                onChange={(v) => update("sshUsername", v)}
              />
              <Field
                label={t("Remote path")}
                value={form.sshRemotePath ?? settings.sshRemotePath}
                onChange={(v) => update("sshRemotePath", v)}
                placeholder="/var/lib/nora-logs"
              />
              <TextAreaField
                label={t("Private key")}
                value={form.sshPrivateKey ?? ""}
                onChange={(v) => update("sshPrivateKey", v)}
                placeholder={settings.sshPrivateKeyMasked || t("Leave blank to keep")}
                disabled={Boolean(form.clearSshPrivateKey)}
              />
              <Field
                label={t("Password (if not using a key)")}
                type="password"
                value={form.sshPassword ?? ""}
                onChange={(v) => update("sshPassword", v)}
                placeholder={settings.sshPasswordMasked || t("Leave blank to keep")}
                autoComplete="new-password"
                disabled={Boolean(form.clearSshPassword)}
              />
              {settings.sshPrivateKeyConfigured ? (
                <ClearCheckbox
                  label={t("Clear stored private key")}
                  checked={Boolean(form.clearSshPrivateKey)}
                  onChange={(v) => update("clearSshPrivateKey", v)}
                />
              ) : (
                <div />
              )}
              {settings.sshPasswordConfigured ? (
                <ClearCheckbox
                  label={t("Clear stored password")}
                  checked={Boolean(form.clearSshPassword)}
                  onChange={(v) => update("clearSshPassword", v)}
                />
              ) : (
                <div />
              )}
            </div>
          ) : null}

          {selectedBackend !== settings.storageBackend ? (
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={Boolean(form.keepSourceCopies)}
                onChange={(e) => update("keepSourceCopies", e.target.checked)}
              />
              <span>
                {t("Keep copies on the current destination")} ({BACKEND_LABELS[settings.storageBackend]})
                {" — "}
                <span className="text-slate-500">
                  {t(
                    "otherwise each segment is deleted from the old destination once it's confirmed migrated",
                  )}
                </span>
              </span>
            </label>
          ) : null}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving || migrationActive}
            className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {t("Save log storage settings")}
          </button>
          {migrationActive ? (
            <span className="text-xs font-semibold text-slate-500">
              {t("Destination changes are disabled until the current migration finishes")}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function MigrationProgress({
  migration,
  t,
  onRetry,
  retrying,
}: {
  migration: MigrationStatus;
  t: (s: string) => string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const total = migration.segmentsTotal ?? 0;
  const migrated = migration.segmentsMigrated ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((migrated / total) * 100)) : migration.status === "completed" ? 100 : 0;

  const tone =
    migration.status === "failed"
      ? "border-red-200 bg-red-50"
      : migration.status === "completed"
        ? "border-emerald-200 bg-emerald-50"
        : "border-blue-200 bg-blue-50";

  const statusLabel =
    migration.status === "running"
      ? t("Migrating")
      : migration.status === "paused"
        ? t("Paused")
        : migration.status === "completed"
          ? t("Completed")
          : t("Failed");

  return (
    <div className={`mb-4 rounded-2xl border px-4 py-3 ${tone}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
          {migration.status === "running" ? <Loader2 size={14} className="animate-spin" /> : null}
          {t("Storage migration")}: {statusLabel}
          {migration.fromBackend && migration.toBackend ? (
            <span className="font-normal text-slate-500">
              ({migration.fromBackend} → {migration.toBackend})
            </span>
          ) : null}
        </div>
        <span className="text-xs font-semibold text-slate-500">
          {migrated.toLocaleString()} / {total.toLocaleString()} {t("segments")}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/70">
        <div
          className={`h-full rounded-full transition-all ${
            migration.status === "failed" ? "bg-red-500" : migration.status === "paused" ? "bg-amber-500" : "bg-blue-600"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {migration.status === "paused" ? (
        <p className="mt-2 text-xs text-amber-700">
          {t(
            "Paused — most likely waiting for local storage capacity to free up. Resumes automatically once it does.",
          )}
        </p>
      ) : null}
      {migration.status === "failed" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-red-700">
            {t(
              "Fixing the destination's credentials and saving again won't retry this on its own — the destination is already set to this backend, so nothing looks changed. Retry the failed job directly:",
            )}
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t("Retry migration")}
          </button>
        </div>
      ) : null}
      {migration.startedAt ? (
        <p className="mt-2 text-[11px] text-slate-400">
          {t("Started")} {formatDateTime(migration.startedAt)}
          {migration.completedAt ? ` · ${t("finished")} ${formatDateTime(migration.completedAt)}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 sm:col-span-2">
      <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={4}
        className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-mono text-xs text-slate-900 outline-none focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
      />
    </label>
  );
}

function ClearCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 self-end pb-2 text-xs font-semibold text-slate-500">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
