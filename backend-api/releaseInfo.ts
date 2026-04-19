// @ts-nocheck
const DEFAULT_MANUAL_UPGRADE_COMMAND =
  "git pull --ff-only && docker compose up -d --build";
const DEFAULT_RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_MANUAL_UPGRADE_STEPS = Object.freeze([
  "Run the upgrade command from the Nora repo root on the host machine.",
  "Wait for Docker Compose to rebuild and restart the Nora services.",
  "Refresh Admin Settings and confirm the current version changed.",
]);

let githubReleaseCache = {
  key: "",
  expiresAt: 0,
  value: null,
};

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBooleanEnv(value, defaultValue = false) {
  const normalized = readString(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeSeverity(value, fallback = "warning") {
  const normalized = readString(value).toLowerCase();
  if (["info", "warning", "critical"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeDate(value) {
  const normalized = readString(value);
  if (!normalized) return null;

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeGithubRepo(value) {
  const normalized = readString(value)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return "";
  }

  return normalized;
}

function parseSemver(value) {
  const normalized = readString(value).replace(/^v/i, "");
  if (!normalized) return null;

  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4]
      ? match[4].split(".").map((part) =>
          /^\d+$/.test(part) ? Number.parseInt(part, 10) : part.toLowerCase()
        )
      : [],
  };
}

function comparePrerelease(a = [], b = []) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;

  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = a[index];
    const right = b[index];

    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftIsNumber = typeof left === "number";
    const rightIsNumber = typeof right === "number";

    if (leftIsNumber && rightIsNumber) {
      return left > right ? 1 : -1;
    }

    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return String(left).localeCompare(String(right), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }

  return 0;
}

function compareVersions(currentVersion, latestVersion) {
  const current = readString(currentVersion);
  const latest = readString(latestVersion);

  if (!current && !latest) return 0;
  if (!current) return -1;
  if (!latest) return 1;

  const currentSemver = parseSemver(current);
  const latestSemver = parseSemver(latest);

  if (currentSemver && latestSemver) {
    if (currentSemver.major !== latestSemver.major) {
      return currentSemver.major > latestSemver.major ? 1 : -1;
    }
    if (currentSemver.minor !== latestSemver.minor) {
      return currentSemver.minor > latestSemver.minor ? 1 : -1;
    }
    if (currentSemver.patch !== latestSemver.patch) {
      return currentSemver.patch > latestSemver.patch ? 1 : -1;
    }
    return comparePrerelease(
      currentSemver.prerelease,
      latestSemver.prerelease
    );
  }

  return current.localeCompare(latest, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function buildManualUpgrade(env = process.env) {
  const command =
    readString(env.NORA_MANUAL_UPGRADE_COMMAND) ||
    DEFAULT_MANUAL_UPGRADE_COMMAND;
  const steps = readString(env.NORA_MANUAL_UPGRADE_STEPS)
    .split("\n")
    .map((step) => step.trim())
    .filter(Boolean);

  return {
    command,
    steps: steps.length ? steps : [...DEFAULT_MANUAL_UPGRADE_STEPS],
  };
}

function resolveConfiguredLatestRelease(env = process.env) {
  const latestVersion = readString(env.NORA_LATEST_VERSION) || null;
  const publishedAt = normalizeDate(env.NORA_LATEST_PUBLISHED_AT);
  const releaseNotesUrl = readString(env.NORA_RELEASE_NOTES_URL) || null;

  if (!latestVersion && !publishedAt && !releaseNotesUrl) {
    return null;
  }

  return {
    latestVersion,
    publishedAt,
    releaseNotesUrl,
    source: "env",
  };
}

async function fetchGithubLatestRelease(env = process.env) {
  const repo = normalizeGithubRepo(
    env.NORA_GITHUB_REPO || env.NORA_RELEASE_REPO || env.GITHUB_REPOSITORY
  );
  if (!repo || typeof fetch !== "function") {
    return null;
  }

  const token =
    readString(env.NORA_GITHUB_TOKEN) ||
    readString(env.GITHUB_TOKEN) ||
    null;
  const cacheTtlMs = parsePositiveInteger(
    env.NORA_RELEASE_CACHE_TTL_MS,
    DEFAULT_RELEASE_CACHE_TTL_MS
  );
  const cacheKey = `${repo}:${token ? "auth" : "anon"}`;

  if (
    cacheTtlMs > 0 &&
    githubReleaseCache.key === cacheKey &&
    githubReleaseCache.expiresAt > Date.now()
  ) {
    return githubReleaseCache.value;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "nora-release-checker",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const requestOptions = { headers };
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    requestOptions.signal = AbortSignal.timeout(4000);
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    requestOptions
  );

  if (response.status === 404) {
    if (cacheTtlMs > 0) {
      githubReleaseCache = {
        key: cacheKey,
        expiresAt: Date.now() + cacheTtlMs,
        value: null,
      };
    }
    return null;
  }

  if (!response.ok) {
    if (cacheTtlMs > 0) {
      githubReleaseCache = {
        key: cacheKey,
        expiresAt: Date.now() + cacheTtlMs,
        value: null,
      };
    }
    throw new Error(`GitHub release lookup failed with ${response.status}`);
  }

  const payload = await response.json().catch(() => null);
  const latestVersion = readString(payload?.tag_name) || null;
  if (!latestVersion) {
    if (cacheTtlMs > 0) {
      githubReleaseCache = {
        key: cacheKey,
        expiresAt: Date.now() + cacheTtlMs,
        value: null,
      };
    }
    return null;
  }

  const release = {
    latestVersion,
    publishedAt: normalizeDate(payload?.published_at),
    releaseNotesUrl:
      readString(payload?.html_url) ||
      `https://github.com/${repo}/releases/tag/${encodeURIComponent(
        latestVersion
      )}`,
    source: "github",
    repo,
  };

  if (cacheTtlMs > 0) {
    githubReleaseCache = {
      key: cacheKey,
      expiresAt: Date.now() + cacheTtlMs,
      value: release,
    };
  }

  return release;
}

async function resolveLatestRelease(env = process.env) {
  const configured = resolveConfiguredLatestRelease(env);
  if (configured) {
    return configured;
  }

  try {
    return await fetchGithubLatestRelease(env);
  } catch (error) {
    console.error(
      "Failed to fetch GitHub release metadata:",
      error?.message || error
    );
    return null;
  }
}

async function buildReleaseInfo(env = process.env) {
  const latestRelease = await resolveLatestRelease(env);
  const currentVersion = readString(env.NORA_CURRENT_VERSION) || null;
  const currentCommit =
    readString(env.NORA_CURRENT_COMMIT) ||
    readString(env.NORA_BUILD_COMMIT) ||
    readString(env.GIT_SHA) ||
    null;
  const latestVersion = latestRelease?.latestVersion || null;
  const installMethod = readString(env.NORA_INSTALL_METHOD) || "source";
  const updateAvailable =
    Boolean(latestVersion) &&
    compareVersions(currentVersion, latestVersion) < 0;
  const severity = updateAvailable
    ? normalizeSeverity(env.NORA_LATEST_SEVERITY, "warning")
    : "info";
  const upgradeRequired =
    updateAvailable &&
    (parseBooleanEnv(env.NORA_UPGRADE_REQUIRED) || severity === "critical");

  return {
    currentVersion,
    currentCommit,
    latestVersion,
    publishedAt: latestRelease?.publishedAt || null,
    releaseNotesUrl: latestRelease?.releaseNotesUrl || null,
    severity,
    updateAvailable,
    upgradeRequired,
    trackingConfigured: Boolean(currentVersion || currentCommit),
    canAutoUpgrade: parseBooleanEnv(env.NORA_AUTO_UPGRADE_ENABLED),
    installMethod,
    latestSource: latestRelease?.source || null,
    latestRepo: latestRelease?.repo || null,
    manualUpgrade: buildManualUpgrade(env),
  };
}

module.exports = {
  buildReleaseInfo,
  compareVersions,
};
