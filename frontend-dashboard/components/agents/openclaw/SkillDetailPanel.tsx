import type { ReactNode } from "react";
import {
  ChevronLeft,
  Download,
  Star,
  Box,
  Cpu,
  FileText,
  Lock,
  CircleAlert,
  Check,
  Plus,
} from "lucide-react";

export type SkillRequirementItem = {
  kind?: string;
  package?: string;
  name?: string;
};

export type SkillRequirements = {
  bins?: string[];
  env?: string[];
  config?: string[];
  install?: SkillRequirementItem[];
};

export type SkillDetail = {
  slug: string;
  name: string;
  description: string;
  downloads: number;
  stars: number;
  updatedAt: string;
  author?: string;
  pagePath?: string;
  installedAt?: string;
  readme?: string;
  requirements?: SkillRequirements | null;
};

export type SkillDetailActionState = {
  label: string;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  onAction?: () => void;
};

type SkillDetailPanelProps = {
  skill: SkillDetail | null;
  detail?: SkillDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  action?: SkillDetailActionState;
};

function formatCount(value: number | undefined) {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (safeValue >= 1000000) return `${(safeValue / 1000000).toFixed(1)}M`;
  if (safeValue >= 1000) return `${Math.round(safeValue / 100) / 10}K`;
  return `${safeValue}`;
}

function RequirementChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-xs font-medium text-slate-700">{value}</p>
    </div>
  );
}

function renderInline(text: string) {
  const tokens: Array<string | ReactNode> = [];
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > lastIndex) {
      tokens.push(text.slice(lastIndex, index));
    }

    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push(
        <code
          key={`inline-code-${key++}`}
          className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-800 ring-1 ring-slate-200"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push(<strong key={`inline-strong-${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push(<em key={`inline-em-${key++}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const labelEnd = token.indexOf("](");
      const label = token.slice(1, labelEnd);
      const href = token.slice(labelEnd + 2, -1);
      tokens.push(
        <a
          key={`inline-link-${key++}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-sky-600 underline decoration-sky-200 underline-offset-2 hover:text-sky-700"
        >
          {label}
        </a>,
      );
    } else {
      tokens.push(token);
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens;
}

function MarkdownView({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<ReactNode> = [];

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre
          key={`md-code-${key++}`}
          className="mb-3 overflow-x-auto rounded-xl bg-slate-900 p-4 font-mono text-xs text-slate-100"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^#{1,3}\s+/.test(trimmed)) {
      const level = Math.min(trimmed.match(/^#{1,3}/)?.[0].length || 1, 3);
      const content = trimmed.replace(/^#{1,3}\s+/, "");
      const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      const className =
        level === 1
          ? "mb-3 text-2xl font-black tracking-tight text-slate-900"
          : level === 2
            ? "mb-2 mt-5 text-lg font-bold text-slate-900"
            : "mb-2 mt-4 text-base font-bold text-slate-900";
      blocks.push(
        <Tag key={`md-heading-${key++}`} className={className}>
          {renderInline(content)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={`md-quote-${key++}`}
          className="mb-3 border-l-4 border-sky-200 pl-4 italic text-slate-600"
        >
          <p className="text-sm leading-6">{renderInline(quoteLines.join(" "))}</p>
        </blockquote>,
      );
      continue;
    }

    if (/^(\s*[-*]\s+)/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*[-*]\s+)/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`md-ul-${key++}`} className="mb-3 ml-5 list-disc space-y-1 text-sm text-slate-700">
          {items.map((item, idx) => (
            <li key={idx} className="leading-6 text-slate-700">
              {renderInline(item)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol
          key={`md-ol-${key++}`}
          className="mb-3 ml-5 list-decimal space-y-1 text-sm text-slate-700"
        >
          {items.map((item, idx) => (
            <li key={idx} className="leading-6 text-slate-700">
              {renderInline(item)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^(\s*[-*]\s+)/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("```")
    ) {
      paragraphLines.push(lines[i].trim());
      i += 1;
    }

    blocks.push(
      <p key={`md-p-${key++}`} className="mb-3 text-sm leading-6 text-slate-700">
        {renderInline(paragraphLines.join(" "))}
      </p>,
    );
  }

  return <div className="space-y-0">{blocks}</div>;
}

