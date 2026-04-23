import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { Boxes, RefreshCw } from "lucide-react";
import Layout from "../../components/layout/Layout";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import {
  clearDeployDraft,
  DeployClawHubSkill,
  DeployDraft,
  loadDeployDraft,
  normalizeDeployDraftResources,
  saveDeployDraft,
} from "../../lib/clawhubDeploy";
import SkillDetailPanel, {
  SkillDetail,
  SkillDetailActionState,
} from "../../components/agents/openclaw/SkillDetailPanel";
import SkillGrid from "../../components/agents/openclaw/SkillGrid";
import SkillSearchBar from "../../components/agents/openclaw/SkillSearchBar";
import SkillSelectionTray from "../../components/agents/openclaw/SkillSelectionTray";
import { SkillSummary } from "../../components/agents/openclaw/SkillCard";

type SkillListResponse = {
  skills?: SkillSummary[];
  cursor?: string | null;
  error?: string;
  message?: string;
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

export default function ClawHubDeployPage() {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<DeployDraft | null>(null);
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
  const [deploying, setDeploying] = useState(false);
  const requestIdRef = useRef(0);
  const detailCacheRef = useRef<Record<string, SkillDetail>>({});

  const showingDefaultBrowseEmptyState = !query.trim() && !loading && !error && skills.length === 0;
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

  useEffect(() => {
    const nextDraft = loadDeployDraft();
    if (!nextDraft) {
      toast.error("Start from the deploy page before choosing ClawHub skills.");
      router.replace("/deploy");
      return;
    }

    setDraft(nextDraft);
    setSelectedSkills(Array.isArray(nextDraft.clawhubSkills) ? nextDraft.clawhubSkills : []);
  }, [router, toast]);

  useEffect(() => {
    if (!draft) return;
    saveDeployDraft({
      ...draft,
      clawhubSkills: selectedSkills,
    });
  }, [draft, selectedSkills]);

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
      toast.error(err?.message || "Could not select that skill.");
    } finally {
      setSelectionBusySlug(null);
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

  async function handleDeploy() {
    if (!draft) return;

    const normalizedResources = normalizeDeployDraftResources(draft);

    setDeploying(true);
    try {
      const res = await fetchWithAuth("/api/agents/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          runtime_family: draft.runtimeFamily,
          deploy_target: draft.deployTarget,
          sandbox_profile: draft.sandboxProfile || "standard",
          ...(draft.containerName.trim() ? { container_name: draft.containerName.trim() } : {}),
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.deploymentMode === "migrate" && draft.migrationDraft?.id
            ? { migration_draft_id: draft.migrationDraft.id }
            : {}),
          ...(draft.vcpu ? { vcpu: normalizedResources.vcpu } : {}),
          ...(draft.ramMb ? { ram_mb: normalizedResources.ramMb } : {}),
          ...(draft.diskGb ? { disk_gb: normalizedResources.diskGb } : {}),
          clawhub_skills: selectedSkills.map((skill) => ({
            source: "clawhub",
            installSlug: skill.installSlug,
            author: skill.author,
            pagePath: skill.pagePath,
            installedAt: skill.installedAt,
          })),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        clearDeployDraft();
        window.location.href = data?.id ? `/app/agents/${data.id}` : "/app/agents";
        return;
      }

      if (res.status === 402) {
        toast.error("You've reached your plan's agent limit. Please upgrade.");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Deployment failed. Please try again.");
      }
    } catch (err) {
      console.error(err);
      toast.error("Network error during deployment.");
    } finally {
      setDeploying(false);
    }
  }

  function handleBack() {
    if (!draft) {
      router.push("/deploy");
      return;
    }

    saveDeployDraft({
      ...draft,
      clawhubSkills: selectedSkills,
    });
    router.push("/deploy");
  }

  useEffect(() => {
    if (!draft) return;
    loadBrowseResults();
  }, [draft]);

  const detailActionState: SkillDetailActionState | undefined = selectedSkillDetail
    ? {
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
    <Layout>
      <div className="space-y-6">
        <div className="rounded-[2rem] border border-slate-200 bg-gradient-to-r from-white via-slate-50 to-blue-50 p-6 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
                <Boxes size={12} />
                ClawHub Selection
              </div>
              <h1 className="text-3xl font-black text-slate-900">
                Choose skills for this new agent
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-slate-600">
                Search ClawHub, inspect each skill’s README and requirements, and attach only the
                skills you want saved on this agent at deploy time.
              </p>
            </div>

            <button
              type="button"
              onClick={loadBrowseResults}
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
          deploying={deploying}
          onBack={handleBack}
          onDeploy={handleDeploy}
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
    </Layout>
  );
}
