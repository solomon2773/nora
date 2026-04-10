import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  ArrowLeft,
  ArrowDownToLine,
  Bot,
  CheckCircle2,
  FilePlus2,
  FileText,
  Layers3,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import { formatDate, formatCount } from "../../lib/format";

const STATUS_STYLES = {
  pending_review: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  removed: "bg-slate-100 text-slate-700 border-slate-200",
};

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

function buildEditorState(detail) {
  return {
    name: detail?.name || "",
    description: detail?.description || "",
    category: detail?.category || "General",
    slug: detail?.slug || "",
    currentVersion: String(detail?.current_version || 1),
    templateKey: detail?.snapshot?.templateKey || "",
    snapshotKind: detail?.snapshot?.kind || "",
    sandbox: detail?.defaults?.sandbox || "standard",
    vcpu: String(detail?.defaults?.vcpu || 2),
    ram_mb: String(detail?.defaults?.ram_mb || 2048),
    disk_gb: String(detail?.defaults?.disk_gb || 20),
    image: detail?.defaults?.image || "",
    reviewNotes: detail?.review_notes || "",
    files: buildEditableFiles(detail),
  };
}

function firstInspectableFile(detail) {
  return (
    detail?.template?.coreFiles?.find((file) => file.present)?.path ||
    detail?.template?.files?.[0]?.path ||
    ""
  );
}

