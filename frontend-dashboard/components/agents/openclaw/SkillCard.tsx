import { ArrowUpRight, Check, Download, Plus, Star } from "lucide-react";

export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  downloads: number | null;
  stars: number | null;
  updatedAt: string | null;
};

type SkillCardProps = {
  skill: SkillSummary;
  selected?: boolean;
  installed?: boolean;
  onSelect: (skill: SkillSummary) => void;
  selectable?: boolean;
  selectionBusy?: boolean;
  selectedForAction?: boolean;
  onToggleSelection?: (skill: SkillSummary) => void;
};

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function formatUpdatedAt(value: string | null) {
  if (!value) return "Unknown update";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown update";
  return `Updated ${parsed.toLocaleDateString()}`;
}

export default function SkillCard({
  skill,
  selected = false,
  installed = false,
  onSelect,
  selectable = false,
  selectionBusy = false,
  selectedForAction = false,
  onToggleSelection,
}: SkillCardProps) {
  const showStats = typeof skill.downloads === "number" || typeof skill.stars === "number";

  return (
    <div
      className={`group flex h-full flex-col rounded-2xl border p-4 text-left shadow-sm transition-all ${
        selected
          ? "border-blue-300 bg-blue-50/70"
          : "border-slate-200 bg-white hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(skill)}
        className="flex flex-1 flex-col text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-black text-slate-900">{skill.name || skill.slug}</div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              {skill.slug}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {installed ? (
              <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-700">
                Installed
              </span>
            ) : null}
            <ArrowUpRight
              size={16}
              className="mt-0.5 text-slate-300 transition-colors group-hover:text-blue-500"
            />
          </div>
        </div>

        <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">
          {skill.description || "No description provided by ClawHub."}
        </p>

        {showStats ? (
          <div className="mt-4 flex items-center gap-4 text-xs font-semibold text-slate-500">
            {typeof skill.downloads === "number" ? (
              <span className="inline-flex items-center gap-1.5">
                <Download size={12} className="text-slate-400" />
                {formatCompactNumber(skill.downloads)}
              </span>
            ) : null}
            {typeof skill.stars === "number" ? (
              <span className="inline-flex items-center gap-1.5">
                <Star size={12} className="text-amber-500" />
                {formatCompactNumber(skill.stars)}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 text-xs text-slate-400">{formatUpdatedAt(skill.updatedAt)}</div>
      </button>

      {selectable && onToggleSelection ? (
        <button
          type="button"
          onClick={() => onToggleSelection(skill)}
          disabled={selectionBusy}
          className={`mt-4 inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-black transition-colors ${
            selectedForAction
              ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
              : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          } disabled:opacity-60`}
        >
          {selectedForAction ? <Check size={14} /> : <Plus size={14} />}
          {selectionBusy ? "Updating..." : selectedForAction ? "Selected" : "Add to selection"}
        </button>
      ) : null}
    </div>
  );
}
