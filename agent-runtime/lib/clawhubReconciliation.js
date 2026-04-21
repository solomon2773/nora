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
    (Array.isArray(installedSkills) ? installedSkills : [])
      .map((entry) => String(entry?.slug || "").trim())
      .filter(Boolean)
  );
  return normalizedSaved.filter((entry) => !installedSlugs.has(entry.installSlug));
}

module.exports = {
  computeMissingSavedSkills,
  normalizeSavedSkillEntries,
  normalizeSavedSkillEntry,
};
