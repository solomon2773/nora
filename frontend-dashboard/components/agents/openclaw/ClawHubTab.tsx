import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { useToast } from "../../Toast";
import { fetchWithAuth } from "../../../lib/api";
import SkillDetailPanel, { SkillDetail, SkillDetailActionState } from "./SkillDetailPanel";
import SkillGrid from "./SkillGrid";
import SkillSearchBar from "./SkillSearchBar";
import SkillSelectionTray from "./SkillSelectionTray";
import { SkillSummary } from "./SkillCard";
import { DeployClawHubSkill } from "../../../lib/clawhubDeploy";

type ClawHubTabProps = {
  agentId: string;
  refreshToken?: string | null;
  onInstallSuccess?: () => void;
};

type SkillListResponse = {
  skills?: SkillSummary[];
  cursor?: string | null;
  error?: string;
  message?: string;
};

type InstalledSkill = {
  slug: string;
  version: string;
};

type InstalledSkillsResponse = {
  skills?: InstalledSkill[];
  error?: string;
  message?: string;
};

type InstallJobResponse = {
  jobId: string;
  agentId: string;
  slug: string;
  status: "pending" | "running" | "success" | "failed";
};

type InstallJobStatus = {
  jobId: string;
  agentId: string;
  slug: string;
  status: "pending" | "running" | "success" | "failed";
  error: string | null;
  completedAt: string | null;
};

function buildSelectedSkill(detail: SkillDetail): DeployClawHubSkill {
  return {
    source: "clawhub",
    installSlug: detail.slug,
    author: detail.author || "",
    pagePath: detail.pagePath || (detail.author ? `${detail.author}/${detail.slug}` : detail.slug),
    installedAt: new Date().toISOString(),
    name: detail.name,
    description: detail.description,
  };
}

