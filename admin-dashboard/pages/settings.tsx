import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Cpu,
  HardDrive,
  Loader2,
  Globe2,
  MemoryStick,
  RefreshCw,
  Rocket,
  Save,
  Share2,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import NotificationsSettingsCard from "../components/NotificationsSettingsCard";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { LOCALE_LABELS, LOCALES } from "../lib/i18n";

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
const DEFAULT_AGENT_HUB_FORM = {
  defaultShareTarget: "both",
  url: "https://norafleet.ai",
  sourceApiKey: "",
  clearSourceApiKey: false,
};
const DEFAULT_LANGUAGE_FORM = {
  defaultLocale: "en",
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

function buildAgentHubForm(settings) {
  return {
    defaultShareTarget: settings?.defaultShareTarget || DEFAULT_AGENT_HUB_FORM.defaultShareTarget,
    url: settings?.url || DEFAULT_AGENT_HUB_FORM.url,
    sourceApiKey: "",
    clearSourceApiKey: false,
  };
}

function buildLanguageForm(settings) {
  return {
    defaultLocale: settings?.defaultLocale || DEFAULT_LANGUAGE_FORM.defaultLocale,
  };
}

function formatShareTargetLabel(value) {
  if (value === "internal") return "Internal users only";
  if (value === "community") return "Nora community only";
  return "Internal users and Nora community";
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
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
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

const UPGRADE_RUNNING_PHASES = new Set([
  "queued",
  "fetching",
  "applying",
  "building",
  "health_checking",
  "running",
]);

function isUpgradeRunning(job) {
  return UPGRADE_RUNNING_PHASES.has(job?.phase);
}

function formatUpgradePhase(job) {
  if (!job?.phase) return "No upgrade job";
  if (job.phase === "queued") return "Queued";
  if (job.phase === "fetching") return "Fetching source";
  if (job.phase === "applying") return "Applying release";
  if (job.phase === "building") return "Rebuilding stack";
  if (job.phase === "health_checking") return "Checking health";
  if (job.phase === "running") return "Running";
  if (job.phase === "succeeded") return "Succeeded";
  if (job.phase === "failed") return "Failed";
  return String(job.phase)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getUpgradePhaseClassName(job) {
  if (job?.phase === "succeeded") return "bg-emerald-100 text-emerald-700";
  if (job?.phase === "failed") return "bg-red-100 text-red-700";
  if (isUpgradeRunning(job)) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

function formatPreflightStatus(status) {
  if (status === "ready") return "Ready";
  if (status === "warning") return "Ready with warnings";
  if (status === "blocked") return "Blocked";
  return "Not checked";
}

function getPreflightCheckClassName(status) {
  if (status === "pass") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warn") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-red-200 bg-red-50 text-red-700";
}

function getPreflightStatusClassName(status) {
  if (status === "ready") return "bg-emerald-100 text-emerald-700";
  if (status === "warning") return "bg-amber-100 text-amber-800";
  if (status === "blocked") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
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
  const [languageSettings, setLanguageSettings] = useState(null);
  const [languageForm, setLanguageForm] = useState(DEFAULT_LANGUAGE_FORM);
  const [agentHubSettings, setAgentHubSettings] = useState(null);
  const [agentHubForm, setAgentHubForm] = useState(DEFAULT_AGENT_HUB_FORM);
  const [platformConfig, setPlatformConfig] = useState(null);
  const [upgradeStatus, setUpgradeStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bannerSaving, setBannerSaving] = useState(false);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [agentHubSaving, setAgentHubSaving] = useState(false);
  const [upgradeStarting, setUpgradeStarting] = useState(false);

  const loadUpgradeStatus = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const response = await fetchWithAuth("/api/admin/release-upgrade");
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load release upgrade status");
        }

        setUpgradeStatus(payload);
        return payload;
      } catch (error) {
        console.error("Failed to load release upgrade status:", error);
        if (!silent) {
          toast.error(error.message || "Failed to load release upgrade status");
        }
        return null;
      }
    },
    [toast],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [defaultsRes, platformRes, bannerRes, languageRes, agentHubRes, upgradeRes] =
        await Promise.all([
          fetchWithAuth("/api/admin/settings/deployment-defaults"),
          fetch("/api/config/platform"),
          fetchWithAuth("/api/admin/settings/system-banner"),
          fetchWithAuth("/api/admin/settings/language"),
          fetchWithAuth("/api/admin/settings/agent-hub"),
          fetchWithAuth("/api/admin/release-upgrade"),
        ]);

      const defaultsPayload = await defaultsRes.json().catch(() => ({}));
      if (!defaultsRes.ok) {
        throw new Error(defaultsPayload.error || "Failed to load deployment defaults");
      }

      setDefaults(defaultsPayload);
      setForm(buildForm(defaultsPayload));

      const bannerPayload = await bannerRes.json().catch(() => ({}));
      if (!bannerRes.ok) {
        throw new Error(bannerPayload.error || "Failed to load system banner");
      }

      setSystemBanner(bannerPayload);
      setBannerForm(buildBannerForm(bannerPayload));

      const languagePayload = await languageRes.json().catch(() => ({}));
      if (!languageRes.ok) {
        throw new Error(languagePayload.error || "Failed to load language settings");
      }

      setLanguageSettings(languagePayload);
      setLanguageForm(buildLanguageForm(languagePayload));

      const agentHubPayload = await agentHubRes.json().catch(() => ({}));
      if (!agentHubRes.ok) {
        throw new Error(agentHubPayload.error || "Failed to load Agent Hub settings");
      }

      setAgentHubSettings(agentHubPayload);
      setAgentHubForm(buildAgentHubForm(agentHubPayload));

      if (platformRes.ok) {
        setPlatformConfig(await platformRes.json());
      }

      const upgradePayload = await upgradeRes.json().catch(() => ({}));
      if (!upgradeRes.ok) {
        throw new Error(upgradePayload.error || "Failed to load release upgrade status");
      }
      setUpgradeStatus(upgradePayload);
    } catch (error) {
      console.error("Failed to load platform settings:", error);
      toast.error(error.message || "Failed to load platform settings");
      setDefaults(null);
      setSystemBanner(null);
      setLanguageSettings(null);
      setAgentHubSettings(null);
      setUpgradeStatus(null);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!isUpgradeRunning(upgradeStatus?.job)) return undefined;

    const intervalId = window.setInterval(() => {
      loadUpgradeStatus({ silent: true });
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [loadUpgradeStatus, upgradeStatus?.job?.phase]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateBannerField(field, value) {
    setBannerForm((current) => ({ ...current, [field]: value }));
  }

  function updateLanguageField(field, value) {
    setLanguageForm((current) => ({ ...current, [field]: value }));
  }

  function updateAgentHubField(field, value) {
    setAgentHubForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/settings/deployment-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vcpu: form.vcpu,
          ram_mb: form.ram_mb,
          disk_gb: form.disk_gb,
        }),
      });
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

  async function handleSaveLanguage() {
    setLanguageSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/settings/language", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultLocale: languageForm.defaultLocale,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save language settings");
      }

      setLanguageSettings(payload);
      setLanguageForm(buildLanguageForm(payload));
      toast.success("Default language updated");
    } catch (error) {
      console.error("Failed to save default language:", error);
      toast.error(error.message || "Failed to save language settings");
    } finally {
      setLanguageSaving(false);
    }
  }

  async function handleSaveAgentHub() {
    setAgentHubSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/settings/agent-hub", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultShareTarget: agentHubForm.defaultShareTarget,
          url: agentHubForm.url,
          ...(agentHubForm.sourceApiKey ? { sourceApiKey: agentHubForm.sourceApiKey } : {}),
          clearSourceApiKey: agentHubForm.clearSourceApiKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save Agent Hub settings");
      }

      setAgentHubSettings(payload);
      setAgentHubForm(buildAgentHubForm(payload));
      toast.success("Agent Hub settings updated");
    } catch (error) {
      console.error("Failed to save Agent Hub settings:", error);
      toast.error(error.message || "Failed to save Agent Hub settings");
    } finally {
      setAgentHubSaving(false);
    }
  }

  const modeLabel =
    platformConfig?.mode === "paas" ? "PaaS plan defaults" : "Self-hosted deploy defaults";
  const release = upgradeStatus?.release || platformConfig?.release || null;
  const autoUpgrade = upgradeStatus?.autoUpgrade || release?.autoUpgrade || null;
  const upgradeJob = upgradeStatus?.job || null;
  const upgradePreflight = upgradeStatus?.preflight || null;
  const upgradePreflightChecks = Array.isArray(upgradePreflight?.checks)
    ? upgradePreflight.checks
    : [];
  const failedPreflightCheck =
    upgradePreflightChecks.find((check) => check.status === "fail") || null;
  const upgradeLogTail = Array.isArray(upgradeStatus?.logTail) ? upgradeStatus.logTail : [];
  const upgradeRunning = isUpgradeRunning(upgradeJob);
  const oneClickConfigured = Boolean(autoUpgrade?.enabled);
  const oneClickEnabled = Boolean(autoUpgrade?.available && upgradePreflight?.ok);
  const runnerReachable = upgradeStatus?.runnerReachable;
  const oneClickBlockedReason = !oneClickEnabled
    ? failedPreflightCheck?.message ||
      autoUpgrade?.disabledReason ||
      "Direct GitHub upgrade is not enabled for this install."
    : runnerReachable === false
      ? "The GitHub upgrade runner could not be started."
      : !release?.updateAvailable
        ? "This control plane is already on the latest announced release."
        : null;
  const canStartOneClickUpgrade = Boolean(
    oneClickEnabled &&
    runnerReachable !== false &&
    release?.updateAvailable &&
    !upgradeRunning &&
    !upgradeStarting,
  );
  const releaseStatus = getReleaseStatus(release);
  const bannerFeatureEnabled = Boolean(systemBanner?.featureEnabled);
  const bannerPreviewTone = getBannerTone(bannerForm.severity);
  const persistedBannerTone = getBannerTone(systemBanner?.severity);
  const bannerPreviewVisible = Boolean(bannerForm.title.trim() || bannerForm.message.trim());

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

  async function handleStartOneClickUpgrade() {
    if (!canStartOneClickUpgrade) {
      toast.error(oneClickBlockedReason || "One-click upgrade is not available");
      return;
    }

    setUpgradeStarting(true);
    try {
      const response = await fetchWithAuth("/api/admin/release-upgrade", {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to start upgrade");
      }

      setUpgradeStatus(payload);
      toast.success("Upgrade started in the background");
    } catch (error) {
      console.error("Failed to start one-click upgrade:", error);
      toast.error(error.message || "Failed to start upgrade");
      loadUpgradeStatus({ silent: true });
    } finally {
      setUpgradeStarting(false);
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
              Configure the platform release path, the global testing warning banner, and the
              default CPU, RAM, and disk used for future deployments.
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
              id="language-default"
              className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Language
                  </p>
                  <h2 className="mt-2 flex items-center gap-3 text-xl font-black tracking-tight text-slate-950">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                      <Globe2 size={20} />
                    </span>
                    Default language for all accounts
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                    Choose the platform fallback language. Users without their own setting follow
                    this value, while user-level language overrides stay intact.
                  </p>
                </div>

                <div className="inline-flex items-center gap-2 self-start rounded-full bg-blue-50 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-blue-700">
                  <Globe2 size={14} />
                  {LOCALE_LABELS[languageSettings?.defaultLocale || "en"]}
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-4 rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5 sm:flex-row sm:items-end sm:justify-between">
                <label className="w-full sm:max-w-sm">
                  <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Platform default
                  </span>
                  <select
                    value={languageForm.defaultLocale}
                    onChange={(event) => updateLanguageField("defaultLocale", event.target.value)}
                    className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-300"
                  >
                    {LOCALES.map((item) => (
                      <option key={item} value={item}>
                        {LOCALE_LABELS[item]}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  onClick={handleSaveLanguage}
                  disabled={languageSaving || loading}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:-translate-y-0.5 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {languageSaving ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Save size={16} />
                  )}
                  Save language
                </button>
              </div>
            </section>

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
                    Upgrade status and paths
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                    Track the running Nora build, review the latest announced release, start an
                    opt-in background upgrade when configured, or copy the host-side manual command.
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
                    {oneClickConfigured ? "Manual + one-click" : "Manual"}
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    {formatInstallMethod(release?.installMethod)}{" "}
                    {oneClickEnabled
                      ? "from GitHub"
                      : oneClickConfigured
                        ? "preflight blocked"
                        : "with host command"}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
                <section className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                        Direct GitHub Upgrade
                      </p>
                      <p className="mt-2 text-sm font-medium leading-relaxed text-slate-600">
                        Starts a temporary Docker runner that fetches Nora from GitHub and keeps
                        progress visible while the stack rebuilds in the background.
                      </p>
                    </div>

                    {upgradeJob ? (
                      <span
                        className={`inline-flex items-center gap-2 self-start rounded-full px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] ${getUpgradePhaseClassName(
                          upgradeJob,
                        )}`}
                      >
                        {isUpgradeRunning(upgradeJob) ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : upgradeJob.phase === "succeeded" ? (
                          <CheckCircle2 size={13} />
                        ) : (
                          <TriangleAlert size={13} />
                        )}
                        {formatUpgradePhase(upgradeJob)}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <button
                      onClick={handleStartOneClickUpgrade}
                      disabled={!canStartOneClickUpgrade}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:hover:translate-y-0"
                    >
                      {upgradeStarting || upgradeRunning ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Rocket size={16} />
                      )}
                      {upgradeRunning ? "Upgrade running" : "Upgrade now"}
                    </button>

                    <button
                      onClick={() => loadUpgradeStatus({ silent: false })}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50"
                    >
                      <RefreshCw size={15} />
                      Check status
                    </button>
                  </div>

                  {oneClickBlockedReason ? (
                    <div className="mt-5 rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                      <p className="text-sm font-semibold text-slate-900">
                        Direct GitHub upgrade is not ready.
                      </p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
                        {oneClickBlockedReason}
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-5 rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                          Preflight checks
                        </p>
                        <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
                          Confirms the runner can reach Docker, resolve the release target, and use
                          the same deploy env and compose files as this stack.
                        </p>
                      </div>
                      <span
                        className={`inline-flex items-center gap-2 self-start rounded-full px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] ${getPreflightStatusClassName(
                          upgradePreflight?.status,
                        )}`}
                      >
                        {upgradePreflight?.ok ? (
                          <CheckCircle2 size={13} />
                        ) : (
                          <TriangleAlert size={13} />
                        )}
                        {formatPreflightStatus(upgradePreflight?.status)}
                      </span>
                    </div>

                    {upgradePreflightChecks.length ? (
                      <div className="mt-4 grid gap-3 lg:grid-cols-2">
                        {upgradePreflightChecks.map((check, index) => (
                          <div
                            key={`${check.id}-${index}`}
                            className={`rounded-2xl border px-4 py-3 ${getPreflightCheckClassName(
                              check.status,
                            )}`}
                          >
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 shrink-0">
                                {check.status === "pass" ? (
                                  <CheckCircle2 size={16} />
                                ) : (
                                  <TriangleAlert size={16} />
                                )}
                              </span>
                              <span>
                                <span className="block text-sm font-black">{check.label}</span>
                                <span className="mt-1 block break-words text-sm font-medium leading-relaxed opacity-80">
                                  {check.message}
                                </span>
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-4 text-sm font-medium leading-relaxed text-slate-500">
                        Preflight has not returned checks yet.
                      </p>
                    )}

                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <div className="rounded-2xl bg-slate-50 px-4 py-4">
                        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                          Deploy env
                        </p>
                        <p className="mt-2 break-words text-sm font-semibold text-slate-900">
                          {upgradePreflight?.config?.envFile || autoUpgrade?.envFile || ".env"}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 px-4 py-4">
                        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                          Compose files
                        </p>
                        <p className="mt-2 break-words text-sm font-semibold text-slate-900">
                          {(
                            upgradePreflight?.config?.composeFiles ||
                            autoUpgrade?.composeFiles ||
                            []
                          ).join(", ") || "docker-compose.yml"}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl bg-slate-950 px-4 py-4 text-slate-100">
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                        Runner compose command
                      </p>
                      <pre className="mt-3 overflow-x-auto text-xs font-semibold leading-relaxed text-slate-100">
                        <code>
                          {upgradePreflight?.command ||
                            autoUpgrade?.command ||
                            "docker compose --env-file .env -f docker-compose.yml up -d --build"}
                        </code>
                      </pre>
                    </div>
                  </div>

                  {upgradeJob ? (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-[1.25rem] bg-white px-4 py-4">
                        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                          Target
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {upgradeJob.targetVersion
                            ? formatVersionLabel(upgradeJob.targetVersion)
                            : "Latest release"}
                        </p>
                      </div>
                      <div className="rounded-[1.25rem] bg-white px-4 py-4">
                        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                          Started
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {upgradeJob.startedAt ? formatDateTime(upgradeJob.startedAt) : "Pending"}
                        </p>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-5 rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Recent upgrade logs
                    </p>
                    {upgradeLogTail.length ? (
                      <pre className="mt-3 max-h-56 overflow-auto rounded-2xl bg-slate-950 p-4 text-xs font-semibold leading-relaxed text-slate-100">
                        <code>{upgradeLogTail.join("\n")}</code>
                      </pre>
                    ) : (
                      <p className="mt-2 text-sm font-medium leading-relaxed text-slate-500">
                        No upgrade logs have been recorded yet.
                      </p>
                    )}
                  </div>
                </section>

                <section className="rounded-[1.5rem] bg-slate-950 px-5 py-5 text-slate-100">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                        Manual Host Command
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
                      {release?.manualUpgrade?.command || "Upgrade command not configured"}
                    </code>
                  </pre>
                </section>
              </div>

              <div className="mt-6">
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
                        <p className="text-sm font-medium leading-relaxed text-slate-600">{step}</p>
                      </div>
                    ))}
                  </div>

                  <div
                    className={`mt-5 rounded-[1.25rem] border px-4 py-4 ${releaseStatus.panelClassName}`}
                  >
                    <p className={`text-sm font-semibold ${releaseStatus.titleClassName}`}>
                      {oneClickEnabled
                        ? "Direct GitHub upgrade is enabled for this install."
                        : oneClickConfigured
                          ? "Direct GitHub upgrade needs preflight attention."
                          : "Manual upgrade remains available."}
                    </p>
                    <p
                      className={`mt-1 text-sm font-medium leading-relaxed ${releaseStatus.bodyClassName}`}
                    >
                      {oneClickEnabled
                        ? "Use the button above to start the temporary GitHub runner, or copy the host command when you want to run the same update yourself."
                        : oneClickConfigured
                          ? "Review the preflight checks above before starting the background GitHub runner."
                          : "Set NORA_AUTO_UPGRADE_ENABLED=true and NORA_HOST_REPO_DIR to show the background GitHub upgrade action."}
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
                    Publish one top-of-page warning across the operator and admin surfaces. Use it
                    for staging-only notices, maintenance warnings, or other global operator
                    guidance.
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
                    Set <code>NORA_SYSTEM_BANNER_ENABLED=true</code> in <code>.env</code> and
                    restart Nora. You can still save the draft below before you flip the flag.
                  </p>
                </div>
              ) : null}

              <div className="mt-6 grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
                <section className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5">
                  <label className="flex items-start gap-3 rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <input
                      type="checkbox"
                      checked={bannerForm.enabled}
                      onChange={(event) => updateBannerField("enabled", event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">
                        Show banner on every dashboard page
                      </span>
                      <span className="mt-1 block text-sm font-medium leading-relaxed text-slate-500">
                        When enabled, this banner appears across <code>/app</code> and{" "}
                        <code>/admin</code>. Operators cannot dismiss it per session.
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
                        onChange={(event) => updateBannerField("severity", event.target.value)}
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
                        Save changes here to update the shared banner payload used by both
                        dashboards.
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
                      onChange={(event) => updateBannerField("title", event.target.value)}
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
                      onChange={(event) => updateBannerField("message", event.target.value)}
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
                      Best for maintenance notices, staging disclaimers, and other system-wide
                      operator warnings.
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
                        Add a title and message to preview the banner before you save it.
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

            <section
              id="agent-hub"
              className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Agent Hub
                  </p>
                  <h2 className="mt-2 flex items-center gap-3 text-xl font-black tracking-tight text-slate-950">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                      <Share2 size={20} />
                    </span>
                    Sharing defaults and hosted catalog
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                    Choose the default target for user-shared agent templates and configure the
                    hosted Agent Hub used for the community catalog.
                  </p>
                </div>

                <div className="inline-flex items-center gap-2 self-start rounded-full bg-slate-100 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-slate-700">
                  <Share2 size={14} />
                  {formatShareTargetLabel(agentHubSettings?.defaultShareTarget)}
                </div>
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
                <section className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-5">
                  <label className="block rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Default Share Target
                    </span>
                    <select
                      value={agentHubForm.defaultShareTarget}
                      onChange={(event) =>
                        updateAgentHubField("defaultShareTarget", event.target.value)
                      }
                      className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-red-300"
                    >
                      <option value="both">Internal users and Nora community</option>
                      <option value="internal">Internal users only</option>
                      <option value="community">Nora community only</option>
                    </select>
                  </label>

                  <label className="mt-4 block rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Hosted Hub URL
                    </span>
                    <input
                      type="url"
                      value={agentHubForm.url}
                      onChange={(event) => updateAgentHubField("url", event.target.value)}
                      placeholder="https://norafleet.ai"
                      className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-red-300"
                    />
                  </label>

                  <label className="mt-4 block rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
                    <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Hosted Hub API Key
                    </span>
                    <input
                      type="password"
                      value={agentHubForm.sourceApiKey}
                      onChange={(event) =>
                        setAgentHubForm((current) => ({
                          ...current,
                          sourceApiKey: event.target.value,
                          clearSourceApiKey: false,
                        }))
                      }
                      placeholder={
                        agentHubSettings?.sourceApiKeyConfigured
                          ? "Leave blank to keep the saved key"
                          : "Paste a hosted Agent Hub key"
                      }
                      className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-red-300"
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-500">
                      <span>
                        {agentHubSettings?.sourceApiKeyConfigured
                          ? `Configured via ${agentHubSettings.sourceApiKeySource}`
                          : "Required for community catalog pulls and submissions."}
                      </span>
                      {agentHubSettings?.sourceApiKeySource === "database" ? (
                        <button
                          type="button"
                          onClick={() =>
                            setAgentHubForm((current) => ({
                              ...current,
                              sourceApiKey: "",
                              clearSourceApiKey: true,
                            }))
                          }
                          className="font-black text-red-600 hover:text-red-700"
                        >
                          Clear saved key
                        </button>
                      ) : null}
                      {agentHubForm.clearSourceApiKey ? (
                        <span className="font-black text-red-600">Clear on save</span>
                      ) : null}
                    </div>
                  </label>

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <button
                      onClick={handleSaveAgentHub}
                      disabled={agentHubSaving || loading}
                      className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-all hover:-translate-y-0.5 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {agentHubSaving ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Save size={16} />
                      )}
                      Save Agent Hub
                    </button>
                  </div>
                </section>

                <aside className="rounded-[1.5rem] border border-slate-200 bg-white px-5 py-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Saved State
                  </p>
                  <div className="mt-4 space-y-4">
                    <div className="rounded-[1.25rem] bg-slate-50 px-4 py-4">
                      <p className="text-sm font-semibold text-slate-900">
                        {formatShareTargetLabel(agentHubSettings?.defaultShareTarget)}
                      </p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
                        Users can still override this target when sharing a specific agent.
                      </p>
                    </div>
                    <div className="rounded-[1.25rem] bg-slate-50 px-4 py-4">
                      <p className="text-sm font-semibold text-slate-900">
                        {agentHubSettings?.url || DEFAULT_AGENT_HUB_FORM.url}
                      </p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
                        Community catalog pulls and best-effort submissions use this host.
                      </p>
                    </div>
                    <div className="rounded-[1.25rem] bg-slate-50 px-4 py-4">
                      <p className="text-sm font-semibold text-slate-900">
                        {agentHubSettings?.sourceApiKeyConfigured
                          ? agentHubSettings?.sourceApiKeyMasked || "Configured"
                          : "No source-catalog key configured"}
                      </p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
                        {agentHubSettings?.sourceApiKeySource === "env"
                          ? "NORA_AGENT_HUB_API_KEY is active and overrides the saved key."
                          : "Hosted community catalog requests send this key to the source hub."}
                      </p>
                    </div>
                  </div>
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
                    These values are applied when a new deployment does not override its own
                    resource request. PaaS plans also use these values as the per-agent resource
                    bundle.
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
                        onChange={(event) => updateField(field.key, event.target.value)}
                        className="mt-3 w-full bg-transparent text-3xl font-black tracking-tight text-slate-950 outline-none"
                      />
                      <span className="mt-1 block text-xs font-medium text-slate-400">
                        {field.suffix}
                      </span>
                    </label>
                  ))}
                </div>

                <div className="mt-6 rounded-[1.5rem] border border-red-100 bg-red-50 px-5 py-4">
                  <p className="text-sm font-semibold text-red-700">New deployments only.</p>
                  <p className="mt-1 text-sm font-medium leading-relaxed text-red-700/80">
                    Existing agents keep their saved resource specs. Changing this setting only
                    affects future deploys that start from the platform default.
                  </p>
                </div>

                <div className="mt-6">
                  <button
                    onClick={handleSave}
                    disabled={saving || loading}
                    className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-all hover:-translate-y-0.5 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
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
                        {platformConfig?.mode === "paas" ? "PaaS" : "Self-hosted"}
                      </p>
                    </div>
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Behavior
                  </p>
                  <div className="mt-4 space-y-4 text-sm font-medium leading-relaxed text-slate-500">
                    <p>Blank deploys in the operator dashboard initialize from these values.</p>
                    <p>
                      Explicit per-agent resource requests in self-hosted mode can still override
                      them, subject to platform limits.
                    </p>
                    <p>
                      Admin changes do not rewrite existing agents, redeploys, or Agent Hub listing
                      defaults already stored elsewhere.
                    </p>
                  </div>
                </section>
              </aside>
            </div>

            <div className="mt-6">
              <NotificationsSettingsCard />
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
