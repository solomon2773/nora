import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Rocket,
  Save,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDateTime } from "../lib/format";

const DEFAULT_FORM = {
  vcpu: "1",
  ram_mb: "1024",
  disk_gb: "10",
};
const DEFAULT_BANNER_FORM = {
  enabled: false,
  severity: "warning",
  title: "",
  message: "",
};

function buildForm(defaults) {
  return {
    vcpu: String(defaults?.vcpu ?? DEFAULT_FORM.vcpu),
    ram_mb: String(defaults?.ram_mb ?? DEFAULT_FORM.ram_mb),
    disk_gb: String(defaults?.disk_gb ?? DEFAULT_FORM.disk_gb),
  };
}

function buildBannerForm(banner) {
  return {
    enabled: Boolean(banner?.enabled),
    severity: banner?.severity === "critical" ? "critical" : "warning",
    title: banner?.title || "",
    message: banner?.message || "",
  };
}

function formatRamLabel(ramMb) {
  const numeric = Number(ramMb) || 0;
  if (numeric < 1024) return `${numeric} MB RAM`;

  const ramGb = numeric / 1024;
  return `${Number.isInteger(ramGb) ? ramGb : ramGb.toFixed(1)} GB RAM`;
}

function formatVersionLabel(version) {
  const normalized = String(version || "").trim();
  if (!normalized) return "Unversioned build";
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function formatInstallMethod(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "source") return "Source checkout";
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCommitLabel(commit) {
  const normalized = String(commit || "").trim();
  return normalized ? normalized.slice(0, 8) : "Not reported";
}

function getReleaseStatus(release) {
  if (release?.upgradeRequired) {
    return {
      label: "Upgrade required",
      chipClassName: "bg-red-100 text-red-700",
      panelClassName: "border-red-200 bg-red-50",
      titleClassName: "text-red-700",
      bodyClassName: "text-red-700/80",
    };
  }

  if (release?.updateAvailable) {
    return {
      label: "Update available",
      chipClassName: "bg-amber-100 text-amber-800",
      panelClassName: "border-amber-200 bg-amber-50",
      titleClassName: "text-amber-800",
      bodyClassName: "text-amber-800/80",
    };
  }

  if (release?.trackingConfigured) {
    return {
      label: "Current",
      chipClassName: "bg-emerald-100 text-emerald-700",
      panelClassName: "border-emerald-200 bg-emerald-50",
      titleClassName: "text-emerald-700",
      bodyClassName: "text-emerald-700/80",
    };
  }

  return {
    label: "Tracking incomplete",
    chipClassName: "bg-slate-100 text-slate-700",
    panelClassName: "border-slate-200 bg-slate-50",
    titleClassName: "text-slate-700",
    bodyClassName: "text-slate-600",
  };
}

function getBannerTone(severity) {
  if (severity === "critical") {
    return {
      panelClassName: "border-red-200 bg-red-50",
      titleClassName: "text-red-700",
      bodyClassName: "text-red-700/80",
      badgeClassName: "bg-red-100 text-red-700",
    };
  }

  return {
    panelClassName: "border-amber-200 bg-amber-50",
    titleClassName: "text-amber-800",
    bodyClassName: "text-amber-800/80",
    badgeClassName: "bg-amber-100 text-amber-800",
  };
}

export default function AdminSettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState(DEFAULT_FORM);
  const [defaults, setDefaults] = useState(null);
  const [systemBanner, setSystemBanner] = useState(null);
  const [bannerForm, setBannerForm] = useState(DEFAULT_BANNER_FORM);
  const [platformConfig, setPlatformConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bannerSaving, setBannerSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [defaultsRes, platformRes, bannerRes] = await Promise.all([
        fetchWithAuth("/api/admin/settings/deployment-defaults"),
        fetch("/api/config/platform"),
        fetchWithAuth("/api/admin/settings/system-banner"),
      ]);

      const defaultsPayload = await defaultsRes.json().catch(() => ({}));
      if (!defaultsRes.ok) {
        throw new Error(
          defaultsPayload.error || "Failed to load deployment defaults"
        );
      }

      setDefaults(defaultsPayload);
      setForm(buildForm(defaultsPayload));

      const bannerPayload = await bannerRes.json().catch(() => ({}));
      if (!bannerRes.ok) {
        throw new Error(bannerPayload.error || "Failed to load system banner");
      }

      setSystemBanner(bannerPayload);
      setBannerForm(buildBannerForm(bannerPayload));

      if (platformRes.ok) {
        setPlatformConfig(await platformRes.json());
      }
    } catch (error) {
      console.error("Failed to load platform settings:", error);
      toast.error(error.message || "Failed to load platform settings");
      setDefaults(null);
      setSystemBanner(null);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateBannerField(field, value) {
    setBannerForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const response = await fetchWithAuth(
        "/api/admin/settings/deployment-defaults",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vcpu: form.vcpu,
            ram_mb: form.ram_mb,
            disk_gb: form.disk_gb,
          }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save deployment defaults");
      }

      setDefaults(payload);
      setForm(buildForm(payload));
      toast.success("Deployment defaults updated");
    } catch (error) {
      console.error("Failed to save admin deployment defaults:", error);
      toast.error(error.message || "Failed to save deployment defaults");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveBanner() {
    setBannerSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/settings/system-banner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: bannerForm.enabled,
          severity: bannerForm.severity,
          title: bannerForm.title,
          message: bannerForm.message,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save system banner");
      }

      setSystemBanner(payload);
      setBannerForm(buildBannerForm(payload));
      toast.success("System banner updated");
    } catch (error) {
      console.error("Failed to save system banner:", error);
      toast.error(error.message || "Failed to save system banner");
    } finally {
      setBannerSaving(false);
    }
  }

  const modeLabel =
    platformConfig?.mode === "paas" ? "PaaS plan defaults" : "Self-hosted deploy defaults";
  const release = platformConfig?.release || null;
  const releaseStatus = getReleaseStatus(release);
  const bannerFeatureEnabled = Boolean(systemBanner?.featureEnabled);
  const bannerPreviewTone = getBannerTone(bannerForm.severity);
  const persistedBannerTone = getBannerTone(systemBanner?.severity);
  const bannerPreviewVisible = Boolean(
    bannerForm.title.trim() || bannerForm.message.trim()
  );

  async function handleCopyUpgradeCommand() {
    const command = release?.manualUpgrade?.command;
    if (!command) {
      toast.error("Upgrade command is not configured");
      return;
    }

    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }

      await navigator.clipboard.writeText(command);
      toast.success("Upgrade command copied");
    } catch (error) {
      console.error("Failed to copy upgrade command:", error);
      toast.error("Failed to copy upgrade command");
    }
  }

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Platform Settings
            </p>
            <h1 className="mt-2 flex items-center gap-3 text-3xl font-black tracking-tight text-slate-950">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-600">
                <SlidersHorizontal size={24} />
              </span>
              Platform Settings
            </h1>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
              Configure the platform release path, the global testing warning
              banner, and the default CPU, RAM, and disk used for future
              deployments.
            </p>
          </div>

          <button
            onClick={loadSettings}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        {loading && !defaults ? (
          <div className="flex h-72 items-center justify-center rounded-[2rem] border border-slate-200 bg-white shadow-sm">
            <Loader2 size={32} className="animate-spin text-red-500" />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <section
              id="platform-upgrades"
              className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Platform Release
                  </p>
                  <h2 className="mt-2 flex items-center gap-3 text-xl font-black tracking-tight text-slate-950">
                    <span
                      className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
                        release?.updateAvailable
                          ? release?.upgradeRequired
                            ? "bg-red-50 text-red-600"
                            : "bg-amber-50 text-amber-600"
                          : "bg-emerald-50 text-emerald-600"
                      }`}
                    >
                      {release?.updateAvailable ? (
                        <TriangleAlert size={20} />
                      ) : (
                        <Rocket size={20} />
                      )}
                    </span>
                    Upgrade status and manual path
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                    Track the running Nora build, review the latest announced
                    release, and copy the current host-side upgrade command.
                    Auto-upgrade is intentionally not enabled yet.
                  </p>
                </div>

                <div
                  className={`inline-flex items-center gap-2 self-start rounded-full px-4 py-2 text-xs font-black uppercase tracking-[0.16em] ${releaseStatus.chipClassName}`}
                >
                  {release?.updateAvailable ? (
                    <TriangleAlert size={14} />
                  ) : (
                    <CheckCircle2 size={14} />
                  )}
                  {releaseStatus.label}
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-[1.5rem] bg-slate-50 px-5 py-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Current build
                  </p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {formatVersionLabel(release?.currentVersion)}
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    {release?.trackingConfigured
                      ? `Commit ${formatCommitLabel(release?.currentCommit)}`
                      : "Current version tracking is not configured yet."}
                  </p>
                </div>

                <div className="rounded-[1.5rem] bg-slate-50 px-5 py-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Latest announced
                  </p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {release?.latestVersion
                      ? formatVersionLabel(release.latestVersion)
                      : "Not configured"}
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    {release?.publishedAt
                      ? `Published ${formatDateTime(release.publishedAt)}`
                      : "No published release metadata yet."}
                  </p>
                </div>

                <div className="rounded-[1.5rem] bg-slate-50 px-5 py-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Upgrade path
                  </p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {release?.canAutoUpgrade ? "Automatic" : "Manual"}
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    {formatInstallMethod(release?.installMethod)}{" "}
                    {release?.canAutoUpgrade ? "with auto-upgrade" : "with host command"}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
                <section className="rounded-[1.5rem] bg-slate-950 px-5 py-5 text-slate-100">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                        Host Command
                      </p>
                      <p className="mt-2 text-sm font-medium text-slate-300">
                        Run this from the Nora repo root on the host machine.
                      </p>
                    </div>

                    <button
                      onClick={handleCopyUpgradeCommand}
                      className="inline-flex items-center gap-2 self-start rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-white/10"
                    >
                      <Copy size={15} />
                      Copy command
                    </button>
                  </div>

                  <pre className="mt-4 overflow-x-auto rounded-2xl border border-white/10 bg-black/30 p-4 text-sm font-semibold leading-relaxed text-slate-100">
                    <code>
                      {release?.manualUpgrade?.command ||
                        "Upgrade command not configured"}
                    </code>
                  </pre>
                </section>

                <section className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    What To Expect
                  </p>
                  <div className="mt-4 space-y-3">
                    {(release?.manualUpgrade?.steps || []).map((step, index) => (
                      <div
                        key={`${index}-${step}`}
                        className="flex items-start gap-3 rounded-[1.25rem] bg-white px-4 py-4"
                      >
                        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-black text-white">
                          {index + 1}
                        </span>
                        <p className="text-sm font-medium leading-relaxed text-slate-600">
                          {step}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div
                    className={`mt-5 rounded-[1.25rem] border px-4 py-4 ${releaseStatus.panelClassName}`}
                  >
                    <p className={`text-sm font-semibold ${releaseStatus.titleClassName}`}>
                      Auto-upgrade is not enabled yet.
                    </p>
                    <p
                      className={`mt-1 text-sm font-medium leading-relaxed ${releaseStatus.bodyClassName}`}
                    >
                      Use the host command above until a dedicated updater
                      service exists for this install path.
                    </p>
                  </div>

                  {release?.releaseNotesUrl ? (
                    <a
                      href={release.releaseNotesUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-red-600 transition-colors hover:text-red-700"
                    >
                      Open release notes
                      <ArrowUpRight size={15} />
                    </a>
                  ) : (
                    <p className="mt-5 text-sm font-medium text-slate-500">
                      Release notes URL not configured for this instance yet.
                    </p>
                  )}
                </section>
              </div>
            </section>

            <section
              id="system-banner"
              className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    System Banner
                  </p>
                  <h2 className="mt-2 flex items-center gap-3 text-xl font-black tracking-tight text-slate-950">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
                      <TriangleAlert size={20} />
                    </span>
                    Testing warning across all dashboards
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                    Publish one top-of-page warning across the operator and admin
                    surfaces. Use it for staging-only notices, maintenance
                    warnings, or other global operator guidance.
                  </p>
                </div>

                <div
                  className={`inline-flex items-center gap-2 self-start rounded-full px-4 py-2 text-xs font-black uppercase tracking-[0.16em] ${
                    bannerFeatureEnabled
                      ? systemBanner?.enabled
                        ? persistedBannerTone.badgeClassName
                        : "bg-slate-100 text-slate-700"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  <TriangleAlert size={14} />
                  {!bannerFeatureEnabled
                    ? "Env Flag Off"
                    : systemBanner?.enabled
                      ? "Configured"
                      : "Saved As Off"}
                </div>
              </div>

              {!bannerFeatureEnabled ? (
                <div className="mt-6 rounded-[1.5rem] border border-amber-200 bg-amber-50 px-5 py-4">
                  <p className="text-sm font-semibold text-amber-800">
                    Banner rendering is disabled by instance config.
                  </p>
                  <p className="mt-1 text-sm font-medium leading-relaxed text-amber-800/80">
                    Set <code>NORA_SYSTEM_BANNER_ENABLED=true</code> in{" "}
                    <code>.env</code> and restart Nora. You can still save the
                    draft below before you flip the flag.
                  </p>
                </div>
              ) : null}

              <div className="mt-6 grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
                <section className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5">
                  <label className="flex items-start gap-3 rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <input
                      type="checkbox"
                      checked={bannerForm.enabled}
                      onChange={(event) =>
                        updateBannerField("enabled", event.target.checked)
                      }
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">
                        Show banner on every dashboard page
                      </span>
                      <span className="mt-1 block text-sm font-medium leading-relaxed text-slate-500">
                        When enabled, this banner appears across <code>/app</code>{" "}
                        and <code>/admin</code>. Operators cannot dismiss it per
                        session.
                      </span>
                    </span>
                  </label>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <label className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                      <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Severity
                      </span>
                      <select
                        value={bannerForm.severity}
                        onChange={(event) =>
                          updateBannerField("severity", event.target.value)
                        }
                        className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-red-300"
                      >
                        <option value="warning">Warning</option>
                        <option value="critical">Critical</option>
                      </select>
                    </label>

                    <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Current rollout
                      </p>
                      <p className="mt-3 text-sm font-semibold text-slate-900">
                        {!bannerFeatureEnabled
                          ? "Saved draft only"
                          : systemBanner?.active
                            ? "Live on all dashboard pages"
                            : systemBanner?.enabled
                              ? "Configured but missing content"
                              : "Hidden until enabled"}
                      </p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
                        Save changes here to update the shared banner payload used
                        by both dashboards.
                      </p>
                    </div>
                  </div>

                  <label className="mt-4 block rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Title
                    </span>
                    <input
                      type="text"
                      maxLength={120}
                      value={bannerForm.title}
                      onChange={(event) =>
                        updateBannerField("title", event.target.value)
                      }
                      placeholder="Testing warning"
                      className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-red-300"
                    />
                  </label>

                  <label className="mt-4 block rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Message
                    </span>
                    <textarea
                      rows={4}
                      maxLength={600}
                      value={bannerForm.message}
                      onChange={(event) =>
                        updateBannerField("message", event.target.value)
                      }
                      placeholder="This Nora control plane is a staging environment. Expect resets and avoid production workloads."
                      className="mt-3 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-medium leading-relaxed text-slate-900 outline-none focus:border-red-300"
                    />
                  </label>

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <button
                      onClick={handleSaveBanner}
                      disabled={bannerSaving || loading}
                      className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-all hover:-translate-y-0.5 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {bannerSaving ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Save size={16} />
                      )}
                      Save banner
                    </button>
                    <p className="text-xs font-medium text-slate-500">
                      Best for maintenance notices, staging disclaimers, and
                      other system-wide operator warnings.
                    </p>
                  </div>
                </section>

                <aside className="flex flex-col gap-4">
                  <section className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Live Preview
                    </p>

                    {bannerPreviewVisible ? (
                      <div
                        className={`mt-4 rounded-[1.5rem] border px-4 py-4 ${bannerPreviewTone.panelClassName}`}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                              bannerForm.severity === "critical"
                                ? "bg-red-100 text-red-700"
                                : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            <TriangleAlert size={18} />
                          </span>
                          <div>
                            <p
                              className={`text-[11px] font-black uppercase tracking-[0.18em] ${bannerPreviewTone.titleClassName}`}
                            >
                              {bannerForm.severity === "critical"
                                ? "System Critical"
                                : "System Warning"}
                            </p>
                            <p className="mt-2 text-base font-black text-slate-950">
                              {bannerForm.title || "Banner title"}
                            </p>
                            <p
                              className={`mt-2 text-sm font-medium leading-relaxed ${bannerPreviewTone.bodyClassName}`}
                            >
                              {bannerForm.message || "Banner message"}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-[1.5rem] border border-dashed border-slate-300 bg-white px-4 py-6 text-sm font-medium text-slate-500">
                        Add a title and message to preview the banner before you
                        save it.
                      </div>
                    )}
                  </section>

                  <section className="rounded-[1.5rem] border border-slate-200 bg-white px-5 py-5">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Saved State
                    </p>
                    <div
                      className={`mt-4 rounded-[1.25rem] border px-4 py-4 ${
                        systemBanner?.enabled
                          ? persistedBannerTone.panelClassName
                          : "border-slate-200 bg-slate-50"
                      }`}
                    >
                      <p className="text-sm font-semibold text-slate-900">
                        {systemBanner?.title || "Banner is currently blank"}
                      </p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-600">
                        {systemBanner?.message ||
                          "Save a banner here when you need to warn every operator at once."}
                      </p>
                    </div>
                  </section>
                </aside>
              </div>
            </section>

            <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    {modeLabel}
                  </p>
                  <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                    Resource defaults for new deployments
                  </h2>
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    These values are applied when a new deployment does not
                    override its own resource request. PaaS plans also use these
                    values as the per-agent resource bundle.
                  </p>
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-3">
                  {[
                    {
                      key: "vcpu",
                      label: "vCPU",
                      min: 1,
                      suffix: "cores",
                      icon: Cpu,
                      tone: "text-blue-600 bg-blue-50",
                    },
                    {
                      key: "ram_mb",
                      label: "RAM",
                      min: 512,
                      suffix: "MB",
                      icon: MemoryStick,
                      tone: "text-emerald-600 bg-emerald-50",
                    },
                    {
                      key: "disk_gb",
                      label: "Disk",
                      min: 1,
                      suffix: "GB",
                      icon: HardDrive,
                      tone: "text-purple-600 bg-purple-50",
                    },
                  ].map((field) => (
                    <label
                      key={field.key}
                      className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5"
                    >
                      <span
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl ${field.tone}`}
                      >
                        <field.icon size={18} />
                      </span>
                      <span className="mt-4 block text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        {field.label}
                      </span>
                      <input
                        type="number"
                        min={field.min}
                        step="1"
                        value={form[field.key]}
                        onChange={(event) =>
                          updateField(field.key, event.target.value)
                        }
                        className="mt-3 w-full bg-transparent text-3xl font-black tracking-tight text-slate-950 outline-none"
                      />
                      <span className="mt-1 block text-xs font-medium text-slate-400">
                        {field.suffix}
                      </span>
                    </label>
                  ))}
                </div>

                <div className="mt-6 rounded-[1.5rem] border border-red-100 bg-red-50 px-5 py-4">
                  <p className="text-sm font-semibold text-red-700">
                    New deployments only.
                  </p>
                  <p className="mt-1 text-sm font-medium leading-relaxed text-red-700/80">
                    Existing agents keep their saved resource specs. Changing
                    this setting only affects future deploys that start from the
                    platform default.
                  </p>
                </div>

                <div className="mt-6">
                  <button
                    onClick={handleSave}
                    disabled={saving || loading}
                    className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-all hover:-translate-y-0.5 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Save size={16} />
                    )}
                    Save defaults
                  </button>
                </div>
              </section>

              <aside className="flex flex-col gap-6">
                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Current snapshot
                  </p>
                  <div className="mt-4 space-y-4">
                    <div className="rounded-[1.5rem] bg-slate-50 px-5 py-5">
                      <p className="text-sm font-semibold text-slate-900">
                        {defaults?.vcpu ?? 1} vCPU
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-500">
                        {formatRamLabel(defaults?.ram_mb ?? 1024)}
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-500">
                        {defaults?.disk_gb ?? 10} GB disk
                      </p>
                    </div>
                    <div className="rounded-[1.5rem] border border-slate-200 px-5 py-5">
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Platform mode
                      </p>
                      <p className="mt-2 text-lg font-black text-slate-950">
                        {platformConfig?.mode === "paas"
                          ? "PaaS"
                          : "Self-hosted"}
                      </p>
                    </div>
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Behavior
                  </p>
                  <div className="mt-4 space-y-4 text-sm font-medium leading-relaxed text-slate-500">
                    <p>
                      Blank deploys in the operator dashboard initialize from
                      these values.
                    </p>
                    <p>
                      Explicit per-agent resource requests in self-hosted mode
                      can still override them, subject to platform limits.
                    </p>
                    <p>
                      Admin changes do not rewrite existing agents, redeploys,
                      or marketplace listing defaults already stored elsewhere.
                    </p>
                  </div>
                </section>
              </aside>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
