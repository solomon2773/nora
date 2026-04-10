import { useState, useEffect, useRef } from "react";
import Layout from "../../components/layout/Layout";
import LLMSetupWizard from "../../components/agents/LLMSetupWizard";
import {
  User, Lock, CreditCard, Link2, Trash2, Save, Loader2,
  ExternalLink, Shield, Key, Mail, Calendar, BadgeCheck, Edit3, Check, X, Camera
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";
import ActivationChecklist from "../../components/onboarding/ActivationChecklist";

export default function SettingsPage() {
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
  const avatarInputRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      fetchWithAuth("/api/auth/me").then((r) => r.json()),
      fetchWithAuth("/api/billing/subscription").then((r) => r.json()).catch(() => null),
      fetch("/api/config/platform").then((r) => r.json()).catch(() => ({ mode: "selfhosted" })),
    ]).then(([p, s, c]) => {
      setProfile(p);
      setSubscription(s);
      setPlatformConfig(c);
      setNameInput(p?.name || "");
      setLoading(false);
    }).catch(() => setLoading(false));
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
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const memberSince = profile?.created_at ? new Date(profile.created_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  }) : "—";

  return (
    <Layout>
      <div className="max-w-3xl mx-auto space-y-8 pb-12">
        <div>
          <h1 className="text-2xl font-black text-slate-900">Settings</h1>
          <p className="text-sm text-slate-400 mt-1">Manage your account, security, and preferences.</p>
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
                <img src={profile.avatar} alt="Avatar" className="w-16 h-16 rounded-2xl object-cover" />
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
                      if (e.key === "Escape") { setEditingName(false); setNameInput(profile?.name || ""); }
                    }}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40"
                    autoFocus
                  />
                  <button onClick={handleNameSave} disabled={savingName} className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg">
                    {savingName ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  </button>
                  <button onClick={() => { setEditingName(false); setNameInput(profile?.name || ""); }} className="p-1.5 text-slate-400 hover:bg-slate-50 rounded-lg">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-900 truncate">{profile?.name || "Unnamed User"}</h3>
                  <button onClick={() => setEditingName(true)} className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
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
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Role</label>
              <div className="flex items-center gap-1.5 mt-1">
                <BadgeCheck size={14} className={profile?.role === "admin" ? "text-purple-500" : "text-blue-500"} />
                <span className="text-sm font-semibold text-slate-900 capitalize">{profile?.role || "user"}</span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Auth Provider</label>
              <div className="flex items-center gap-1.5 mt-1">
                {profile?.provider === "google" && <GoogleIcon />}
                {profile?.provider === "github" && <GitHubIcon />}
                {isEmailAuth && <Lock size={14} className="text-slate-400" />}
                <span className="text-sm font-semibold text-slate-900 capitalize">{profile?.provider || "Email / Password"}</span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Member Since</label>
              <div className="flex items-center gap-1.5 mt-1">
                <Calendar size={14} className="text-slate-400" />
                <span className="text-sm font-semibold text-slate-900">{memberSince}</span>
              </div>
            </div>
          </div>
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
              <p className="text-xs text-slate-400 mt-0.5">API keys are shared across all your agents. Sync to agents after changes.</p>
            </div>
          </div>
          <LLMSetupWizard compact />
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
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Current Password</label>
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
                  <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">New Password</label>
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
                  <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Confirm Password</label>
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
                <p className={`text-sm font-medium ${pwSuccess ? "text-green-600" : "text-red-500"}`}>
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
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Current Plan</label>
                <p className="mt-1">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black ${
                    plan === "enterprise" ? "bg-purple-50 text-purple-600 border border-purple-200" :
                    plan === "pro" ? "bg-blue-50 text-blue-600 border border-blue-200" :
                    "bg-slate-100 text-slate-500"
                  }`}>
                    <Shield size={12} />
                    {planLabel}
                  </span>
                </p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Agent Limit</label>
                <p className="text-sm text-slate-900 mt-1 font-semibold">{subscription?.agent_limit || 3}</p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Resources per Agent</label>
                <p className="text-sm text-slate-900 mt-1">
                  {subscription?.vcpu || 2} vCPU / {subscription?.ram_mb ? subscription.ram_mb / 1024 : 2} GB RAM / {subscription?.disk_gb || 20} GB SSD
                </p>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Status</label>
                <p className="mt-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                    subscription?.status === "active" ? "bg-green-50 text-green-600 border border-green-200" : "bg-yellow-50 text-yellow-600 border border-yellow-200"
                  }`}>
                    {subscription?.status || "active"}
                  </span>
                </p>
              </div>
            </div>
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
              <h2 className="text-lg font-bold text-slate-900">Resource Limits</h2>
            </div>
            <p className="text-sm text-slate-400 mb-4">Self-hosted mode — limits set by your operator in the server configuration.</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">{platformConfig?.selfhosted?.max_agents || 50}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Max Agents</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">{platformConfig?.selfhosted?.max_vcpu || 16}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Max vCPU</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">{platformConfig?.selfhosted?.max_ram_mb ? Math.round(platformConfig.selfhosted.max_ram_mb / 1024) : 32} GB</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Max RAM</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-slate-900">{platformConfig?.selfhosted?.max_disk_gb || 500} GB</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Max Disk</p>
              </div>
            </div>
          </section>
        )}

        {/* Danger Zone */}
        <section className="bg-red-50 border border-red-200 rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-2">
            <Trash2 size={20} className="text-red-500" />
            <h2 className="text-lg font-bold text-red-600">Danger Zone</h2>
          </div>
          <p className="text-sm text-slate-500">
            Once you delete your account, all your agents and data will be permanently removed. This action cannot be undone.
          </p>
          <div className="mt-4 rounded-2xl border border-red-200 bg-white/70 px-4 py-4">
            <p className="text-sm font-bold text-red-700">Self-serve account deletion is not available in this build.</p>
            <p className="text-sm text-red-700/80 mt-1">That dead control has been removed for now so operators do not click into an action Nora cannot actually complete yet.</p>
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
      <span className={`text-xs font-bold px-3 py-1 rounded-full ${
        connected
          ? "bg-green-50 text-green-600 border border-green-200"
          : "bg-slate-100 text-slate-500"
      }`}>
        {connected ? "Connected" : "Not Connected"}
      </span>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#1e293b">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}
