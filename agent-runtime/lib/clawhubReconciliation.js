function normalizeSavedSkillEntry(slug, entry = {}) {
  const installSlug = String(entry?.installSlug || slug || "").trim();
  if (!installSlug) return null;

  const author = String(entry?.author || "").trim();
  const pagePath =
    String(entry?.pagePath || "").trim() || (author ? `${author}/${installSlug}` : installSlug);
  const installedAtRaw = String(entry?.installedAt || "").trim();
  const installedAt =
    installedAtRaw && !Number.isNaN(new Date(installedAtRaw).getTime())
      ? new Date(installedAtRaw).toISOString()
      : new Date().toISOString();

  return {
    source: "clawhub",
    installSlug,
    author,
    pagePath,
    installedAt,
  };
}

function normalizeInstalledSkillEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      slug: String(entry?.slug || "").trim(),
      version: String(entry?.version || "").trim(),
    }))
    .filter((entry) => entry.slug);
}

function normalizeSavedSkillEntries(entries = []) {
  const deduped = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeSavedSkillEntry(entry?.installSlug || entry?.slug, entry);
    if (!normalized) continue;
    const key = `${normalized.author}:${normalized.installSlug}`;
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }
  return [...deduped.values()];
}

function computeMissingSavedSkills(savedSkills = [], installedSkills = []) {
  const normalizedSaved = normalizeSavedSkillEntries(savedSkills);
  const installedSlugs = new Set(
    normalizeInstalledSkillEntries(installedSkills).map((entry) => entry.slug),
  );
  return normalizedSaved.filter((entry) => !installedSlugs.has(entry.installSlug));
}

function computeOrphanedInstalledSkills(savedSkills = [], installedSkills = []) {
  const normalizedSaved = normalizeSavedSkillEntries(savedSkills);
  const savedSlugs = new Set(normalizedSaved.map((entry) => entry.installSlug));
  return normalizeInstalledSkillEntries(installedSkills).filter(
    (entry) => !savedSlugs.has(entry.slug),
  );
}

function removeSavedSkillEntry(entries = [], slug, author = "") {
  const normalizedSlug = String(slug || "").trim();
  const normalizedAuthor = String(author || "").trim();
  if (!normalizedSlug) {
    return normalizeSavedSkillEntries(entries);
  }

  return normalizeSavedSkillEntries(entries).filter((entry) => {
    if (entry.installSlug !== normalizedSlug) return true;
    if (!normalizedAuthor) return false;
    return entry.author !== normalizedAuthor;
  });
}

/**
 * Merge Nora's saved ClawHub entries, the runtime lockfile view, and any
 * in-flight jobs into one operator-facing skill list.
 *
 * The returned rows intentionally preserve drift instead of hiding it:
 * `healthy` means saved+installed match, `missing_runtime` means Nora expects
 * the skill but the runtime lacks it, and `orphaned_runtime` means the runtime
 * has a skill Nora is not currently tracking. Pending install/delete jobs win
 * over those steady-state statuses so the UI can show transitional state.
 *
 * @param {Array<object>} [savedSkills=[]] Saved ClawHub entries from `agents.clawhub_skills`.
 * @param {Array<object>} [installedSkills=[]] Runtime lockfile entries currently installed.
 * @param {Array<object>} [pendingJobs=[]] In-flight ClawHub jobs keyed by slug.
 * @returns {Array<object>} Sorted merged skill rows with stable metadata plus a
 * derived `status` describing healthy, drifted, or pending state.
 */
function mergeClawhubSkillState(savedSkills = [], installedSkills = [], pendingJobs = []) {
  const normalizedSaved = normalizeSavedSkillEntries(savedSkills);
  const normalizedInstalled = normalizeInstalledSkillEntries(installedSkills);
  const installedBySlug = new Map(normalizedInstalled.map((entry) => [entry.slug, entry]));
  const pendingBySlug = new Map(
    (Array.isArray(pendingJobs) ? pendingJobs : [])
      .map((job) => [String(job?.slug || "").trim(), job])
      .filter(([slug]) => slug),
  );
  const merged = [];

  for (const saved of normalizedSaved) {
    const installed = installedBySlug.get(saved.installSlug);
    const pending = pendingBySlug.get(saved.installSlug);
    merged.push({
      slug: saved.installSlug,
      version: installed?.version || "",
      saved: true,
      installed: Boolean(installed),
      source: "clawhub",
      author: saved.author,
      pagePath: saved.pagePath,
      installedAt: saved.installedAt || null,
      status:
        pending?.operation === "delete"
          ? "pending_delete"
          : pending?.operation === "install"
            ? "pending_install"
            : installed
              ? "healthy"
              : "missing_runtime",
    });
    installedBySlug.delete(saved.installSlug);
  }

  for (const installed of installedBySlug.values()) {
    const pending = pendingBySlug.get(installed.slug);
    merged.push({
      slug: installed.slug,
      version: installed.version || "",
      saved: false,
      installed: true,
      source: "clawhub",
      author: "",
      pagePath: installed.slug,
      installedAt: null,
      status: pending?.operation === "delete" ? "pending_delete" : "orphaned_runtime",
    });
  }

  return merged.sort((a, b) => a.slug.localeCompare(b.slug));
}

module.exports = {
  computeMissingSavedSkills,
  computeOrphanedInstalledSkills,
  mergeClawhubSkillState,
  normalizeInstalledSkillEntries,
  removeSavedSkillEntry,
  normalizeSavedSkillEntries,
  normalizeSavedSkillEntry,
};
