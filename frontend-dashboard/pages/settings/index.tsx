import { useState, useEffect, useRef } from "react";
import Layout from "../../components/layout/Layout";
import LLMSetupWizard from "../../components/agents/LLMSetupWizard";
import {
  User,
  Lock,
  CreditCard,
  Link2,
  Trash2,
  Save,
  Loader2,
  ExternalLink,
  Shield,
  Key,
  Mail,
  Plus,
  RefreshCw,
  Calendar,
  BadgeCheck,
  Edit3,
  Check,
  Copy,
  X,
  Camera,
  Globe2,
  Star,
} from "lucide-react";
import { useRouter } from "next/router";
import { fetchWithAuth } from "../../lib/api";
import { LOCALE_LABELS, LOCALES, normalizeLocale, useI18n } from "../../lib/i18n";
import { useToast } from "../../components/Toast";
import ActivationChecklist from "../../components/onboarding/ActivationChecklist";

const NORA_REPO_URL = "https://github.com/solomon2773/nora";

function formatPlanLabel(plan, { selfHosted = false } = {}) {
  const normalized = String(plan || "free")
    .trim()
    .toLowerCase();
  if (selfHosted || normalized === "selfhosted") return "Self-hosted";
  if (!normalized) return "Free";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatAgentCap(limit, isUnlimited) {
  if (isUnlimited) return "Unlimited";
  if (Number.isInteger(limit)) return String(limit);
  return "—";
}

function describeAgentCapSource(source) {
  switch (source) {
    case "admin_override":
      return "Admin override";
    case "admin_default_unlimited":
      return "Admin default";
    case "default":
    default:
      return "Default user cap";
  }
}

function formatDefaultAgentCap(role, baseAgentLimit) {
  if (role === "admin") return "Unlimited";
  if (Number.isInteger(baseAgentLimit)) return String(baseAgentLimit);
  return "—";
}

export default function SettingsPage() {
  const router = useRouter();
  const { defaultLocale } = useI18n();
  const [profile, setProfile] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [platformConfig, setPlatformConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [agentHubKeys, setAgentHubKeys] = useState([]);
  const [agentHubKeyLabel, setAgentHubKeyLabel] = useState("Nora installation");
  const [agentHubKeyLoading, setAgentHubKeyLoading] = useState(false);
  const [agentHubKeyCreating, setAgentHubKeyCreating] = useState(false);
  const [generatedAgentHubKey, setGeneratedAgentHubKey] = useState(null);
  const avatarInputRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      fetchWithAuth("/api/auth/me").then((r) => r.json()),
      fetchWithAuth("/api/billing/subscription")
        .then((r) => r.json())
        .catch(() => null),
      fetch("/api/config/platform")
        .then((r) => r.json())
        .catch(() => ({ mode: "selfhosted" })),
      fetchWithAuth("/api/agent-hub/api-keys")
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ])
      .then(([p, s, c, hubKeys]) => {
        setProfile(p);
        setSubscription(s);
        setPlatformConfig(c);
        setAgentHubKeys(Array.isArray(hubKeys) ? hubKeys : []);
        setNameInput(p?.name || "");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const isSelfHosted = platformConfig?.mode !== "paas";
  const isEmailAuth = !profile?.provider || profile.provider === "email";

  async function handleAvatarChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 375000) {
      toast.error("Image too large. Max 375KB.");
      return;
    }
    setUploadingAvatar(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUri = reader.result;
        const res = await fetchWithAuth("/api/auth/profile", {
          method: "PATCH",
          body: JSON.stringify({ avatar: dataUri }),
        });
        if (res.ok) {
          const data = await res.json();
          setProfile((p) => ({ ...p, avatar: data.avatar }));
          toast.success("Profile picture updated");
        } else {
          const data = await res.json();
          toast.error(data.error || "Failed to upload");
        }
        setUploadingAvatar(false);
      };
      reader.readAsDataURL(file);
    } catch {
      toast.error("Failed to upload");
      setUploadingAvatar(false);
    }
  }

  async function handleAvatarRemove() {
    setUploadingAvatar(true);
    try {
      const res = await fetchWithAuth("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ avatar: null }),
      });
      if (res.ok) {
        setProfile((p) => ({ ...p, avatar: null }));
        toast.success("Profile picture removed");
      }
    } catch {
      toast.error("Failed to remove");
    }
    setUploadingAvatar(false);
  }

  async function handleNameSave() {
    if (!nameInput.trim() || nameInput === profile?.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      const res = await fetchWithAuth("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: nameInput.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setProfile((p) => ({ ...p, name: data.name || nameInput.trim() }));
        toast.success("Name updated");
      } else {
        toast.error("Failed to update name");
      }
    } catch {
      toast.error("An error occurred");
    }
    setSavingName(false);
    setEditingName(false);
  }

  async function handleLanguageChange(value) {
    setLanguageSaving(true);
    try {
      const preferredLocale = value === "default" ? null : normalizeLocale(value);
      const res = await fetchWithAuth("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredLocale }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update language");

      const nextLocale = normalizeLocale(data.effectiveLocale || data.defaultLocale || value);
      setProfile((current) => ({
        ...current,
        preferredLocale: data.preferredLocale || null,
        defaultLocale: data.defaultLocale || current?.defaultLocale,
        effectiveLocale: nextLocale,
      }));
      toast.success("Language updated");
      await router.push(router.pathname, router.asPath, { locale: nextLocale });
    } catch (error) {
      toast.error(error.message || "Failed to update language");
    } finally {
      setLanguageSaving(false);
    }
  }

  async function loadAgentHubKeys() {
    setAgentHubKeyLoading(true);
    try {
      const res = await fetchWithAuth("/api/agent-hub/api-keys");
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data.error || "Failed to load Agent Hub keys");
      setAgentHubKeys(Array.isArray(data) ? data : []);
    } catch (error) {
      toast.error(error.message || "Failed to load Agent Hub keys");
    } finally {
      setAgentHubKeyLoading(false);
    }
  }

  async function createAgentHubKey() {
    setAgentHubKeyCreating(true);
    setGeneratedAgentHubKey(null);
    try {
      const res = await fetchWithAuth("/api/agent-hub/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: agentHubKeyLabel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create Agent Hub key");
      setGeneratedAgentHubKey(data.apiKey || null);
      setAgentHubKeys((current) => [data, ...current.filter((entry) => entry.id !== data.id)]);
      toast.success("Agent Hub key created");
    } catch (error) {
      toast.error(error.message || "Failed to create Agent Hub key");
    } finally {
      setAgentHubKeyCreating(false);
    }
  }

  async function revokeAgentHubKey(keyId) {
    try {
      const res = await fetchWithAuth(`/api/agent-hub/api-keys/${keyId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to revoke Agent Hub key");
      setAgentHubKeys((current) =>
        current.map((entry) => (entry.id === keyId ? { ...entry, ...data } : entry)),
      );
      toast.success("Agent Hub key revoked");
    } catch (error) {
      toast.error(error.message || "Failed to revoke Agent Hub key");
    }
  }

  async function copyAgentHubKey() {
    if (!generatedAgentHubKey) return;
    try {
      await navigator.clipboard.writeText(generatedAgentHubKey);
      toast.success("Agent Hub key copied");
    } catch {
      toast.error("Failed to copy key");
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault();
    if (passwords.new.length < 8) {
      setPwMsg("Password must be at least 8 characters");
      return;
    }
    if (passwords.new !== passwords.confirm) {
      setPwMsg("Passwords do not match");
      return;
    }
    setSaving(true);
    setPwMsg("");
    setPwSuccess(false);
    try {
      const res = await fetchWithAuth("/api/auth/password", {
        method: "PATCH",
        body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.new }),
      });
      if (res.ok) {
        setPwMsg("Password updated successfully");
        setPwSuccess(true);
        setPasswords({ current: "", new: "", confirm: "" });
      } else {
        const data = await res.json();
        setPwMsg(data.error || "Failed to update password");
      }
    } catch {
      setPwMsg("An error occurred");
    }
    setSaving(false);
  }

  async function handleManageBilling() {
    try {
      const res = await fetchWithAuth("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      toast.error("Could not open billing portal");
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="animate-spin text-blue-500" size={32} />
        </div>
      </Layout>
    );
  }

  const plan = subscription?.plan || "free";
  const planLabel = formatPlanLabel(plan, { selfHosted: isSelfHosted });
  const effectiveAgentCap = formatAgentCap(subscription?.agent_limit, subscription?.is_unlimited);
  const defaultAgentCap = formatDefaultAgentCap(profile?.role, subscription?.base_agent_limit);
  const agentCapSource = describeAgentCapSource(
    subscription?.agent_limit_source ||
      (profile?.role === "admin" ? "admin_default_unlimited" : "default"),
  );
  const selfHostedMaxAgents = platformConfig?.selfhosted?.max_agents || 50;
  const memberSince = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "—";
  const profileDefaultLocale = normalizeLocale(profile?.defaultLocale || defaultLocale);
  const languageValue = profile?.preferredLocale || "default";

  return (
    <Layout>
      <div className="max-w-3xl mx-auto space-y-8 pb-12">
        <div>
          <h1 className="text-2xl font-black text-slate-900">Settings</h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage your account, security, and preferences.
          </p>
        </div>

        <ActivationChecklist
          compact
          title="Settings-driven activation"
          subtitle="For self-hosted deployments, this page is step one: add one provider key here, then move to Deploy and bring the runtime online."
        />

        {/* Profile Card */}
        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <User size={20} className="text-blue-600" />
            <h2 className="text-lg font-bold text-slate-900">Profile</h2>
          </div>

          {/* Avatar + Name */}
          <div className="flex items-start gap-4 mb-6">
            <div className="relative group shrink-0">
              {profile?.avatar ? (
                <img
                  src={profile.avatar}
                  alt="Avatar"
                  className="w-16 h-16 rounded-2xl object-cover"
                />
              ) : (
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xl font-black">
                  {(profile?.name || profile?.email || "U").charAt(0).toUpperCase()}
                </div>
              )}
              <button
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
              >
                {uploadingAvatar ? (
                  <Loader2 size={20} className="text-white animate-spin" />
                ) : (
                  <Camera size={20} className="text-white" />
                )}
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
              {profile?.avatar && (
                <button
                  onClick={handleAvatarRemove}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
                  title="Remove photo"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex-1 min-w-0">
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleNameSave();
                      if (e.key === "Escape") {
                        setEditingName(false);
                        setNameInput(profile?.name || "");
                      }
                    }}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                    autoFocus
                  />
                  <button
                    onClick={handleNameSave}
                    disabled={savingName}
                    className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg"
                  >
                    {savingName ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Check size={16} />
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setEditingName(false);
                      setNameInput(profile?.name || "");
                    }}
                    className="p-1.5 text-slate-400 hover:bg-slate-50 rounded-lg"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-900 truncate">
                    {profile?.name || "Unnamed User"}
                  </h3>
                  <button
                    onClick={() => setEditingName(true)}
                    className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    <Edit3 size={14} />
                  </button>
                </div>
              )}
              <div className="flex items-center gap-1.5 mt-1">
                <Mail size={12} className="text-slate-400" />
                <span className="text-sm text-slate-500">{profile?.email}</span>
              </div>
            </div>
          </div>

          {/* Info Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-50 rounded-xl p-3">
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                Role
              </label>
              <div className="flex items-center gap-1.5 mt-1">
                <BadgeCheck
                  size={14}
                  className={profile?.role === "admin" ? "text-purple-500" : "text-blue-500"}
                />
                <span className="text-sm font-semibold text-slate-900 capitalize">
                  {profile?.role || "user"}
                </span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                Auth Provider
              </label>
              <div className="flex items-center gap-1.5 mt-1">
                {profile?.provider === "google" && <GoogleIcon />}
                {profile?.provider === "github" && <GitHubIcon />}
                {isEmailAuth && <Lock size={14} className="text-slate-400" />}
                <span className="text-sm font-semibold text-slate-900 capitalize">
                  {profile?.provider || "Email / Password"}
                </span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                Member Since
              </label>
              <div className="flex items-center gap-1.5 mt-1">
                <Calendar size={14} className="text-slate-400" />
                <span className="text-sm font-semibold text-slate-900">{memberSince}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <Globe2 size={20} className="text-blue-600" />
            <div>
              <h2 className="text-lg font-bold text-slate-900">Language</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Choose the language used across Nora when you sign in.
              </p>
            </div>
          </div>
          <label className="block">
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Display Language
            </span>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
              <select
                value={languageValue}
                onChange={(event) => handleLanguageChange(event.target.value)}
                disabled={languageSaving}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-500/40 focus:ring-2 focus:ring-blue-500/20 sm:max-w-xs"
              >
                <option value="default">
                  Use platform default ({LOCALE_LABELS[profileDefaultLocale]})
                </option>
                {LOCALES.map((item) => (
                  <option key={item} value={item}>
                    {LOCALE_LABELS[item]}
                  </option>
                ))}
              </select>
              {languageSaving ? (
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500">
                  <Loader2 size={15} className="animate-spin" />
                  Saving
                </span>
              ) : (
                <span className="text-sm font-medium text-slate-500">
                  Current language: {LOCALE_LABELS[normalizeLocale(profile?.effectiveLocale)]}
                </span>
              )}
            </div>
          </label>
        </section>

        {/* Connected Accounts */}
        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <Link2 size={20} className="text-blue-600" />
            <h2 className="text-lg font-bold text-slate-900">Connected Accounts</h2>
          </div>
          <div className="flex flex-col gap-3">
            <AccountRow
              icon={<GoogleIcon />}
              name="Google"
              connected={profile?.provider === "google"}
            />
            <AccountRow
              icon={<GitHubIcon />}
              name="GitHub"
              connected={profile?.provider === "github"}
            />
          </div>
        </section>

        {/* LLM Provider Keys */}
        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <Key size={20} className="text-blue-600" />
            <div>
              <h2 className="text-lg font-bold text-slate-900">LLM Provider Keys</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                API keys are shared across all your agents. Sync to agents after changes.
              </p>
            </div>
          </div>
          <LLMSetupWizard compact />
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-center gap-3">
              <Shield size={20} className="text-blue-600" />
              <div>
                <h2 className="text-lg font-bold text-slate-900">Agent Hub API Keys</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Create installation keys for source catalog access.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={loadAgentHubKeys}
              disabled={agentHubKeyLoading}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={15} className={agentHubKeyLoading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {generatedAgentHubKey ? (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">
                New key
              </p>
              <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-center">
                <code className="min-w-0 flex-1 break-all rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-800">
                  {generatedAgentHubKey}
                </code>
                <button
                  type="button"
                  onClick={copyAgentHubKey}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700"
                >
                  <Copy size={15} />
                  Copy
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-5 grid gap-3 md:grid-cols-[1fr,auto]">
            <label>
              <span className="sr-only">Agent Hub API key label</span>
              <input
                type="text"
                value={agentHubKeyLabel}
                onChange={(event) => setAgentHubKeyLabel(event.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-500/40 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
            <button
              type="button"
              onClick={createAgentHubKey}
              disabled={agentHubKeyCreating}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {agentHubKeyCreating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              Create Key
            </button>
          </div>

          <div className="mt-5 space-y-3">
            {agentHubKeys.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500">
                No Agent Hub keys yet.
              </div>
            ) : (
              agentHubKeys.map((key) => {
                const revoked = key.status === "revoked";
                return (
                  <div
                    key={key.id}
                    className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-slate-900">{key.label}</p>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-widest ${
                            revoked
                              ? "border-slate-200 bg-white text-slate-500"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {revoked ? "Revoked" : "Active"}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-xs font-semibold text-slate-500">
                        {key.maskedKey || key.keyPrefix}
                      </p>
                      <p className="mt-1 text-xs font-medium text-slate-400">
                        Last used{" "}
                        {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
                      </p>
                    </div>
                    {!revoked ? (
                      <button
                        type="button"
                        onClick={() => revokeAgentHubKey(key.id)}
                        className="inline-flex items-center justify-center rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50"
                      >
                        Revoke
                      </button>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Change Password — only for email/password users */}
        {isEmailAuth && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Lock size={20} className="text-blue-600" />
              <h2 className="text-lg font-bold text-slate-900">Change Password</h2>
            </div>
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Current Password
                </label>
                <input
                  type="password"
                  placeholder="Enter current password"
                  className="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                  value={passwords.current}
                  onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    New Password
                  </label>
                  <input
                    type="password"
                    placeholder="At least 6 characters"
                    className="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                    value={passwords.new}
                    onChange={(e) => setPasswords({ ...passwords, new: e.target.value })}
                    minLength={6}
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    placeholder="Re-enter new password"
                    className="w-full mt-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                    value={passwords.confirm}
                    onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                    minLength={6}
                    required
                  />
                </div>
              </div>
              {pwMsg && (
                <p
                  className={`text-sm font-medium ${pwSuccess ? "text-green-600" : "text-red-500"}`}
                >
                  {pwMsg}
                </p>
              )}
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                Update Password
              </button>
            </form>
          </section>
        )}

        {/* Billing & Plan — only for PaaS mode */}
        {!isSelfHosted && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <CreditCard size={20} className="text-blue-600" />
              <h2 className="text-lg font-bold text-slate-900">Billing & Plan</h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Current Plan
                </label>
                <p className="mt-1">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black ${
                      plan === "enterprise"
                        ? "bg-purple-50 text-purple-600 border border-purple-200"
                        : plan === "pro"
                          ? "bg-blue-50 text-blue-600 border border-blue-200"
                          : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    <Shield size={12} />
                    {planLabel}
                  </span>
                </p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Effective Agent Cap
                </label>
                <p className="text-sm text-slate-900 mt-1 font-semibold">{effectiveAgentCap}</p>
                <p className="text-[11px] text-slate-400 mt-1">{agentCapSource}</p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Resources per Agent
                </label>
                <p className="text-sm text-slate-900 mt-1">
                  {subscription?.vcpu || 2} vCPU /{" "}
                  {subscription?.ram_mb ? subscription.ram_mb / 1024 : 2} GB RAM /{" "}
                  {subscription?.disk_gb || 20} GB SSD
                </p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Status
                </label>
                <p className="mt-1">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                      subscription?.status === "active"
                        ? "bg-green-50 text-green-600 border border-green-200"
                        : "bg-yellow-50 text-yellow-600 border border-yellow-200"
                    }`}
                  >
                    {subscription?.status || "active"}
                  </span>
                </p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Managed Backups
                </label>
                <p className="text-sm text-slate-900 mt-1 font-semibold">
                  {subscription?.managed_backups_enabled ? "Enabled" : "Manual export only"}
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  {subscription?.backup_limit_per_agent == null
                    ? "Unlimited backups per agent"
                    : `${subscription?.backup_limit_per_agent || 0} backups per agent`}
                </p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Backup Storage
                </label>
                <p className="text-sm text-slate-900 mt-1 font-semibold">
                  {subscription?.backup_storage_mb == null
                    ? "Unlimited"
                    : `${subscription?.backup_storage_mb || 0} MB`}
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  Retention: {subscription?.backup_retention_days || 0} days
                </p>
              </div>
            </div>
            {subscription?.agent_limit_source === "admin_override" &&
            ((Number.isInteger(subscription?.base_agent_limit) &&
              subscription.base_agent_limit !== subscription.agent_limit) ||
              profile?.role === "admin") ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-sm font-semibold text-amber-900">Admin override active</p>
                <p className="mt-1 text-sm text-amber-800">
                  Your account is capped at {effectiveAgentCap} agents. The default cap for your
                  role is {defaultAgentCap}.
                </p>
              </div>
            ) : null}
            {subscription?.is_unlimited ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Admin default</p>
                <p className="mt-1 text-sm text-slate-600">
                  Admin accounts are uncapped by default. A finite per-user cap can still be applied
                  from the admin panel when needed.
                </p>
              </div>
            ) : null}
            <div className="flex gap-3 pt-4">
              {plan === "free" && (
                <a
                  href="/pricing"
                  className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all"
                >
                  Upgrade Plan
                  <ExternalLink size={14} />
                </a>
              )}
              {plan !== "free" && (
                <button
                  onClick={handleManageBilling}
                  className="flex items-center gap-2 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-sm font-bold text-slate-900 rounded-xl transition-all"
                >
                  Manage Billing
                  <ExternalLink size={14} />
                </button>
              )}
            </div>
          </section>
        )}

        {/* Self-Hosted Limits — only for self-hosted mode */}
        {isSelfHosted && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <Shield size={20} className="text-blue-600" />
              <h2 className="text-lg font-bold text-slate-900">Usage & Resource Limits</h2>
            </div>
            <p className="text-sm text-slate-400 mb-4">
              Self-hosted mode — admin accounts are uncapped by default, and all other users default
              to 3 agents unless an admin sets an override.
            </p>
            <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-4">
              <p className="text-[10px] text-blue-600 font-bold uppercase tracking-widest">
                Your agent cap
              </p>
              <p className="mt-2 text-2xl font-black text-slate-900">{effectiveAgentCap}</p>
              <p className="mt-1 text-sm font-medium text-slate-600">{agentCapSource}</p>
              {subscription?.agent_limit_source === "admin_override" ? (
                <p className="mt-2 text-sm text-slate-500">
                  Default cap for your role is {defaultAgentCap}. The self-hosted finite-cap ceiling
                  remains {selfHostedMaxAgents} agents.
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">{selfHostedMaxAgents}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                  Finite Cap Ceiling
                </p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">
                  {platformConfig?.selfhosted?.max_vcpu || 16}
                </p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                  Max vCPU
                </p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">
                  {platformConfig?.selfhosted?.max_ram_mb
                    ? Math.round(platformConfig.selfhosted.max_ram_mb / 1024)
                    : 32}{" "}
                  GB
                </p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                  Max RAM
                </p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">
                  {platformConfig?.selfhosted?.max_disk_gb || 500} GB
                </p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                  Max Disk
                </p>
              </div>
            </div>
          </section>
        )}

        <section className="overflow-hidden rounded-2xl border border-brand-cyan/20 bg-brand-ink p-6 shadow-sm">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-cyan/10 text-brand-cyan">
                  <Star size={20} aria-hidden="true" />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-cyan">
                    Open source
                  </p>
                  <h2 className="mt-1 text-lg font-bold text-brand-foreground">Support Nora</h2>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-300">
                If Nora helps you operate your agent fleet, a GitHub star helps other operators find
                the project and follow its releases.
              </p>
            </div>
            <a
              href={NORA_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-gold px-5 py-3 text-sm font-black text-brand-ink transition-colors hover:bg-brand-gold/90 focus:outline-none focus:ring-2 focus:ring-brand-cyan focus:ring-offset-2 focus:ring-offset-brand-ink"
              aria-label="Star Nora on GitHub (opens in a new tab)"
            >
              <Star size={16} aria-hidden="true" />
              Star on GitHub
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </div>
        </section>

        {/* Danger Zone */}
        <section className="bg-red-50 border border-red-200 rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-2">
            <Trash2 size={20} className="text-red-500" />
            <h2 className="text-lg font-bold text-red-600">Danger Zone</h2>
          </div>
          <p className="text-sm text-slate-500">
            Once you delete your account, all your agents and data will be permanently removed. This
            action cannot be undone.
          </p>
          <div className="mt-4 rounded-2xl border border-red-200 bg-white/70 px-4 py-4">
            <p className="text-sm font-bold text-red-700">
              Self-serve account deletion is not available in this build.
            </p>
            <p className="text-sm text-red-700/80 mt-1">
              That dead control has been removed for now so operators do not click into an action
              Nora cannot actually complete yet.
            </p>
          </div>
        </section>
      </div>
    </Layout>
  );
}

function AccountRow({ icon, name, connected }) {
  return (
    <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
      <div className="flex items-center gap-3">
        {icon}
        <span className="text-sm font-medium text-slate-900">{name}</span>
      </div>
      <span
        className={`text-xs font-bold px-3 py-1 rounded-full ${
          connected
            ? "bg-green-50 text-green-600 border border-green-200"
            : "bg-slate-100 text-slate-500"
        }`}
      >
        {connected ? "Connected" : "Not Connected"}
      </span>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#1e293b">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