export default function MarketplaceAdminDetailPage() {
  const router = useRouter();
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionKey, setActionKey] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [form, setForm] = useState(buildEditorState(null));

  const loadDetail = useCallback(async () => {
    if (!router.isReady || !router.query.id) return;
    setLoading(true);
    try {
      const response = await fetchWithAuth(`/api/admin/marketplace/${router.query.id}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load listing detail");
      }

      setDetail(payload);
      setForm(buildEditorState(payload));
      setSelectedFilePath((current) =>
        current && payload.template?.files?.some((file) => file.path === current)
          ? current
          : firstInspectableFile(payload)
      );
    } catch (error) {
      console.error("Failed to load listing detail:", error);
      toast.error(error.message || "Failed to load listing detail");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [router.isReady, router.query.id, toast]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateFile(index, patch) {
    setForm((current) => ({
      ...current,
      files: current.files.map((file, fileIndex) =>
        fileIndex === index ? { ...file, ...patch } : file
      ),
    }));
  }

  function addFile() {
    setForm((current) => ({
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

  function removeFile(index) {
    setForm((current) => {
      const nextFiles = current.files.filter((_, fileIndex) => fileIndex !== index);
      return { ...current, files: nextFiles };
    });
  }

  async function handleSave() {
    if (!detail) return;
    setSaving(true);
    try {
      const response = await fetchWithAuth(`/api/admin/marketplace/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          category: form.category,
          slug: form.slug,
          currentVersion: form.currentVersion,
          templateKey: form.templateKey,
          snapshotKind: form.snapshotKind,
          sandbox: form.sandbox,
          vcpu: form.vcpu,
          ram_mb: form.ram_mb,
          disk_gb: form.disk_gb,
          image: form.image,
          reviewNotes: form.reviewNotes,
          files: form.files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save template");
      }

      setDetail(payload);
      setForm(buildEditorState(payload));
      setSelectedFilePath((current) =>
        current && payload.template?.files?.some((file) => file.path === current)
          ? current
          : firstInspectableFile(payload)
      );
      toast.success("Template updated");
    } catch (error) {
      console.error("Failed to save marketplace template:", error);
      toast.error(error.message || "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  async function changeListingStatus(status) {
    if (!detail) return;
    setActionKey(status);
    try {
      const response = await fetchWithAuth(`/api/admin/marketplace/${detail.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          reviewNotes: form.reviewNotes,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to update listing");
      }

      await loadDetail();
      toast.success(`Listing marked ${status.replace(/_/g, " ")}`);
      return payload;
    } catch (error) {
      console.error("Failed to update listing status:", error);
      toast.error(error.message || "Failed to update listing");
      return null;
    } finally {
      setActionKey("");
    }
  }

  const selectedFile =
    form.files.find((file) => file.path === selectedFilePath) ||
    form.files[0] ||
    null;
  const statusClass =
    STATUS_STYLES[detail?.status] || "bg-slate-100 text-slate-700 border-slate-200";
  const sourceIsPlatform = detail?.source_type === "platform";

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <ArrowLeft size={16} />
            Back to Marketplace
          </Link>

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
            <Loader2 size={34} className="animate-spin text-red-500" />
          </div>
        ) : !detail ? (
          <div className="flex h-80 flex-col items-center justify-center rounded-[2.5rem] border border-dashed border-slate-200 bg-white text-center text-slate-400">
            <ShoppingBag size={34} className="mb-3 opacity-60" />
            <p className="text-sm font-semibold text-slate-600">
              Template not found.
            </p>
          </div>
        ) : (
          <>
            <section className="rounded-[3rem] border border-white/5 bg-slate-950 p-8 text-white shadow-2xl shadow-red-500/10 sm:p-10">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={clsx(
                        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em]",
                        sourceIsPlatform
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-300"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      )}
                    >
                      {sourceIsPlatform ? <ShieldCheck size={12} /> : <Users size={12} />}
                      {sourceIsPlatform ? "Platform Preset" : "Community Template"}
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
              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Template Files
                    </p>
                    {form.files.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => setSelectedFilePath(file.path)}
                        className={clsx(
                          "w-full rounded-2xl border px-4 py-3 text-left transition-all",
                          selectedFilePath === file.path
                            ? "border-red-300 bg-red-50 text-red-700"
                            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-bold">{file.label}</p>
                            <p className="mt-1 text-xs text-slate-500">{file.path}</p>
                          </div>
                          {file.isCore ? (
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
                              Core
                            </span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="rounded-[1.75rem] border border-slate-200 bg-slate-950 p-5 text-slate-100 shadow-inner">
                    {selectedFile ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
                          <div>
                            <p className="text-sm font-bold text-white">{selectedFile.label}</p>
                            <p className="mt-1 text-xs text-slate-400">{selectedFile.path}</p>
                          </div>
                          {selectedFile.isCore ? (
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-300">
                              Core File
                            </span>
                          ) : null}
                        </div>
                        <pre className="mt-5 min-h-[360px] overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-4 text-[13px] leading-6 text-slate-100">
                          {selectedFile.content}
                        </pre>
                      </>
                    ) : (
                      <div className="flex h-full min-h-[320px] items-center justify-center text-sm text-slate-400">
                        No file selected.
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <aside className="space-y-6">
                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Moderation
                  </p>
                  <div className="mt-4 grid grid-cols-1 gap-3">
                    <ActionButton
                      disabled={actionKey === "published"}
                      icon={CheckCircle2}
                      label="Approve Listing"
                      tone="green"
                      onClick={() => changeListingStatus("published")}
                    />
                    <ActionButton
                      disabled={actionKey === "rejected"}
                      icon={XCircle}
                      label="Reject Listing"
                      tone="red"
                      onClick={() => changeListingStatus("rejected")}
                    />
                    <ActionButton
                      disabled={actionKey === "removed"}
                      icon={Trash2}
                      label="Remove Listing"
                      tone="slate"
                      onClick={() => changeListingStatus("removed")}
                    />
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Template Settings
                      </p>
                      <p className="mt-2 text-sm font-medium leading-relaxed text-slate-500">
                        Edit listing metadata, runtime defaults, template key, version, and review notes.
                      </p>
                    </div>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-60"
                    >
                      {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                      Save
                    </button>
                  </div>

                  <div className="mt-5 space-y-4">
                    <Field label="Name" value={form.name} onChange={(value) => updateField("name", value)} />
                    <TextareaField
                      label="Description"
                      value={form.description}
                      onChange={(value) => updateField("description", value)}
                      rows={4}
                    />
                    <Field label="Category" value={form.category} onChange={(value) => updateField("category", value)} />
                    <Field label="Slug" value={form.slug} onChange={(value) => updateField("slug", value)} />
                    <Field
                      label="Template Key"
                      value={form.templateKey}
                      onChange={(value) => updateField("templateKey", value)}
                    />
                    <Field
                      label="Snapshot Kind"
                      value={form.snapshotKind}
                      onChange={(value) => updateField("snapshotKind", value)}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <Field
                        label="Version"
                        value={form.currentVersion}
                        onChange={(value) => updateField("currentVersion", value)}
                        inputMode="numeric"
                      />
                      <SelectField
                        label="Sandbox"
                        value={form.sandbox}
                        onChange={(value) => updateField("sandbox", value)}
                        options={[
                          { value: "standard", label: "Standard" },
                          { value: "nemoclaw", label: "NemoClaw" },
                        ]}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <Field
                        label="vCPU"
                        value={form.vcpu}
                        onChange={(value) => updateField("vcpu", value)}
                        inputMode="numeric"
                      />
                      <Field
                        label="RAM (MB)"
                        value={form.ram_mb}
                        onChange={(value) => updateField("ram_mb", value)}
                        inputMode="numeric"
                      />
                      <Field
                        label="Disk (GB)"
                        value={form.disk_gb}
                        onChange={(value) => updateField("disk_gb", value)}
                        inputMode="numeric"
                      />
                    </div>
                    <Field label="Image" value={form.image} onChange={(value) => updateField("image", value)} />
                    <TextareaField
                      label="Review Notes"
                      value={form.reviewNotes}
                      onChange={(value) => updateField("reviewNotes", value)}
                      rows={4}
                    />
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Metadata
                  </p>
                  <div className="mt-4 space-y-4 text-sm">
                    <MetadataRow label="Price" value={detail.price || "Free"} />
                    <MetadataRow label="Owner" value={detail.owner_name || detail.owner_email || "Nora"} />
                    <MetadataRow label="Bootstrap" value={detail.template?.hasBootstrap ? "Included" : "Not included"} />
                    <MetadataRow label="Snapshot Id" value={detail.snapshot?.id || "unknown"} />
                    <MetadataRow label="Created" value={formatDate(detail.created_at)} />
                    <MetadataRow label="Updated" value={formatDate(detail.updated_at)} />
                  </div>
                </section>

                <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Reports
                  </p>
                  {detail.reports?.length > 0 ? (
                    <div className="mt-4 space-y-3">
                      {detail.reports.map((report) => (
                        <div
                          key={report.id}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                        >
                          <p className="text-sm font-bold text-slate-900">{report.reason}</p>
                          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                            {report.status} {report.reporter_email ? `· ${report.reporter_email}` : ""}
                          </p>
                          {report.details ? (
                            <p className="mt-2 text-sm text-slate-600">{report.details}</p>
                          ) : null}
                          <p className="mt-2 text-xs text-slate-400">
                            {formatDate(report.created_at)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                      No reports for this listing.
                    </div>
                  )}
                </section>
              </aside>
            </div>

            <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-red-500">
                    Editable Template Files
                  </p>
                  <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                    Core files and extras
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
                    Admin edits apply directly to the marketplace template. Core files stay pinned to the expected OpenClaw filenames; extra files can be added or removed here.
                  </p>
                </div>

                <button
                  onClick={addFile}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <FilePlus2 size={16} />
                  Add File
                </button>
              </div>

              <div className="mt-6 space-y-4">
                {form.files.map((file, index) => (
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
                          onChange={(event) => updateFile(index, { path: event.target.value })}
                          readOnly={file.isCore}
                          className={clsx(
                            "w-full rounded-2xl border px-4 py-3 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-red-500",
                            file.isCore
                              ? "border-slate-200 bg-slate-50 text-slate-500"
                              : "border-slate-200 bg-white text-slate-900"
                          )}
                        />
                      </div>

                      {file.isCore ? (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
                          Core File
                        </span>
                      ) : (
                        <button
                          onClick={() => removeFile(index)}
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
                      onChange={(event) => updateFile(index, { content: event.target.value })}
                      rows={12}
                      className="w-full rounded-[1.5rem] border border-slate-200 bg-slate-950 px-4 py-4 font-mono text-sm leading-6 text-slate-100 focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </AdminLayout>
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

function Field({ label, value, onChange, inputMode = "text" }) {
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
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500"
      />
    </label>
  );
}

function TextareaField({ label, value, onChange, rows = 4 }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </span>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500"
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500"
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

function ActionButton({ icon: Icon, label, onClick, disabled, tone }) {
  const toneClass =
    tone === "green"
      ? "border-emerald-100 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
      : tone === "red"
        ? "border-red-100 bg-red-50 text-red-700 hover:bg-red-100"
        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold transition-colors disabled:opacity-60 ${toneClass}`}
    >
      {disabled ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
      {label}
    </button>
  );
}
