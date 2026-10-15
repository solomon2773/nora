import { ChevronDown, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { clsx } from "clsx";
import { useI18n } from "../lib/i18n";
import {
  type Workspace,
  getActiveWorkspaceId,
  listWorkspaces,
  setActiveWorkspaceId,
  subscribeToActiveWorkspace,
} from "../lib/workspaceClient";

export default function WorkspaceSwitcher({ className = "" }: { className?: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    listWorkspaces()
      .then((rows) => {
        if (!active) return;
        setWorkspaces(rows);
        const stored = getActiveWorkspaceId();
        const found =
          stored && rows.some((row) => row.id === stored) ? stored : rows[0]?.id || null;
        setActiveId(found);
        if (found && found !== stored) setActiveWorkspaceId(found);
      })
      .catch(() => {
        if (active) setWorkspaces([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => subscribeToActiveWorkspace(setActiveId), []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function selectWorkspace(id: string) {
    setActiveWorkspaceId(id);
    setActiveId(id);
    setOpen(false);
  }

  const active = workspaces.find((w) => w.id === activeId) || null;
  const label = loading ? t("Workspaces") : active?.name || t("Workspaces");

  return (
    <div ref={containerRef} className={clsx("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:border-blue-200 hover:text-blue-700"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown size={12} className={clsx("transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-12 w-72 bg-white border border-slate-200 rounded-2xl shadow-xl p-2 z-[60]">
          <div className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400">
            {t("Workspaces")}
          </div>
          {workspaces.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">
              {loading ? t("Loading workspaces...") : t("No workspaces yet. Create one above.")}
            </div>
          ) : (
            workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                onClick={() => selectWorkspace(workspace.id)}
                className={clsx(
                  "w-full text-left flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-all",
                  workspace.id === activeId
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-700 hover:bg-slate-50",
                )}
              >
                <span className="truncate">{workspace.name}</span>
                {workspace.role && (
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    {workspace.role}
                  </span>
                )}
              </button>
            ))
          )}
          <div className="border-t border-slate-100 mt-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push("/workspaces");
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              <FolderOpen size={14} />
              {t("Manage workspaces")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
