import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";

import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const MAX_EDITABLE_BYTES = 1024 * 1024;

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTimestamp(value) {
  if (!value) return "Unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "Unknown";
  }
}

function buildBreadcrumbs(currentPath = "") {
  const segments = String(currentPath || "")
    .split("/")
    .filter(Boolean);

  return segments.map((segment, index) => ({
    label: segment,
    path: segments.slice(0, index + 1).join("/"),
  }));
}

export default function AgentFilesTab({ agentId, agentStatus }) {
  const toast = useToast();
  const uploadInputRef = useRef(null);
  const [roots, setRoots] = useState([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [treeLoading, setTreeLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [activeRootId, setActiveRootId] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [editorValue, setEditorValue] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);

  const activeRoot = useMemo(
    () => roots.find((root) => root.id === activeRootId) || null,
    [roots, activeRootId]
  );
  const breadcrumbs = useMemo(
    () => buildBreadcrumbs(currentPath),
    [currentPath]
  );

  async function loadRoots() {
    setRootsLoading(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/files/roots`);
      const data = await res.json();
      const nextRoots = Array.isArray(data?.roots) ? data.roots : [];
      setRoots(nextRoots);
      if (nextRoots.length > 0) {
        setActiveRootId((current) => current || nextRoots[0].id);
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to load filesystem roots");
    } finally {
      setRootsLoading(false);
    }
  }

  async function loadTree(rootId = activeRootId, nextPath = currentPath) {
    if (!rootId) return;
    setTreeLoading(true);
    try {
      const params = new URLSearchParams({ root: rootId });
      if (nextPath) params.set("path", nextPath);
      const res = await fetchWithAuth(`/api/agents/${agentId}/files/tree?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load files");
      }
      startTransition(() => {
        setEntries(Array.isArray(data?.entries) ? data.entries : []);
      });
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to load files");
    } finally {
      setTreeLoading(false);
    }
  }

  function resetFileSelection() {
    setSelectedFile(null);
    setEditorValue("");
    setEditorDirty(false);
  }

  useEffect(() => {
    if (!agentId) return;
    loadRoots();
  }, [agentId]);

  useEffect(() => {
    if (!activeRootId) return;
    resetFileSelection();
    loadTree(activeRootId, currentPath);
  }, [activeRootId, currentPath]);

  async function openFile(entry) {
    setFileLoading(true);
    try {
      const params = new URLSearchParams({
        root: activeRootId,
        path: entry.path,
      });
      const res = await fetchWithAuth(`/api/agents/${agentId}/files/content?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to read file");
      }

      const bytes = base64ToBytes(data.contentBase64 || "");
      let text = "";
      let isText = false;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        isText = true;
      } catch {
        text = "";
        isText = false;
      }

      setSelectedFile({
        ...data,
        isText,
        text,
        writable: data.writable === true,
      });
      setEditorValue(text);
      setEditorDirty(false);
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to read file");
    } finally {
      setFileLoading(false);
    }
  }

  async function saveFile() {
    if (!selectedFile) return;
    setBusyAction("save");
    try {
      const contentBase64 = bytesToBase64(new TextEncoder().encode(editorValue));
      const res = await fetchWithAuth(`/api/agents/${agentId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: activeRootId,
          path: selectedFile.path,
          contentBase64,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to save file");
      }
      setSelectedFile((current) =>
        current
          ? {
              ...current,
              contentBase64,
              text: editorValue,
              size: new TextEncoder().encode(editorValue).length,
            }
          : current
      );
      setEditorDirty(false);
      toast.success("File saved");
      loadTree();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to save file");
    } finally {
      setBusyAction("");
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusyAction("upload");
    try {
      const res = await fetchWithAuth(
        `/api/agents/${agentId}/files/upload?root=${encodeURIComponent(activeRootId)}&path=${encodeURIComponent(currentPath)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": file.name,
          },
          body: await file.arrayBuffer(),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to upload file");
      }
      toast.success("File uploaded");
      loadTree();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to upload file");
    } finally {
      setBusyAction("");
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
    }
  }

  async function createFolder() {
    const folderName = window.prompt("Folder name");
    if (!folderName) return;
    setBusyAction("mkdir");
    try {
      const targetPath = currentPath ? `${currentPath}/${folderName}` : folderName;
      const res = await fetchWithAuth(`/api/agents/${agentId}/files/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: activeRootId,
          path: targetPath,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to create folder");
      }
      toast.success("Folder created");
      loadTree();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to create folder");
    } finally {
      setBusyAction("");
    }
  }

  async function downloadPath(targetPath = currentPath || selectedFile?.path || "") {
    setBusyAction("download");
    try {
      const params = new URLSearchParams({ root: activeRootId });
      if (targetPath) params.set("path", targetPath);
      const res = await fetchWithAuth(`/api/agents/${agentId}/files/download?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to download path");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/i);
      const filename = match?.[1] || "download.bin";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to download path");
    } finally {
      setBusyAction("");
    }
  }

  async function removeEntry(entry) {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    setBusyAction(`delete:${entry.path}`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: activeRootId,
          path: entry.path,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete path");
      }
      if (selectedFile?.path === entry.path) {
        resetFileSelection();
      }
      toast.success("Path deleted");
      loadTree();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to delete path");
    } finally {
      setBusyAction("");
    }
  }

  if (agentStatus !== "running" && agentStatus !== "warning") {
    return (
      <div className="rounded-[1.75rem] border border-slate-200 bg-white px-6 py-10">
        <div className="max-w-xl">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
            Files
          </p>
          <h3 className="mt-2 text-lg font-black text-slate-900">
            File access is available once the runtime is live.
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            Nora reads the actual runtime filesystem for this tab. Start the agent,
            then return here to browse the workspace, inspect curated system paths,
            export content, or edit files inside the writable workspace.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <input
        ref={uploadInputRef}
        type="file"
        className="hidden"
        onChange={handleUpload}
      />

      <div className="rounded-[1.75rem] border border-slate-200 bg-white px-6 py-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              Live Filesystem
            </p>
            <h3 className="mt-2 text-lg font-black text-slate-900">
              Workspace stays writable. System paths stay visible but locked.
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              Use the workspace root for upload, edit, and delete. Curated runtime
              paths stay browse and download only, so operators can inspect the real
              container state without turning the rest of the filesystem into a write
              surface.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => loadTree()}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 transition-all hover:bg-slate-100"
            >
              {treeLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
            <button
              type="button"
              onClick={() => downloadPath()}
              disabled={busyAction === "download"}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 transition-all hover:bg-slate-100 disabled:opacity-50"
            >
              {busyAction === "download" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              Export Current Path
            </button>
            <button
              type="button"
              onClick={() => uploadInputRef.current?.click()}
              disabled={activeRoot?.access !== "rw" || busyAction === "upload"}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3 py-2 text-xs font-bold text-white transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyAction === "upload" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Upload size={14} />
              )}
              Upload
            </button>
            <button
              type="button"
              onClick={createFolder}
              disabled={activeRoot?.access !== "rw" || busyAction === "mkdir"}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3 py-2 text-xs font-bold text-white transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyAction === "mkdir" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <FolderPlus size={14} />
              )}
              New Folder
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {roots.map((root) => {
          const isActive = root.id === activeRootId;
          return (
            <button
              key={root.id}
              type="button"
              onClick={() => {
                startTransition(() => {
                  setActiveRootId(root.id);
                  setCurrentPath("");
                });
              }}
              className={`rounded-2xl border px-4 py-3 text-left transition-all ${
                isActive
                  ? "border-blue-500 bg-blue-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-center gap-2">
                <HardDrive size={14} className={isActive ? "text-blue-600" : "text-slate-500"} />
                <span className="text-sm font-bold text-slate-900">{root.label}</span>
                <span
                  className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-widest ${
                    root.access === "rw"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {root.access === "rw" ? "RW" : "RO"}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                {root.description}
              </p>
              <p className="mt-2 font-mono text-[11px] text-slate-400">{root.path}</p>
            </button>
          );
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.05fr,0.95fr]">
        <section className="overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              Current Path
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1 text-sm font-bold text-slate-900">
              <button
                type="button"
                onClick={() => setCurrentPath("")}
                className="rounded-lg px-2 py-1 text-blue-700 transition-colors hover:bg-blue-50"
              >
                {activeRoot?.label || "Root"}
              </button>
              {breadcrumbs.map((crumb) => (
                <span key={crumb.path} className="inline-flex items-center gap-1">
                  <ChevronRight size={12} className="text-slate-300" />
                  <button
                    type="button"
                    onClick={() => setCurrentPath(crumb.path)}
                    className="rounded-lg px-2 py-1 text-slate-700 transition-colors hover:bg-slate-100"
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="min-h-[420px]">
            {treeLoading || rootsLoading ? (
              <div className="flex h-full min-h-[420px] items-center justify-center">
                <Loader2 size={22} className="animate-spin text-blue-500" />
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {currentPath ? (
                  <button
                    type="button"
                    onClick={() => {
                      const nextPath = breadcrumbs.slice(0, -1).map((crumb) => crumb.label).join("/");
                      setCurrentPath(nextPath);
                    }}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-slate-50"
                  >
                    <Folder size={16} className="text-slate-400" />
                    <div>
                      <p className="text-sm font-bold text-slate-900">..</p>
                      <p className="text-xs text-slate-500">Up one level</p>
                    </div>
                  </button>
                ) : null}

                {entries.length === 0 ? (
                  <div className="px-5 py-8">
                    <p className="text-sm font-bold text-slate-900">Nothing in this path yet.</p>
                    <p className="mt-1 text-sm text-slate-500">
                      {activeRoot?.access === "rw"
                        ? "Upload a file or create a folder in the workspace to start shaping the runtime."
                        : "This read-only path is currently empty."}
                    </p>
                  </div>
                ) : (
                  entries.map((entry) => (
                    <div
                      key={entry.path}
                      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.type === "directory") {
                            setCurrentPath(entry.path);
                            resetFileSelection();
                            return;
                          }
                          openFile(entry);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        {entry.type === "directory" ? (
                          <Folder size={16} className="shrink-0 text-amber-500" />
                        ) : (
                          <FileText size={16} className="shrink-0 text-slate-400" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900">{entry.name}</p>
                          <p className="text-xs text-slate-500">
                            {entry.type === "directory"
                              ? "Directory"
                              : `${formatBytes(entry.size)} • ${formatTimestamp(entry.mtime)}`}
                          </p>
                        </div>
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => downloadPath(entry.path)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-slate-600 transition-colors hover:bg-slate-100"
                          title="Download"
                        >
                          <Download size={14} />
                        </button>
                        {activeRoot?.access === "rw" ? (
                          <button
                            type="button"
                            onClick={() => removeEntry(entry)}
                            className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-red-600 transition-colors hover:bg-red-100"
                            title="Delete"
                          >
                            {busyAction === `delete:${entry.path}` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              Inspector
            </p>
            {selectedFile ? (
              <>
                <h4 className="mt-2 truncate text-sm font-black text-slate-900">
                  {selectedFile.path}
                </h4>
                <p className="mt-1 text-xs text-slate-500">
                  {formatBytes(selectedFile.size)} • mode {selectedFile.mode} •{" "}
                  {selectedFile.writable ? "workspace-writable" : "read-only root"}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-500">
                Select a file to inspect or edit it.
              </p>
            )}
          </div>

          <div className="min-h-[420px] p-5">
            {fileLoading ? (
              <div className="flex h-full min-h-[360px] items-center justify-center">
                <Loader2 size={22} className="animate-spin text-blue-500" />
              </div>
            ) : !selectedFile ? (
              <div className="max-w-md">
                <p className="text-sm font-bold text-slate-900">
                  Use this panel for the actual file contents.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  Nora reads the live runtime filesystem rather than a synthetic
                  database view. Text files under the workspace can be edited in
                  place. Binary files and read-only system roots stay download only.
                </p>
              </div>
            ) : selectedFile.isText ? (
              <div className="space-y-4">
                <textarea
                  value={editorValue}
                  onChange={(event) => {
                    setEditorValue(event.target.value);
                    setEditorDirty(event.target.value !== selectedFile.text);
                  }}
                  readOnly={!selectedFile.writable || selectedFile.size > MAX_EDITABLE_BYTES}
                  className="min-h-[320px] w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xs text-slate-800 outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={saveFile}
                    disabled={
                      !selectedFile.writable ||
                      selectedFile.size > MAX_EDITABLE_BYTES ||
                      !editorDirty ||
                      busyAction === "save"
                    }
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyAction === "save" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    Save File
                  </button>
                  {selectedFile.size > MAX_EDITABLE_BYTES ? (
                    <p className="text-xs text-amber-600">
                      Inline editing is limited to text files up to 1 MB.
                    </p>
                  ) : !selectedFile.writable ? (
                    <p className="text-xs text-slate-500">
                      This file lives under a read-only root.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      Workspace edits write back to the live runtime path immediately.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="max-w-md">
                <p className="text-sm font-bold text-slate-900">
                  Binary file loaded.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  Nora detected binary or non-UTF-8 content, so this path stays
                  preview-free here. Download it from the file list or export the
                  current folder.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
