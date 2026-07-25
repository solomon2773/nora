// @ts-nocheck
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

let catalogCache = {
  url: "",
  expiresAt: 0,
  payload: null,
};

function normalizeHubBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function buildHubUrl(baseUrl, path) {
  const normalizedBase = normalizeHubBaseUrl(baseUrl);
  if (!normalizedBase) return "";
  return `${normalizedBase}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeCatalogItem(item = {}) {
  const listing = item.listing || item;
  const id = String(listing.id || listing.slug || item.id || "").trim();
  if (!id) return null;
  const publisher =
    listing.publisher && typeof listing.publisher === "object"
      ? listing.publisher
      : item.publisher && typeof item.publisher === "object"
        ? item.publisher
        : null;
  const ownerName =
    publisher?.displayName ||
    listing.ownerName ||
    listing.owner_name ||
    item.owner_name ||
    "Nora Community";

  return {
    ...item,
    ...(item.listing ? {} : listing),
    id: `hub:${id}`,
    remote_id: id,
    remote: true,
    source_type: "community",
    status: listing.status || "published",
    name: listing.name || item.name || "Community Template",
    description: listing.description || item.description || "",
    category: listing.category || item.category || "General",
    price: listing.price || item.price || "Free",
    owner_name: ownerName,
    publisher: publisher
      ? {
          displayName: publisher.displayName || ownerName,
          avatar: publisher.avatar || null,
          verified: publisher.verified === true,
          sourceHubUrl: publisher.sourceHubUrl || item.hubUrl || "",
        }
      : null,
    current_version: listing.version || listing.current_version || item.current_version || 1,
  };
}

function normalizeCatalogPayload(payload = {}, { hubUrl = "", error = "" } = {}) {
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  const items = rawItems.map(normalizeCatalogItem).filter(Boolean);
  return {
    items,
    hub: {
      url: hubUrl,
      lastSyncedAt: new Date().toISOString(),
      cacheTtlSeconds: Math.round(DEFAULT_CACHE_TTL_MS / 1000),
      error,
      setupRequired: error === "Agent Hub API key is not configured",
    },
  };
}

/**
 * Send an authenticated, timeout-bounded Agent Hub request and surface remote
 * errors without retaining the API key in returned data.
 *
 * @param {string} url - Remote Agent Hub endpoint.
 * @param {Object} [options={}] - Fetch options plus API key and timeout.
 * @returns {Promise<Object>} Parsed JSON response.
 */
async function fetchJson(url, options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const { apiKey: _apiKey, timeoutMs: _timeoutMs, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 5000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Agent Hub request failed with ${response.status}`);
  }
  return payload;
}

/**
 * Fetch and cache the remote catalog, returning stale cached items with an
 * error marker when refresh fails instead of failing the local catalog page.
 *
 * @param {Object} [settings={}] - Remote URL and source API key settings.
 * @param {Object} [options={}] - Refresh, timeout, and cache-TTL overrides.
 * @returns {Promise<Object>} Normalized catalog and synchronization metadata.
 */
async function fetchCatalog(settings = {}, options = {}) {
  const hubUrl = normalizeHubBaseUrl(settings.envUrl || settings.url);
  if (!hubUrl) {
    return normalizeCatalogPayload([], { error: "Agent Hub URL is not configured" });
  }
  const apiKey = String(settings.sourceApiKey || settings.apiKey || "").trim();
  if (!apiKey) {
    return normalizeCatalogPayload([], {
      hubUrl,
      error: "Agent Hub API key is not configured",
    });
  }

  const now = Date.now();
  if (
    !options.refresh &&
    catalogCache.url === hubUrl &&
    catalogCache.payload &&
    catalogCache.expiresAt > now
  ) {
    return catalogCache.payload;
  }

  try {
    const payload = await fetchJson(buildHubUrl(hubUrl, "/api/agent-hub/catalog"), {
      apiKey,
      timeoutMs: options.timeoutMs || 5000,
    });
    const normalized = normalizeCatalogPayload(payload, { hubUrl });
    catalogCache = {
      url: hubUrl,
      expiresAt: now + (options.ttlMs || DEFAULT_CACHE_TTL_MS),
      payload: normalized,
    };
    return normalized;
  } catch (error) {
    const fallback =
      catalogCache.url === hubUrl && catalogCache.payload ? catalogCache.payload : null;
    return {
      items: fallback?.items || [],
      hub: {
        url: hubUrl,
        lastSyncedAt: fallback?.hub?.lastSyncedAt || null,
        cacheTtlSeconds: Math.round(DEFAULT_CACHE_TTL_MS / 1000),
        error: error.message,
      },
    };
  }
}

/**
 * Load one authenticated remote listing and normalize its id into the `hub:` namespace.
 *
 * @param {Object} [settings={}] - Remote URL and source API key settings.
 * @param {string} remoteId - Remote listing identifier, with or without `hub:`.
 * @returns {Promise<Object>} Normalized remote listing detail.
 */
async function fetchListing(settings = {}, remoteId) {
  const hubUrl = normalizeHubBaseUrl(settings.envUrl || settings.url);
  if (!hubUrl) {
    throw new Error("Agent Hub URL is not configured");
  }
  const apiKey = String(settings.sourceApiKey || settings.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Agent Hub API key is not configured");
  }
  const normalizedRemoteId = String(remoteId || "")
    .replace(/^hub:/, "")
    .trim();
  if (!normalizedRemoteId) {
    throw new Error("remote listing id is required");
  }
  const payload = await fetchJson(
    buildHubUrl(hubUrl, `/api/agent-hub/catalog/${encodeURIComponent(normalizedRemoteId)}`),
    { apiKey },
  );
  const listing = normalizeCatalogItem(payload.listing || payload);
  if (!listing) {
    throw new Error("Remote Agent Hub listing not found");
  }
  return {
    ...payload,
    ...listing,
    id: `hub:${listing.remote_id}`,
    remote_id: listing.remote_id,
  };
}

/**
 * Submit a listing payload to the configured remote Agent Hub.
 *
 * @param {Object} [settings={}] - Remote URL and source API key settings.
 * @param {Object} [payload={}] - Listing submission payload.
 * @returns {Promise<Object>} Remote submission response.
 */
async function submitListing(settings = {}, payload = {}) {
  const hubUrl = normalizeHubBaseUrl(settings.envUrl || settings.url);
  if (!hubUrl) {
    throw new Error("Agent Hub URL is not configured");
  }
  const apiKey = String(settings.sourceApiKey || settings.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Agent Hub API key is not configured");
  }
  return fetchJson(buildHubUrl(hubUrl, "/api/agent-hub/submissions"), {
    method: "POST",
    apiKey,
    body: JSON.stringify(payload),
    timeoutMs: 5000,
  });
}

module.exports = {
  fetchCatalog,
  fetchListing,
  normalizeCatalogItem,
  normalizeHubBaseUrl,
  submitListing,
};