export default function SkillDetailPanel({
  skill,
  detail,
  loading,
  error,
  onClose,
  action,
}: SkillDetailPanelProps) {
  const activeSkill = detail || skill;
  const helperText = action
    ? action.label.toLowerCase().includes("selection")
      ? "Use this action to add or remove the skill from the deploy selection."
      : "This action is controlled by the current flow."
    : "Install is disabled in Phase 1. This panel is read-only while we finish the browse and detail experience.";

  return (
    <aside className="lg:sticky lg:top-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-600">
              Skill Detail
            </p>
            <h4 className="mt-1 text-lg font-black text-slate-900">
              {activeSkill?.name || "Select a skill to inspect"}
            </h4>
          </div>
          {activeSkill ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-100"
            >
              <ChevronLeft size={12} />
              Close
            </button>
          ) : null}
        </div>

        {!activeSkill ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
            <FileText size={24} className="mx-auto text-slate-300" />
            <p className="mt-3 text-sm font-bold text-slate-700">
              Pick a card to open the README and requirements.
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              The detail panel is read-only in Phase 1. Install actions will unlock in a later
              phase.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  {activeSkill.slug}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                  <Download size={11} className="text-slate-400" />
                  {formatCount(activeSkill.downloads)} downloads
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                  <Star size={11} className="text-amber-500" />
                  {formatCount(activeSkill.stars)} stars
                </span>
              </div>
              <p className="text-sm leading-6 text-slate-600">
                {activeSkill.description || "No description provided."}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
                <Lock size={14} className="text-slate-400" />
                Install
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">{helperText}</p>
              <button
                type="button"
                onClick={action?.onClick || action?.onAction}
                disabled={action ? action.disabled || action.loading : true}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-80 bg-slate-300 text-slate-500"
              >
                {action?.loading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {action.label}
                  </span>
                ) : action ? (
                  action.disabled ? (
                    <>
                      <Lock size={12} />
                      {action.label}
                    </>
                  ) : (
                    <>
                      {action.label === "Add to selection" ? (
                        <Plus size={12} />
                      ) : (
                        <Check size={12} />
                      )}
                      {action.label}
                    </>
                  )
                ) : (
                  <>
                    <Lock size={12} />
                    Install
                  </>
                )}
              </button>
            </div>

            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <div className="flex items-start gap-2">
                  <CircleAlert size={16} className="mt-0.5 shrink-0 text-red-500" />
                  <div>
                    <p className="font-bold text-red-800">Could not load skill details.</p>
                    <p className="mt-1 text-xs leading-5 text-red-700">{error}</p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
                <Box size={14} className="text-slate-400" />
                Requirements
              </div>
              {loading && !activeSkill.requirements ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  Loading requirement metadata...
                </div>
              ) : activeSkill.requirements ? (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <RequirementChip
                      label="Required binaries"
                      value={
                        activeSkill.requirements.bins?.length
                          ? activeSkill.requirements.bins.join(", ")
                          : "None listed"
                      }
                    />
                    <RequirementChip
                      label="Required env vars"
                      value={
                        activeSkill.requirements.env?.length
                          ? activeSkill.requirements.env.join(", ")
                          : "None listed"
                      }
                    />
                    <RequirementChip
                      label="Required config"
                      value={
                        activeSkill.requirements.config?.length
                          ? activeSkill.requirements.config.join(", ")
                          : "None listed"
                      }
                    />
                    <RequirementChip
                      label="Install methods"
                      value={
                        activeSkill.requirements.install?.length
                          ? activeSkill.requirements.install
                              .map(
                                (entry) => entry.kind || entry.package || entry.name || "unknown",
                              )
                              .join(", ")
                          : "None listed"
                      }
                    />
                  </div>

                  {activeSkill.requirements.install?.length ? (
                    <div className="space-y-2">
                      {activeSkill.requirements.install.map((entry, index) => (
                        <div
                          key={`${activeSkill.slug}-install-${index}`}
                          className="rounded-xl border border-slate-200 bg-white p-3"
                        >
                          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                            <Cpu size={12} />
                            {entry.kind || entry.package || entry.name || "install"}
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {entry.package || entry.name
                              ? `Package: ${entry.package || entry.name}`
                              : "No package name supplied."}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  No{" "}
                  <code className="rounded bg-white px-1 py-0.5 text-[11px] font-mono text-slate-700">
                    metadata.openclaw
                  </code>{" "}
                  requirements were declared for this skill.
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-700">
                <FileText size={14} className="text-slate-400" />
                SKILL.md
              </div>
              {loading && !skill.readme ? (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="h-4 w-1/2 animate-pulse rounded-full bg-slate-200" />
                  <div className="h-4 w-full animate-pulse rounded-full bg-slate-200" />
                  <div className="h-4 w-5/6 animate-pulse rounded-full bg-slate-200" />
                  <div className="h-4 w-3/4 animate-pulse rounded-full bg-slate-200" />
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="max-h-[28rem] overflow-y-auto pr-1 text-sm leading-6 text-slate-700">
                    <MarkdownView
                      source={
                        activeSkill.readme || "No `SKILL.md` content was returned for this skill."
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
