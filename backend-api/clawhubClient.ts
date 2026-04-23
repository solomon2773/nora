// @ts-nocheck
const matter = require("gray-matter");

const DEFAULT_CLAWHUB_BASE_URL = "https://clawhub.ai";
const CANDIDATE_BASE_URL_KEYS = [
  "registryBaseUrl",
  "registryURL",
  "registryUrl",
  "registry_base_url",
  "apiBaseUrl",
  "apiURL",
  "apiUrl",
  "api_base_url",
  "baseUrl",
  "baseURL",
  "base_url",
  "url",
  "origin",
];

function createClawhubError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeText(value, fallback = "") {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeOptionalNumber(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeDate(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      return trimmed ? [trimmed] : [];
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return [String(entry)];
    }
    return [];
  });
}

function normalizeInstallEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    const rawValue = normalizeText(entry);
    return rawValue ? { kind: "unknown", package: rawValue } : null;
  }

  const normalized = {};
  const rawKind =
    normalizeText(entry.kind) ||
    normalizeText(entry.type) ||
    normalizeText(entry.manager) ||
    "unknown";
  const rawPackage =
    normalizeText(entry.package) || normalizeText(entry.name) || normalizeText(entry.value);

  if (rawKind) normalized.kind = rawKind;
  if (rawPackage) normalized.package = rawPackage;

  for (const [key, value] of Object.entries(entry)) {
    if (
      key === "kind" ||
      key === "package" ||
      key === "type" ||
      key === "name" ||
      key === "value"
    ) {
      continue;
    }
    if (value == null) continue;
    normalized[key] = value;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeRequirements(openClaw = null) {
  if (!openClaw || typeof openClaw !== "object") return null;

  const bins = normalizeStringArray(openClaw.requires?.bins ?? openClaw.bins);
  const env = normalizeStringArray(openClaw.requires?.env ?? openClaw.env);
  const config = normalizeStringArray(openClaw.requires?.config ?? openClaw.config);
  const installEntries = Array.isArray(openClaw.install)
    ? openClaw.install.map((entry) => normalizeInstallEntry(entry)).filter(Boolean)
    : [];

  if (!bins.length && !env.length && !config.length && !installEntries.length) {
    return null;
  }

  return {
    bins,
    env,
    config,
    install: installEntries,
  };
}

function parseSkillMarkdown(readme = "") {
  const raw = typeof readme === "string" ? readme : "";
  if (!raw.trim()) {
    return {
      readme: "",
      requirements: null,
    };
  }

  try {
    const parsed = matter(raw);
    const openClaw = parsed?.data?.metadata?.openclaw ?? parsed?.data?.openclaw ?? null;

    return {
      readme: typeof parsed.content === "string" ? parsed.content.trim() : raw,
      requirements: normalizeRequirements(openClaw),
    };
  } catch {
    return {
      readme: raw,
      requirements: null,
    };
  }
}

function normalizeSkillSummary(item = {}) {
  const source =
    item && typeof item === "object" && item.skill && typeof item.skill === "object"
      ? item.skill
      : item;

  const slug = normalizeText(source.slug || source.installSlug || source.pagePath || source.id);
  if (!slug) return null;

  return {
    slug,
    name: normalizeText(source.name || source.displayName, slug),
    description: normalizeText(source.description || source.summary),
    downloads: normalizeOptionalNumber(
      source.downloads ?? source.download_count ?? source.downloadCount ?? source.stats?.downloads,
    ),
    stars: normalizeOptionalNumber(
      source.stars ?? source.star_count ?? source.starCount ?? source.stats?.stars,
    ),
    updatedAt: normalizeDate(
      source.updatedAt ?? source.updated_at ?? source.updated_at_at ?? source.updated,
    ),
  };
}

function extractSkillsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.skills)) return payload.skills;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeSkillListPayload(payload = {}) {
  return {
    skills: extractSkillsList(payload)
      .map((item) => normalizeSkillSummary(item))
      .filter(Boolean),
    cursor:
      normalizeText(
        payload?.cursor ?? payload?.nextCursor ?? payload?.next_cursor ?? payload?.next,
      ) || null,
  };
}

function normalizeSkillDetailPayload(metadata = {}, readme = "") {
  const skillMetadata =
    metadata && typeof metadata === "object" && metadata.skill && typeof metadata.skill === "object"
      ? metadata.skill
      : metadata;
  const owner =
    metadata && typeof metadata === "object" && metadata.owner && typeof metadata.owner === "object"
      ? metadata.owner
      : null;
  const summary = normalizeSkillSummary(skillMetadata);
  if (!summary) {
    return null;
  }

  const author = normalizeText(owner?.handle);
  const pagePath = author ? `${author}/${summary.slug}` : summary.slug;

  const parsedMarkdown = parseSkillMarkdown(readme);
  const metadataRequirements = normalizeRequirements(
    skillMetadata?.metadata?.openclaw ?? skillMetadata?.openClaw ?? null,
  );

  return {
    ...summary,
    author,
    pagePath,
    readme: parsedMarkdown.readme,
    requirements: parsedMarkdown.requirements ?? metadataRequirements,
  };
}

