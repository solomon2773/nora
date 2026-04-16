import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/router";
import { clsx } from "clsx";
import {
  ArrowDownToLine,
  Bot,
  ChevronLeft,
  Edit3,
  FilePlus2,
  FileText,
  Flag,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import Layout from "../../components/layout/Layout";
import RuntimePathFields from "../../components/RuntimePathFields";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";
import {
  activeExecutionTargetFromConfig,
  activeSandboxOptionFromTarget,
  resolveAgentExecutionTarget,
  resolveAgentSandboxProfile,
  runtimeFamilyFromConfig,
} from "../../lib/runtime";

const REPORT_REASONS = [
  { value: "spam", label: "Spam or low quality" },
  { value: "unsafe", label: "Unsafe or harmful content" },
  { value: "copyright", label: "Copyright or ownership issue" },
  { value: "misleading", label: "Misleading or inaccurate" },
  { value: "other", label: "Other" },
];

const STATUS_STYLES = {
  pending_review: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  removed: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatCount(value) {
  const numeric = Number(value || 0);
  if (numeric >= 1000) return `${(numeric / 1000).toFixed(1)}k`;
  return `${numeric}`;
}

function parseFilename(headerValue, fallbackName) {
  const match = /filename="([^"]+)"/i.exec(headerValue || "");
  return match?.[1] || fallbackName;
}

