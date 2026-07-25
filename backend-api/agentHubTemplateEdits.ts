// @ts-nocheck
const {
  applyTemplateFileEdits,
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
} = require("./agentPayloads");
const { normalizeBackendName } = require("../agent-runtime/lib/backendCatalog");
const { parseSandboxProfile } = require("./agentRuntimeFields");

function decodeMaybeString(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

function stripAsciiControlCharacters(value) {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

function normalizeText(value, fallback = "", maxLength = 255) {
  const normalized = typeof value === "string" ? stripAsciiControlCharacters(value).trim() : "";
  return (normalized || fallback).slice(0, maxLength);
}

function normalizeDescription(value, fallback = "", maxLength = 1200) {
  if (typeof value !== "string") return String(fallback || "").slice(0, maxLength);
  return value.trim().slice(0, maxLength);
}

function normalizeCategory(value, fallback = "General") {
  return normalizeText(value, fallback, 60) || "General";
}

function normalizeSlug(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
  return normalized || null;
}

function normalizeTemplateKey(value, fallback = null) {
  const normalized = normalizeText(value, "", 120);
  if (normalized) return normalized;
  return fallback ?? null;
}

function normalizeSnapshotKind(value, fallback = "community-template") {
  return normalizeText(value, fallback, 80) || fallback;
}

function normalizePositiveInt(value, fallback, { min = 1, max = 99999 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function normalizeSandbox(value, fallback = "standard") {
  return parseSandboxProfile(value) || parseSandboxProfile(fallback) || "standard";
}

function normalizeBackend(value, fallback = null) {
  const candidate = String(value ?? "").trim() !== "" ? value : fallback;
  if (String(candidate ?? "").trim() === "") return null;
  return normalizeBackendName(candidate);
}

function normalizeImage(value, fallback = null) {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, 500);
  return normalized || null;
}

/**
 * Normalize editable file input into decoded path/content entries, falling
 * back to the existing files when the field is not an array.
 *
 * @param {Array} value - Requested editable files.
 * @param {Array} [fallbackFiles=[]] - Existing normalized payload files.
 * @returns {Array} Editable text file entries with non-empty paths.
 */
function normalizeEditableFiles(value, fallbackFiles = []) {
  if (!Array.isArray(value)) return fallbackFiles;

  return value
    .map((entry) => ({
      path: typeof entry?.path === "string" ? entry.path : "",
      content: (() => {
        if (typeof entry?.content === "string") return entry.content;
        if (typeof entry?.contentBase64 === "string") {
          try {
            return Buffer.from(entry.contentBase64, "base64").toString("utf8");
          } catch {
            return "";
          }
        }
        return "";
      })(),
    }))
    .filter((entry) => entry.path.trim());
}

/**
 * Build synchronized listing and snapshot updates while preserving protected
 * template identity fields unless the caller explicitly allows changing them.
 *
 * @param {Object} snapshot - Existing template snapshot.
 * @param {Object} listing - Existing Agent Hub listing.
 * @param {Object} [input={}] - Requested metadata, defaults, and file edits.
 * @param {Object} [options={}] - Source and protected-field permissions.
 * @returns {Object} Normalized listing and snapshot update payloads.
 */
function buildAgentHubTemplateUpdate(snapshot, listing, input = {}, options = {}) {
  const config = decodeMaybeString(snapshot?.config);
  const currentPayload = extractTemplatePayloadFromSnapshot(snapshot, {
    includeBootstrap: true,
  });
  const currentDefaults = extractTemplateDefaultsFromSnapshot(snapshot);
  const sourceType = options.sourceType || listing?.source_type || "community";
  const builtIn = options.builtIn === true || sourceType === "platform";

  const nameFallback = listing?.name || snapshot?.name || "Untitled Template";
  const descriptionFallback = listing?.description || snapshot?.description || "";
  const categoryFallback = listing?.category || "General";
  const versionFallback = normalizePositiveInt(listing?.current_version, 1);

  const nextName =
    input.name !== undefined
      ? normalizeText(input.name, nameFallback, 100) || nameFallback
      : nameFallback;
  const nextDescription =
    input.description !== undefined
      ? normalizeDescription(input.description, descriptionFallback)
      : descriptionFallback;
  const nextCategory =
    input.category !== undefined
      ? normalizeCategory(input.category, categoryFallback)
      : categoryFallback;
  const nextSlug =
    input.slug !== undefined
      ? normalizeSlug(input.slug)
      : normalizeSlug(listing?.slug || "") || null;
  const nextVersion =
    input.currentVersion !== undefined
      ? normalizePositiveInt(input.currentVersion, versionFallback)
      : versionFallback;
  const sandboxInputProvided = input.sandbox !== undefined;

  const nextPayload = applyTemplateFileEdits(
    currentPayload,
    normalizeEditableFiles(input.files, currentPayload.files),
    {
      name: nextName,
      description: nextDescription,
      category: nextCategory,
      ownerName:
        listing?.owner_name ||
        listing?.owner_email ||
        (sourceType === "platform" ? "Nora" : "Community"),
      sourceType,
      templateKey:
        options.allowTemplateKeyChange === true
          ? normalizeTemplateKey(input.templateKey, snapshot?.template_key || null)
          : snapshot?.template_key || null,
      includeBootstrap: true,
    },
  );

  const nextDefaults = {
    ...currentDefaults,
    backend: (() => {
      if (input.backend !== undefined) {
        return normalizeBackend(input.backend, currentDefaults.backend);
      }

      return normalizeBackend(currentDefaults.backend, currentDefaults.backend);
    })(),
    vcpu: normalizePositiveInt(input.vcpu, currentDefaults.vcpu, { min: 1, max: 128 }),
    ram_mb: normalizePositiveInt(input.ram_mb, currentDefaults.ram_mb, { min: 512, max: 1048576 }),
    disk_gb: normalizePositiveInt(input.disk_gb, currentDefaults.disk_gb, { min: 1, max: 32768 }),
    image:
      input.image !== undefined
        ? normalizeImage(input.image, currentDefaults.image || null)
        : currentDefaults.image || null,
  };
  nextDefaults.sandbox = sandboxInputProvided
    ? normalizeSandbox(input.sandbox, currentDefaults.sandbox)
    : currentDefaults.sandbox;

  return {
    listing: {
      name: nextName,
      description: nextDescription,
      category: nextCategory,
      slug: nextSlug,
      currentVersion: nextVersion,
      price: "Free",
    },
    snapshot: {
      name: nextName,
      description: nextDescription,
      kind:
        options.allowSnapshotKindChange === true
          ? normalizeSnapshotKind(input.snapshotKind, snapshot?.kind || "community-template")
          : snapshot?.kind || "community-template",
      templateKey:
        options.allowTemplateKeyChange === true
          ? normalizeTemplateKey(input.templateKey, snapshot?.template_key || null)
          : snapshot?.template_key || null,
      builtIn,
      config: {
        ...config,
        builtIn,
        defaults: nextDefaults,
        templatePayload: nextPayload,
      },
    },
  };
}

module.exports = {
  buildAgentHubTemplateUpdate,
  normalizeSlug,
  normalizeText,
};