function pickDiscoveryBaseUrl(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  for (const key of CANDIDATE_BASE_URL_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (payload.registry && typeof payload.registry === "object") {
    const nested = pickDiscoveryBaseUrl(payload.registry);
    if (nested) return nested;
  }
  if (payload.api && typeof payload.api === "object") {
    const nested = pickDiscoveryBaseUrl(payload.api);
    if (nested) return nested;
  }
  return "";
}

function ensureTrailingSlash(value) {
  const normalized = normalizeText(value, DEFAULT_CLAWHUB_BASE_URL);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

async function readResponseText(response) {
  if (!response || typeof response.text !== "function") {
    return "";
  }
  return response.text();
}

async function parseJsonResponse(response, fallbackErrorMessage) {
  const body = await readResponseText(response);
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw createClawhubError(502, "clawhub_unavailable", fallbackErrorMessage);
  }
}

async function fetchRegistryDiscoveryBaseUrl() {
  let response;
  try {
    response = await fetch(`${DEFAULT_CLAWHUB_BASE_URL}/.well-known/clawhub.json`, {
      headers: { Accept: "application/json" },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(10000) : undefined,
    });
  } catch {
    return DEFAULT_CLAWHUB_BASE_URL;
  }

  if (!response || !response.ok) {
    return DEFAULT_CLAWHUB_BASE_URL;
  }

  const payload = await parseJsonResponse(response, "Could not reach ClawHub registry.");
  return pickDiscoveryBaseUrl(payload) || DEFAULT_CLAWHUB_BASE_URL;
}

async function fetchRegistryJson(pathname, { allowNotFound = false } = {}) {
  const baseUrl = ensureTrailingSlash(await fetchRegistryDiscoveryBaseUrl());
  const url = new URL(pathname.replace(/^\/+/, ""), baseUrl);

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(10000) : undefined,
    });
  } catch (error) {
    if (allowNotFound) {
      throw createClawhubError(404, "skill_not_found", "No skill found with slug: unknown");
    }
    throw createClawhubError(502, "clawhub_unavailable", "Could not reach ClawHub registry.");
  }

  if (!response.ok) {
    if (allowNotFound && response.status === 404) {
      throw createClawhubError(404, "skill_not_found", "No skill found with slug: unknown");
    }
    throw createClawhubError(502, "clawhub_unavailable", "Could not reach ClawHub registry.");
  }

  return parseJsonResponse(response, "Could not reach ClawHub registry.");
}

async function fetchRegistryText(pathname, { allowNotFound = false } = {}) {
  const baseUrl = ensureTrailingSlash(await fetchRegistryDiscoveryBaseUrl());
  const url = new URL(pathname.replace(/^\/+/, ""), baseUrl);

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: "text/markdown, text/plain, */*" },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(10000) : undefined,
    });
  } catch {
    if (allowNotFound) {
      throw createClawhubError(404, "skill_not_found", "No skill found with slug: unknown");
    }
    throw createClawhubError(502, "clawhub_unavailable", "Could not reach ClawHub registry.");
  }

  if (!response.ok) {
    if (allowNotFound && response.status === 404) {
      throw createClawhubError(404, "skill_not_found", "No skill found with slug: unknown");
    }
    throw createClawhubError(502, "clawhub_unavailable", "Could not reach ClawHub registry.");
  }

  return readResponseText(response);
}

async function listSkills({ limit = 20, cursor = null } = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);

  const payload = await fetchRegistryJson(`/api/v1/skills?${params.toString()}`);
  return normalizeSkillListPayload(payload);
}

async function searchSkills({ q, limit = 20 } = {}) {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(limit));

  const payload = await fetchRegistryJson(`/api/v1/search?${params.toString()}`);
  return normalizeSkillListPayload(payload);
}

async function getSkillDetail(slug) {
  const normalizedSlug = normalizeText(slug);
  if (!normalizedSlug) {
    throw createClawhubError(404, "skill_not_found", "No skill found with slug: unknown");
  }

  const metadata = await fetchRegistryJson(`/api/v1/skills/${encodeURIComponent(normalizedSlug)}`, {
    allowNotFound: true,
  }).catch((error) => {
    if (error?.statusCode === 404) {
      throw createClawhubError(
        404,
        "skill_not_found",
        `No skill found with slug: ${normalizedSlug}`,
      );
    }
    throw error;
  });

  const readme = await fetchRegistryText(
    `/api/v1/skills/${encodeURIComponent(normalizedSlug)}/file?path=${encodeURIComponent("SKILL.md")}`,
    { allowNotFound: true },
  ).catch((error) => {
    if (error?.statusCode === 404) {
      throw createClawhubError(
        404,
        "skill_not_found",
        `No skill found with slug: ${normalizedSlug}`,
      );
    }
    throw error;
  });

  const detail = normalizeSkillDetailPayload(metadata, readme);
  if (!detail) {
    throw createClawhubError(404, "skill_not_found", `No skill found with slug: ${normalizedSlug}`);
  }
  return detail;
}

module.exports = {
  DEFAULT_CLAWHUB_BASE_URL,
  createClawhubError,
  fetchRegistryDiscoveryBaseUrl,
  getSkillDetail,
  listSkills,
  normalizeInstallEntry,
  normalizeRequirements,
  parseSkillMarkdown,
  normalizeSkillDetailPayload,
  normalizeSkillListPayload,
  normalizeSkillSummary,
  searchSkills,
};