export default function ClawHubTab({ agentId, refreshToken, onInstallSuccess }: ClawHubTabProps) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<DeployClawHubSkill[]>([]);
  const [selectionBusySlug, setSelectionBusySlug] = useState<string | null>(null);
  const [jobStatuses, setJobStatuses] = useState<Record<string, InstallJobStatus>>({});
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const requestIdRef = useRef(0);
  const detailCacheRef = useRef<Record<string, SkillDetail>>({});

  const showingDefaultBrowseEmptyState = !query.trim() && !loading && !error && skills.length === 0;
  const installedSlugs = useMemo(
    () => new Set(installedSkills.map((skill) => skill.slug)),
    [installedSkills],
  );
  const selectedSkillKeys = useMemo(
    () => new Set(selectedSkills.map((skill) => `${skill.author}:${skill.installSlug}`)),
    [selectedSkills],
  );
  const selectedSkillSlugs = useMemo(
    () => new Set(selectedSkills.map((skill) => skill.installSlug)),
    [selectedSkills],
  );
  const selectedCurrentSkill = selectedSkillDetail
    ? selectedSkillKeys.has(`${selectedSkillDetail.author || ""}:${selectedSkillDetail.slug}`)
    : false;
  const activeInstallCount = useMemo(
    () =>
      Object.values(jobStatuses).filter(
        (status) => status.status === "pending" || status.status === "running",
      ).length,
    [jobStatuses],
  );

  async function loadInstalledSkills() {
    try {
      const res = await fetchWithAuth(`/api/clawhub/agents/${agentId}/skills`);
      const data: InstalledSkillsResponse = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not load installed skills.");
      }
      setInstalledSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      console.error(err);
    }
  }

  async function loadBrowseResults() {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth("/api/clawhub/skills");
      const data: SkillListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(
          data.message || data.error || "Could not load skills. ClawHub may be unavailable.",
        );
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || "Could not load skills. ClawHub may be unavailable.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function searchSkills() {
    const trimmed = query.trim();
    if (!trimmed) {
      loadBrowseResults();
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth(
        `/api/clawhub/skills/search?q=${encodeURIComponent(trimmed)}`,
      );
      const data: SkillListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(
          data.message || data.error || "Could not load skills. ClawHub may be unavailable.",
        );
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || "Could not load skills. ClawHub may be unavailable.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function fetchSkillDetail(skill: SkillSummary) {
    const cached = detailCacheRef.current[skill.slug];
    if (cached) {
      return cached;
    }

    const res = await fetchWithAuth(`/api/clawhub/skills/${encodeURIComponent(skill.slug)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || data.error || "Could not load skill details.");
    }

    detailCacheRef.current[skill.slug] = data;
    return data as SkillDetail;
  }

  async function loadSkillDetail(skill: SkillSummary) {
    setSelectedSkill(skill);
    setSelectedSkillDetail(detailCacheRef.current[skill.slug] || null);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const detail = await fetchSkillDetail(skill);
      setSelectedSkill({
        slug: detail.slug,
        name: detail.name,
        description: detail.description,
        downloads: detail.downloads,
        stars: detail.stars,
        updatedAt: detail.updatedAt || null,
      });
      setSkills((current) =>
        current.map((entry) =>
          entry.slug === detail.slug
            ? {
                ...entry,
                name: detail.name,
                description: detail.description,
                downloads: detail.downloads,
                stars: detail.stars,
                updatedAt: detail.updatedAt || entry.updatedAt,
              }
            : entry,
        ),
      );
      setSelectedSkillDetail(detail);
    } catch (err: any) {
      setDetailError(err?.message || "Could not load skill details.");
    } finally {
      setDetailLoading(false);
    }
  }

  function addSelectedSkill(detail: SkillDetail) {
    const nextSkill = buildSelectedSkill(detail);
    const nextKey = `${nextSkill.author}:${nextSkill.installSlug}`;
    setSelectedSkills((current) => {
      if (current.some((skill) => `${skill.author}:${skill.installSlug}` === nextKey)) {
        return current;
      }
      return [...current, nextSkill];
    });
  }

  function removeSelectedSkill(skill: SkillSummary | DeployClawHubSkill | SkillDetail) {
    const installSlug = "installSlug" in skill ? skill.installSlug : skill.slug;
    const author = "author" in skill ? skill.author || "" : "";
    setSelectedSkills((current) =>
      current.filter((entry) => !(entry.installSlug === installSlug && entry.author === author)),
    );
  }

  function removeSelectedSkillBySlug(slug: string) {
    setSelectedSkills((current) => current.filter((entry) => entry.installSlug !== slug));
  }

  function clearSelectedSkills() {
    setSelectedSkills([]);
  }

  async function toggleSkillSelection(skill: SkillSummary) {
    const cached = detailCacheRef.current[skill.slug];
    const cachedKey = `${cached?.author || ""}:${skill.slug}`;
    if (cached && selectedSkillKeys.has(cachedKey)) {
      removeSelectedSkill(cached);
      return;
    }

    setSelectionBusySlug(skill.slug);
    try {
      const detail = cached || (await fetchSkillDetail(skill));
      const detailKey = `${detail.author || ""}:${detail.slug}`;
      if (selectedSkillKeys.has(detailKey)) {
        removeSelectedSkill(detail);
      } else {
        addSelectedSkill(detail);
      }
    } catch (err: any) {
      toast.error(err?.message || "Could not update that selection.");
    } finally {
      setSelectionBusySlug(null);
    }
  }

  async function handleInstallSelected() {
    const installable = selectedSkills.filter((skill) => !installedSlugs.has(skill.installSlug));
    if (!installable.length) {
      setInstallError("All selected skills are already installed.");
      return;
    }

    setInstallError(null);

    for (const skill of installable) {
      try {
        const res = await fetchWithAuth(
          `/api/clawhub/agents/${agentId}/skills/${encodeURIComponent(skill.installSlug)}/install`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: "clawhub",
              author: skill.author,
              pagePath: skill.pagePath,
              installedAt: skill.installedAt,
            }),
          },
        );
        const data: InstallJobResponse & { error?: string; message?: string } = await res.json();
        if (!res.ok) {
          throw new Error(data.message || data.error || "Could not queue install.");
        }

        setJobStatuses((current) => ({
          ...current,
          [skill.installSlug]: {
            jobId: data.jobId,
            agentId: data.agentId,
            slug: data.slug,
            status: data.status,
            error: null,
            completedAt: null,
          },
        }));
      } catch (err: any) {
        setJobStatuses((current) => ({
          ...current,
          [skill.installSlug]: {
            jobId: current[skill.installSlug]?.jobId || `${skill.installSlug}-failed`,
            agentId,
            slug: skill.installSlug,
            status: "failed",
            error: err?.message || "Could not queue install.",
            completedAt: null,
          },
        }));
      }
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (!value.trim()) {
      setSelectedSkill(null);
      setSelectedSkillDetail(null);
      setDetailError(null);
      loadBrowseResults();
    }
  }

  function handleClearSearch() {
    setQuery("");
    setSelectedSkill(null);
    setSelectedSkillDetail(null);
    setDetailError(null);
    loadBrowseResults();
  }

  useEffect(() => {
    loadBrowseResults();
  }, [agentId]);

  useEffect(() => {
    loadInstalledSkills();
  }, [agentId, refreshToken]);

  useEffect(() => {
    const activeJobs = Object.values(jobStatuses).filter(
      (status) => status.status === "pending" || status.status === "running",
    );
    if (!activeJobs.length) return;

    const intervalId = window.setInterval(async () => {
      for (const job of activeJobs) {
        try {
          const res = await fetchWithAuth(`/api/clawhub/jobs/${encodeURIComponent(job.jobId)}`);
          const data: InstallJobStatus & { error?: string } = await res.json();
          if (!res.ok) {
            continue;
          }

          setJobStatuses((current) => ({
            ...current,
            [data.slug]: data,
          }));

          if (data.status === "success") {
            await loadInstalledSkills();
            removeSelectedSkillBySlug(data.slug);
            toast.success(`${data.slug} installed. Restart your agent session to activate it.`);
            onInstallSuccess?.();
          }

          if (data.status === "failed" && data.error) {
            toast.error(data.error);
          }
        } catch (err) {
          console.error(err);
        }
      }
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [agentId, jobStatuses, onInstallSuccess, toast]);

  const detailActionState: SkillDetailActionState | undefined = selectedSkillDetail
    ? installedSlugs.has(selectedSkillDetail.slug)
      ? {
          label: "Installed",
          disabled: true,
        }
      : {
          label: selectedCurrentSkill ? "Remove from selection" : "Add to selection",
          disabled: Boolean(selectionBusySlug && selectionBusySlug !== selectedSkillDetail.slug),
          loading: selectionBusySlug === selectedSkillDetail.slug,
          onClick: () => {
            if (selectedCurrentSkill) {
              removeSelectedSkill(selectedSkillDetail);
              return;
            }
            addSelectedSkill(selectedSkillDetail);
          },
        }
    : undefined;

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-r from-white via-slate-50 to-blue-50 p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
              <Boxes size={12} />
              ClawHub Catalog
            </div>
            <h3 className="text-2xl font-black text-slate-900">Install skills on this agent</h3>
            <p className="max-w-2xl text-sm leading-6 text-slate-600">
              Browse the public ClawHub registry from Nora, select one or more skills, and queue
              runtime installs for this running agent.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              loadBrowseResults();
              loadInstalledSkills();
            }}
            disabled={loading}
            className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <SkillSelectionTray
        skills={selectedSkills}
        mode="install"
        installLabel={
          activeInstallCount
            ? `Installing ${activeInstallCount} skill${activeInstallCount === 1 ? "" : "s"}...`
            : `Install ${selectedSkills.length || 0} Skill${selectedSkills.length === 1 ? "" : "s"}`
        }
        installDisabled={!selectedSkills.length || activeInstallCount > 0}
        installError={installError}
        onInstall={handleInstallSelected}
        onRemoveSkill={removeSelectedSkill}
        onClearAll={clearSelectedSkills}
      />

      <SkillSearchBar
        query={query}
        loading={loading}
        onQueryChange={handleQueryChange}
        onSubmit={searchSkills}
        onClear={handleClearSearch}
      />

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.9fr)]">
        <div className="min-w-0">
          <SkillGrid
            skills={skills}
            loading={loading}
            error={error}
            query={query}
            selectedSlug={selectedSkill?.slug || null}
            installedSlugs={installedSlugs}
            selectedSkillSlugs={selectedSkillSlugs}
            selectionBusySlug={selectionBusySlug}
            onSelect={loadSkillDetail}
            onToggleSelection={toggleSkillSelection}
            emptyTitle={
              showingDefaultBrowseEmptyState
                ? "Search ClawHub to discover skills."
                : "No skills found."
            }
            emptyMessage={
              showingDefaultBrowseEmptyState
                ? "ClawHub is returning an empty default browse list right now. Enter a search and press Enter to find skills."
                : undefined
            }
          />
        </div>

        <div className="min-w-0">
          <SkillDetailPanel
            skill={selectedSkill}
            detail={selectedSkillDetail}
            loading={detailLoading}
            error={detailError}
            action={detailActionState}
            onClose={() => {
              setSelectedSkill(null);
              setSelectedSkillDetail(null);
              setDetailError(null);
              setDetailLoading(false);
            }}
          />
        </div>
      </div>
    </div>
  );
}