async function downloadResponseAsFile(response, fallbackName) {
  const blob = await response.blob();
  const filename = parseFilename(
    response.headers.get("content-disposition"),
    fallbackName
  );
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

function firstInspectableFile(detail) {
  return (
    detail?.template?.coreFiles?.find((file) => file.present)?.path ||
    detail?.template?.files?.[0]?.path ||
    ""
  );
}

function buildEditableFiles(detail) {
  const corePathSet = new Set(
    (detail?.template?.coreFiles || []).map((file) => file.path)
  );

  return (detail?.template?.files || []).map((file) => ({
    path: file.path,
    content: file.content || "",
    label: file.label || file.path,
    isCore: corePathSet.has(file.path),
  }));
}

function buildOwnerEditorState(detail) {
  return {
    name: detail?.name || "",
    description: detail?.description || "",
    category: detail?.category || "General",
    slug: detail?.slug || "",
    currentVersion: String(detail?.current_version || 1),
    sandbox: detail?.defaults?.sandbox || "standard",
    vcpu: String(detail?.defaults?.vcpu || 2),
    ram_mb: String(detail?.defaults?.ram_mb || 2048),
    disk_gb: String(detail?.defaults?.disk_gb || 20),
    image: detail?.defaults?.image || "",
    files: buildEditableFiles(detail),
  };
}

export default function MarketplaceTemplateDetail() {
  const router = useRouter();
  const toast = useToast();
  const [currentUser, setCurrentUser] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [installName, setInstallName] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installExecutionTarget, setInstallExecutionTarget] = useState("");
  const [installSandboxProfile, setInstallSandboxProfile] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("spam");
  const [reportDetails, setReportDetails] = useState("");
  const [reporting, setReporting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editor, setEditor] = useState(buildOwnerEditorState(null));
  const [backendConfig, setBackendConfig] = useState(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchWithAuth("/api/auth/me")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/config/backends")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ]).then(([payload, config]) => {
      if (cancelled) return;
      setCurrentUser(payload || null);
      setBackendConfig(config);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadDetail = useCallback(async () => {
    if (!router.isReady || !router.query.id) return;
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/api/marketplace/${router.query.id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load template");
      }

      setDetail(data);
      setInstallName(data.name || "");
      setEditor(buildOwnerEditorState(data));
      setSelectedFilePath((current) =>
        current && data.template?.files?.some((file) => file.path === current)
          ? current
          : firstInspectableFile(data)
      );
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to load template");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [router.isReady, router.query.id, toast]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  async function handleDownload() {
    if (!detail) return;
    setDownloading(true);
    try {
      const res = await fetchWithAuth(`/api/marketplace/${detail.id}/download`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to download template");
      }

      const fallbackName = `${detail.slug || detail.name || "nora-template"}.nora-template.json`;
      await downloadResponseAsFile(res, fallbackName);
      toast.success("Template downloaded");
      await loadDetail();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to download template");
    } finally {
      setDownloading(false);
    }
  }

  async function handleInstall() {
    if (!detail) return;
    const trimmedName = installName.trim();
    if (!trimmedName) {
      toast.error("Agent name is required");
      return;
    }

    setInstalling(true);
    try {
      const res = await fetchWithAuth("/api/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: detail.id,
          name: trimmedName,
          runtime_family: runtimeFamilyFromConfig(backendConfig)?.id || "openclaw",
          deploy_target: installExecutionTarget,
          sandbox_profile: installSandboxProfile || "standard",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to install template");
      }

      toast.success("Template install queued");
      window.location.href = data?.id ? `/app/agents/${data.id}` : "/app/agents";
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to install template");
    } finally {
      setInstalling(false);
    }
  }

  function openInstallDialog() {
    const templateRuntime = {
      backend_type: detail?.defaults?.backend || null,
      sandbox_type: detail?.defaults?.sandbox || "standard",
      deploy_target: detail?.defaults?.deploy_target || null,
      sandbox_profile: detail?.defaults?.sandbox_profile || null,
    };

    setInstallName(detail?.name || "");
    setInstallExecutionTarget(resolveAgentExecutionTarget(templateRuntime));
    setInstallSandboxProfile(resolveAgentSandboxProfile(templateRuntime));
    setInstallOpen(true);
  }

  async function handleReport() {
    if (!detail) return;
    setReporting(true);
    try {
      const res = await fetchWithAuth(`/api/marketplace/${detail.id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reportReason,
          details: reportDetails.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to report listing");
      }

      toast.success("Listing reported");
      setReportOpen(false);
      setReportReason("spam");
      setReportDetails("");
      await loadDetail();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to report listing");
    } finally {
      setReporting(false);
    }
  }

  function updateEditorField(field, value) {
    setEditor((current) => ({ ...current, [field]: value }));
  }

  function updateEditorFile(index, patch) {
    setEditor((current) => ({
      ...current,
      files: current.files.map((file, fileIndex) =>
        fileIndex === index ? { ...file, ...patch } : file
      ),
    }));
  }

  function addEditorFile() {
    setEditor((current) => ({
      ...current,
      files: [
        ...current.files,
        {
          path: `notes/${Date.now().toString(36)}.md`,
          content: "",
          label: "Extra File",
          isCore: false,
        },
      ],
    }));
  }

  function removeEditorFile(index) {
    setEditor((current) => ({
      ...current,
      files: current.files.filter((_, fileIndex) => fileIndex !== index),
    }));
  }

  async function handleOwnerSave() {
    if (!detail) return;
    setEditorSaving(true);
    try {
      const res = await fetchWithAuth(`/api/marketplace/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editor.name,
          description: editor.description,
          category: editor.category,
          slug: editor.slug,
          currentVersion: editor.currentVersion,
          sandbox: editor.sandbox,
          vcpu: editor.vcpu,
          ram_mb: editor.ram_mb,
          disk_gb: editor.disk_gb,
          image: editor.image,
          files: editor.files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to update listing");
      }

      setDetail(data);
      setEditor(buildOwnerEditorState(data));
      setInstallName(data.name || "");
      setSelectedFilePath((current) =>
        current && data.template?.files?.some((file) => file.path === current)
          ? current
          : firstInspectableFile(data)
      );
      setEditorOpen(false);
      toast.success("Changes saved and sent for review");
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to update listing");
    } finally {
      setEditorSaving(false);
    }
  }

  const coreFiles = detail?.template?.coreFiles?.filter((file) => file.present) || [];
  const selectedFile =
    detail?.template?.files?.find((file) => file.path === selectedFilePath) ||
    coreFiles[0] ||
    null;
  const corePathSet = new Set(coreFiles.map((file) => file.path));
  const extraFiles =
    detail?.template?.files?.filter((file) => !corePathSet.has(file.path)) || [];
  const isOwner =
    detail?.source_type === "community" &&
    Boolean(currentUser?.id) &&
    detail?.owner_user_id === currentUser.id;
  const showReport =
    detail?.source_type === "community" &&
    detail?.status === "published" &&
    Boolean(currentUser?.id) &&
    !isOwner;
  const isPreset = detail?.source_type === "platform";
  const statusClass =
    STATUS_STYLES[detail?.status] || "bg-slate-100 text-slate-700 border-slate-200";
  const installActiveExecutionTarget = activeExecutionTargetFromConfig(
    backendConfig,
    installExecutionTarget
  );
  const installActiveSandboxOption = activeSandboxOptionFromTarget(
    installActiveExecutionTarget,
    installSandboxProfile
  );
  const canInstall = Boolean(
    backendConfig && installActiveSandboxOption?.available
  );

  return (
    <Layout>
      <div className="flex flex-col gap-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <a
            href="/app/marketplace"
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <ChevronLeft size={16} />
            Back to marketplace
          </a>

          <button
            onClick={loadDetail}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="flex h-96 items-center justify-center rounded-[2.5rem] border border-dashed border-slate-200 bg-white">
            <Loader2 size={34} className="animate-spin text-blue-500" />
          </div>
        ) : !detail ? (
          <div className="flex h-80 flex-col items-center justify-center rounded-[2.5rem] border border-dashed border-slate-200 bg-white text-center text-slate-400">
            <Bot size={34} className="mb-3 opacity-60" />
            <p className="text-sm font-semibold text-slate-600">
              Template not found.
            </p>
          </div>
        ) : (
          <>
            <section className="rounded-[3rem] border border-white/5 bg-slate-900 p-8 text-white shadow-2xl shadow-blue-500/10 sm:p-10">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={clsx(
                        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em]",
                        isPreset
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-300"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      )}
                    >
                      {isPreset ? <ShieldCheck size={12} /> : <Users size={12} />}
                      {isPreset ? "Platform Preset" : "Community Template"}
                    </span>
                    <span className={clsx("inline-flex rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em]", statusClass)}>
                      {String(detail.status || "unknown").replace(/_/g, " ")}
                    </span>
                  </div>

                  <h1 className="mt-5 text-4xl font-black tracking-tight text-white sm:text-5xl">
                    {detail.name}
                  </h1>
                  <p className="mt-4 text-lg font-medium leading-relaxed text-slate-300">
                    {detail.description}
                  </p>

                  <div className="mt-6 flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-300">
                    <span>{detail.category || "General"}</span>
                    <span>&bull;</span>
                    <span>v{detail.current_version || 1}</span>
                    <span>&bull;</span>
                    <span>{detail.owner_name || detail.owner_email || "Nora"}</span>
                    {detail.snapshot?.templateKey ? (
                      <>
                        <span>&bull;</span>
                        <span>{detail.snapshot.templateKey}</span>
                      </>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:min-w-[360px]">
                  <HeroMetric icon={Bot} label="Installs" value={formatCount(detail.installs)} />
                  <HeroMetric
                    icon={ArrowDownToLine}
                    label="Downloads"
                    value={formatCount(detail.downloads)}
                  />
                  <HeroMetric
                    icon={Layers3}
                    label="Core Files"
                    value={`${detail.template?.presentRequiredCoreCount || 0}/${detail.template?.requiredCoreCount || 7}`}
                  />
                  <HeroMetric
                    icon={FileText}
                    label="Files"
                    value={`${detail.template?.fileCount || 0}`}
                  />
                </div>
              </div>
            </section>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.5fr)_380px]">
              <div className="space-y-6">
                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600">
                        Template Summary
                      </p>
                      <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                        OpenClaw core files included
                      </h2>
                      <p className="mt-2 text-sm font-medium leading-relaxed text-slate-500">
                        Inspect the markdown files that will be installed into the agent template. This view does not change download counts.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <InfoMetric
                        label="Sandbox"
                        value={detail.defaults?.sandbox || "standard"}
                      />
                      <InfoMetric
                        label="Specs"
                        value={`${detail.defaults?.vcpu || 2} vCPU / ${Math.round((detail.defaults?.ram_mb || 2048) / 1024)} GB / ${detail.defaults?.disk_gb || 20} GB`}
                      />
                      <InfoMetric
                        label="Extra Files"
                        value={`${detail.template?.extraFilesCount || 0}`}
                      />
                      <InfoMetric
                        label="Bootstrap"
                        value={detail.template?.hasBootstrap ? "Included" : "Not included"}
                      />
                    </div>
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
                    <div className="space-y-2">
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Core Files
                      </p>
                      {coreFiles.map((file) => (
                        <button
                          key={file.path}
                          onClick={() => setSelectedFilePath(file.path)}
                          className={clsx(
                            "w-full rounded-2xl border px-4 py-3 text-left transition-all",
                            selectedFilePath === file.path
                              ? "border-blue-500 bg-blue-50 text-blue-700"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          )}
                        >
                          <p className="text-sm font-bold">{file.label}</p>
                          <p className="mt-1 text-xs text-slate-500">{file.path}</p>
                        </button>
                      ))}

                      {extraFiles.length > 0 ? (
                        <>
                          <p className="pt-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                            Additional Files
                          </p>
                          {extraFiles.map((file) => (
                            <button
                              key={file.path}
                              onClick={() => setSelectedFilePath(file.path)}
                              className={clsx(
                                "w-full rounded-2xl border px-4 py-3 text-left transition-all",
                                selectedFilePath === file.path
                                  ? "border-slate-900 bg-slate-50 text-slate-900"
                                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                              )}
                            >
                              <p className="text-sm font-bold">{file.path}</p>
                              <p className="mt-1 text-xs text-slate-500">{file.lineCount} lines</p>
                            </button>
                          ))}
                        </>
                      ) : null}
                    </div>

                    <div className="rounded-[1.75rem] border border-slate-200 bg-slate-950 p-5 text-slate-100 shadow-inner">
                      {selectedFile ? (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
                            <div>
                              <p className="text-sm font-bold text-white">{selectedFile.label}</p>
                              <p className="mt-1 text-xs text-slate-400">{selectedFile.path}</p>
                            </div>
                            <div className="text-right text-xs text-slate-400">
                              <p>{selectedFile.lineCount} lines</p>
                              <p>{selectedFile.bytes} bytes</p>
                            </div>
                          </div>
                          <pre className="mt-5 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-4 text-[13px] leading-6 text-slate-100">
                            {selectedFile.content}
                          </pre>
                        </>
                      ) : (
                        <div className="flex h-full min-h-[320px] items-center justify-center text-sm text-slate-400">
                          No file preview available.
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {isOwner && editorOpen ? (
                  <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600">
                          Owner Editor
                        </p>
                        <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                          Update your listing and resubmit
                        </h2>
                        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                          Editing a community listing sends the updated template back through review. Core files stay pinned to the OpenClaw filenames, and extra files can be added or removed.
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={addEditorFile}
                          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          <FilePlus2 size={16} />
                          Add File
                        </button>
                        <button
                          onClick={handleOwnerSave}
                          disabled={editorSaving}
                          className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-600 disabled:opacity-60"
                        >
                          {editorSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                          Save and Resubmit
                        </button>
                      </div>
                    </div>

                    <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
                      <div className="space-y-4">
                        <EditorField
                          label="Name"
                          value={editor.name}
                          onChange={(value) => updateEditorField("name", value)}
                        />
                        <EditorTextarea
                          label="Description"
                          value={editor.description}
                          onChange={(value) => updateEditorField("description", value)}
                          rows={4}
                        />
                        <EditorField
                          label="Category"
                          value={editor.category}
                          onChange={(value) => updateEditorField("category", value)}
                        />
                        <EditorField
                          label="Slug"
                          value={editor.slug}
                          onChange={(value) => updateEditorField("slug", value)}
                        />
                        <div className="grid grid-cols-2 gap-4">
                          <EditorField
                            label="Version"
                            value={editor.currentVersion}
                            onChange={(value) => updateEditorField("currentVersion", value)}
                            inputMode="numeric"
                          />
                          <EditorSelect
                            label="Sandbox"
                            value={editor.sandbox}
                            onChange={(value) => updateEditorField("sandbox", value)}
                            options={[
                              { value: "standard", label: "Standard" },
                              { value: "nemoclaw", label: "NemoClaw" },
                            ]}
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-4">
                          <EditorField
                            label="vCPU"
                            value={editor.vcpu}
                            onChange={(value) => updateEditorField("vcpu", value)}
                            inputMode="numeric"
                          />
                          <EditorField
                            label="RAM (MB)"
                            value={editor.ram_mb}
                            onChange={(value) => updateEditorField("ram_mb", value)}
                            inputMode="numeric"
                          />
                          <EditorField
                            label="Disk (GB)"
                            value={editor.disk_gb}
                            onChange={(value) => updateEditorField("disk_gb", value)}
                            inputMode="numeric"
                          />
                        </div>
                        <EditorField
                          label="Image"
                          value={editor.image}
                          onChange={(value) => updateEditorField("image", value)}
                        />
                      </div>

                      <div className="space-y-4">
                        {editor.files.map((file, index) => (
                          <div
                            key={`${file.path}:${index}`}
                            className="rounded-[1.5rem] border border-slate-200 p-5"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex-1">
                                <label className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                                  File Path
                                </label>
                                <input
                                  type="text"
                                  value={file.path}
                                  onChange={(event) =>
                                    updateEditorFile(index, { path: event.target.value })
                                  }
                                  readOnly={file.isCore}
                                  className={clsx(
                                    "w-full rounded-2xl border px-4 py-3 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500",
                                    file.isCore
                                      ? "border-slate-200 bg-slate-50 text-slate-500"
                                      : "border-slate-200 bg-white text-slate-900"
                                  )}
                                />
                              </div>

                              {file.isCore ? (
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
                                  Core
                                </span>
                              ) : (
                                <button
                                  onClick={() => removeEditorFile(index)}
                                  className="inline-flex items-center gap-2 rounded-2xl border border-red-100 px-4 py-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50"
                                >
                                  <Trash2 size={15} />
                                  Remove
                                </button>
                              )}
                            </div>

                            <label className="mt-4 mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                              Content
                            </label>
                            <textarea
                              value={file.content}
                              rows={10}
                              onChange={(event) =>
                                updateEditorFile(index, { content: event.target.value })
                              }
                              className="w-full rounded-[1.5rem] border border-slate-200 bg-slate-950 px-4 py-4 font-mono text-sm leading-6 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                ) : null}

                {detail.template?.memoryFiles?.length > 0 ? (
                  <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Memory Files
                    </p>
                    <div className="mt-4 grid grid-cols-1 gap-3">
                      {detail.template.memoryFiles.map((file) => (
                        <div
                          key={file.path}
                          className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                        >
                          <p className="text-sm font-bold text-slate-900">{file.path}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {file.lineCount} lines · {file.bytes} bytes
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>

              <aside className="space-y-6">
                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Actions
                  </p>
                  <div className="mt-4 grid grid-cols-1 gap-3">
                    {isOwner ? (
                      <button
                        onClick={() => setEditorOpen((current) => !current)}
                        className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800 transition-colors hover:bg-slate-50"
                      >
                        <Edit3 size={16} />
                        {editorOpen ? "Close Editor" : "Edit Listing"}
                      </button>
                    ) : null}
                    <button
                      onClick={openInstallDialog}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-600"
                    >
                      <Plus size={16} />
                      Install as New Agent
                    </button>
                    <button
                      onClick={handleDownload}
                      disabled={downloading}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50"
                    >
                      {downloading ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />}
                      Download Template JSON
                    </button>
                    {showReport ? (
                      <button
                        onClick={() => setReportOpen(true)}
                        className="inline-flex items-center justify-center gap-2 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 transition-colors hover:bg-red-100"
                      >
                        <Flag size={16} />
                        Report Listing
                      </button>
                    ) : null}
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Metadata
                  </p>
                  <div className="mt-4 space-y-4 text-sm">
                    <MetadataRow label="Source" value={isPreset ? "Platform preset" : "Community"} />
                    <MetadataRow label="Status" value={String(detail.status || "unknown").replace(/_/g, " ")} />
                    <MetadataRow label="Category" value={detail.category || "General"} />
                    <MetadataRow label="Price" value={detail.price || "Free"} />
                    <MetadataRow label="Owner" value={detail.owner_name || detail.owner_email || "Nora"} />
                    <MetadataRow label="Version" value={`v${detail.current_version || 1}`} />
                    <MetadataRow label="Template Key" value={detail.snapshot?.templateKey || "Not set"} />
                    <MetadataRow label="Snapshot Kind" value={detail.snapshot?.kind || "unknown"} />
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}

        <InstallTemplateDialog
          item={detail}
          name={installName}
          loading={installing}
          backendConfig={backendConfig}
          viewerRole={currentUser?.role || "user"}
          executionTarget={installExecutionTarget}
          sandboxProfile={installSandboxProfile}
          onExecutionTargetChange={setInstallExecutionTarget}
          onSandboxProfileChange={setInstallSandboxProfile}
          canConfirm={canInstall}
          onCancel={() => {
            if (installing) return;
            setInstallOpen(false);
          }}
          onConfirm={handleInstall}
          onNameChange={setInstallName}
          open={installOpen}
        />

        <ReportListingDialog
          item={detail}
          reason={reportReason}
          details={reportDetails}
          loading={reporting}
          open={reportOpen}
          onReasonChange={setReportReason}
          onDetailsChange={setReportDetails}
          onCancel={() => {
            if (reporting) return;
            setReportOpen(false);
          }}
          onConfirm={handleReport}
        />
      </div>
    </Layout>
  );
}

function HeroMetric({ icon: Icon, label, value }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4">
      <div className="flex items-center gap-2 text-slate-400">
        <Icon size={16} />
        <p className="text-[10px] font-black uppercase tracking-[0.16em]">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-black text-white">{value}</p>
    </div>
  );
}

function InfoMetric({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}

function MetadataRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </p>
      <p className="max-w-[60%] text-right font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function EditorField({ label, value, onChange, inputMode = "text" }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </span>
      <input
        type="text"
        value={value}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </label>
  );
}

function EditorTextarea({ label, value, onChange, rows = 4 }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </span>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </label>
  );
}

function EditorSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function InstallTemplateDialog({
  item,
  name,
  loading,
  backendConfig,
  viewerRole,
  executionTarget,
  sandboxProfile,
  onExecutionTargetChange,
  onSandboxProfileChange,
  canConfirm,
  onCancel,
  onConfirm,
  onNameChange,
  open,
}) {
  if (!open || !item) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-template-dialog-title"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
            <Plus size={18} className="text-blue-600" />
          </div>
          <div className="flex-1">
            <h3
              id="install-template-dialog-title"
              className="text-lg font-bold text-slate-900"
            >
              Install Template
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">
              {item.name} will be turned into a new queued agent in your fleet, including the OpenClaw core markdown files shown on this page.
            </p>
          </div>
          <button onClick={onCancel} disabled={loading} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500">Template</p>
          <p className="mt-1 text-base font-bold text-slate-900">{item.name}</p>
          <p className="mt-2 text-sm text-slate-500">{item.description}</p>
        </div>

        <div className="mt-5">
          <label
            htmlFor="install-template-agent-name"
            className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400"
          >
            New Agent Name
          </label>
          <input
            id="install-template-agent-name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="mt-5">
          <RuntimePathFields
            backendConfig={backendConfig}
            viewerRole={viewerRole}
            executionTarget={executionTarget}
            sandboxProfile={sandboxProfile}
            onExecutionTargetChange={onExecutionTargetChange}
            onSandboxProfileChange={onSandboxProfileChange}
            disabled={loading}
          />
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl bg-slate-100 px-5 py-2.5 text-sm font-bold text-slate-700 transition-all hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !name.trim() || !canConfirm}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Install
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportListingDialog({
  item,
  reason,
  details,
  loading,
  open,
  onReasonChange,
  onDetailsChange,
  onCancel,
  onConfirm,
}) {
  if (!open || !item) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
            <Flag size={18} className="text-red-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-slate-900">Report Listing</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">
              Flag this community listing for admin review.
            </p>
          </div>
          <button onClick={onCancel} disabled={loading} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Reason
            </label>
            <select
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              {REPORT_REASONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Details
            </label>
            <textarea
              rows={5}
              value={details}
              onChange={(e) => onDetailsChange(e.target.value)}
              className="w-full resize-none rounded-lg border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl bg-slate-100 px-5 py-2.5 text-sm font-bold text-slate-700 transition-all hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-red-700 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Flag size={14} />}
            Submit Report
          </button>
        </div>
      </div>
    </div>
  );
}
