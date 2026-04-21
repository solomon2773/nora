import { Loader2, SearchX, WifiOff } from "lucide-react";
import SkillCard, { SkillSummary } from "./SkillCard";

type SkillGridProps = {
  skills: SkillSummary[];
  loading: boolean;
  error: string | null;
  query: string;
  selectedSlug?: string | null;
  installedSlugs?: Set<string>;
  selectedSkillSlugs?: Set<string>;
  selectionBusySlug?: string | null;
  onSelect: (skill: SkillSummary) => void;
  onToggleSelection?: (skill: SkillSummary) => void;
  emptyTitle?: string;
  emptyMessage?: string;
};

function LoadingSkeleton() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="h-4 w-28 animate-pulse rounded bg-slate-200" />
      <div className="mt-2 h-3 w-16 animate-pulse rounded bg-slate-100" />
      <div className="mt-4 h-3 w-full animate-pulse rounded bg-slate-100" />
      <div className="mt-2 h-3 w-5/6 animate-pulse rounded bg-slate-100" />
      <div className="mt-6 h-3 w-24 animate-pulse rounded bg-slate-100" />
    </div>
  );
}

export default function SkillGrid({
  skills,
  loading,
  error,
  query,
  selectedSlug = null,
  installedSlugs,
  selectedSkillSlugs,
  selectionBusySlug = null,
  onSelect,
  onToggleSelection,
  emptyTitle = "No skills found.",
  emptyMessage,
}: SkillGridProps) {
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-500">
          <Loader2 size={16} className="animate-spin text-blue-500" />
          Loading ClawHub skills...
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <LoadingSkeleton key={index} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 px-6 text-center">
        <WifiOff size={28} className="text-amber-500" />
        <h3 className="mt-4 text-base font-black text-amber-900">Could not load skills.</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-amber-700">
          {error || "ClawHub may be unavailable."}
        </p>
      </div>
    );
  }

  if (!skills.length) {
    const message =
      emptyMessage ||
      (query
        ? "No skills found for your search."
        : "ClawHub did not return any skills for the default browse view.");

    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 text-center">
        <SearchX size={28} className="text-slate-400" />
        <h3 className="mt-4 text-base font-black text-slate-800">{emptyTitle}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{message}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {skills.map((skill) => (
        <SkillCard
          key={skill.slug}
          skill={skill}
          selected={selectedSlug === skill.slug}
          installed={installedSlugs?.has(skill.slug) || false}
          selectable={Boolean(onToggleSelection)}
          selectedForAction={selectedSkillSlugs?.has(skill.slug) || false}
          selectionBusy={selectionBusySlug === skill.slug}
          onSelect={onSelect}
          onToggleSelection={onToggleSelection}
        />
      ))}
    </div>
  );
}
