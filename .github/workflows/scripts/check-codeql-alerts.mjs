import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const HIGH_SECURITY_SEVERITY = 7;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "nora-codeql-alert-gate",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number.parseInt(response?.headers?.get?.("retry-after") || "", 10);
  if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 10_000);
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

async function fetchGithub(
  url,
  {
    token,
    accept,
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const attempts = positiveInteger(retryAttempts, DEFAULT_RETRY_ATTEMPTS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      positiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    );
    try {
      const response = await fetchImpl(url, {
        headers: githubHeaders(token, accept),
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (isRetryableStatus(response.status) && attempt + 1 < attempts) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      throw new Error(
        `GitHub CodeQL API request failed: ${response.status} ${response.statusText}`,
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        if (attempt + 1 < attempts) continue;
        throw new Error(`GitHub CodeQL API request timed out for ${url}`, { cause: error });
      }
      if (attempt + 1 < attempts && error instanceof TypeError) {
        await sleep(Math.min(1000 * 2 ** attempt, 10_000));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`GitHub CodeQL API request failed for ${url}`);
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`GitHub CodeQL API returned invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

export async function listPaginatedJson(
  url,
  { token, fetchImpl = fetch, maxPages = 10, requestTimeoutMs, retryAttempts, sleep } = {},
) {
  const items = [];
  const pageLimit = positiveInteger(maxPages, 10);
  for (let page = 1; page <= pageLimit; page += 1) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("per_page", "100");
    pageUrl.searchParams.set("page", String(page));
    const response = await fetchGithub(pageUrl, {
      token,
      fetchImpl,
      requestTimeoutMs,
      retryAttempts,
      sleep,
    });
    const payload = await responseJson(response);
    if (!Array.isArray(payload)) {
      throw new Error("GitHub CodeQL API returned a non-array response");
    }
    items.push(...payload);
    if (payload.length < 100) return items;
  }
  throw new Error(`GitHub CodeQL API pagination exceeded ${pageLimit} pages`);
}

function codeScanningUrl(repository, resource, searchParams = {}) {
  const url = new URL(`https://api.github.com/repos/${repository}/code-scanning/${resource}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

function ruleSecuritySeverities(run) {
  const severities = new Map();
  const ruleSets = [
    run?.tool?.driver?.rules,
    ...(run?.tool?.extensions || []).map((item) => item.rules),
  ];
  for (const rules of ruleSets) {
    for (const rule of rules || []) {
      const score = Number.parseFloat(String(rule?.properties?.["security-severity"] || ""));
      if (rule?.id && Number.isFinite(score)) severities.set(rule.id, score);
    }
  }
  return severities;
}

function resultLocation(result) {
  const physical = result?.locations?.[0]?.physicalLocation || {};
  return {
    path: physical?.artifactLocation?.uri || "unknown path",
    startLine: physical?.region?.startLine || "?",
  };
}

export function highOrCriticalSarifResults(sarif) {
  if (!sarif || !Array.isArray(sarif.runs)) {
    throw new Error("GitHub CodeQL API returned malformed SARIF");
  }

  const blocking = [];
  for (const run of sarif.runs) {
    const severities = ruleSecuritySeverities(run);
    for (const result of run?.results || []) {
      const score = severities.get(result?.ruleId);
      if (!Number.isFinite(score) || score < HIGH_SECURITY_SEVERITY) continue;
      const alertNumber = Number.parseInt(
        String(result?.properties?.["github/alertNumber"] || ""),
        10,
      );
      blocking.push({
        alertNumber: Number.isSafeInteger(alertNumber) && alertNumber > 0 ? alertNumber : null,
        ruleId: result?.ruleId || "unknown rule",
        score,
        location: resultLocation(result),
      });
    }
  }
  return blocking;
}

async function getJson(url, options = {}) {
  const response = await fetchGithub(url, options);
  return responseJson(response);
}

async function downloadSarif(repository, analysisId, options = {}) {
  const url = codeScanningUrl(repository, `analyses/${analysisId}`);
  const response = await fetchGithub(url, {
    ...options,
    accept: "application/sarif+json",
  });
  return responseJson(response);
}

async function removeDismissedResults(repository, results, options = {}) {
  const alertStates = new Map();
  await Promise.all(
    [...new Set(results.map((result) => result.alertNumber).filter(Boolean))].map(
      async (alertNumber) => {
        const alert = await getJson(codeScanningUrl(repository, `alerts/${alertNumber}`), options);
        alertStates.set(alertNumber, alert?.state || "unknown");
      },
    ),
  );
  return results
    .filter((result) => !result.alertNumber || alertStates.get(result.alertNumber) !== "dismissed")
    .map((result) => ({
      ...result,
      state: result.alertNumber ? alertStates.get(result.alertNumber) : "unknown",
    }));
}

export async function runCodeqlAlertGate({
  repository,
  targetSha,
  targetRef = "",
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (!repository || !targetSha || !token) {
    throw new Error("Missing repository, target SHA, or GitHub token for the CodeQL alert gate");
  }

  const deadline = now() + positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  const analysesUrl = codeScanningUrl(repository, "analyses", {
    tool_name: "CodeQL",
    ref: targetRef,
  });
  const requestOptions = {
    token,
    fetchImpl,
    requestTimeoutMs,
    retryAttempts,
    sleep,
  };
  let analysis = null;

  while (now() < deadline) {
    const analyses = await listPaginatedJson(analysesUrl, requestOptions);
    analysis = analyses.find(
      (candidate) =>
        candidate?.commit_sha === targetSha &&
        String(candidate?.tool?.name || "").toLowerCase() === "codeql",
    );
    if (analysis) break;
    await sleep(positiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
  }

  if (!analysis) {
    throw new Error(`Timed out waiting for the exact-SHA CodeQL analysis for ${targetSha}`);
  }

  const sarif = await downloadSarif(repository, analysis.id, requestOptions);
  const blockingResults = await removeDismissedResults(
    repository,
    highOrCriticalSarifResults(sarif),
    requestOptions,
  );
  return { analysis, blockingResults };
}

async function main() {
  const result = await runCodeqlAlertGate({
    repository: process.env.GITHUB_REPOSITORY || "",
    targetSha: process.env.TARGET_SHA || process.env.GITHUB_SHA || "",
    targetRef: process.env.TARGET_REF || process.env.GITHUB_REF || "",
    token: process.env.GITHUB_TOKEN || "",
    timeoutMs: process.env.CODEQL_ALERT_GATE_TIMEOUT_MS,
    pollIntervalMs: process.env.CODEQL_ALERT_GATE_POLL_INTERVAL_MS,
    requestTimeoutMs: process.env.CODEQL_ALERT_GATE_REQUEST_TIMEOUT_MS,
    retryAttempts: process.env.CODEQL_ALERT_GATE_RETRY_ATTEMPTS,
  });

  if (result.blockingResults.length === 0) {
    console.log(
      `No non-dismissed high or critical CodeQL results found for ${result.analysis.commit_sha}.`,
    );
    return;
  }

  for (const blocker of result.blockingResults) {
    console.error(
      `CodeQL alert #${blocker.alertNumber || "unknown"}: ${blocker.ruleId} at ${blocker.location.path}:${blocker.location.startLine} (state: ${blocker.state})`,
    );
  }
  throw new Error(
    `${result.blockingResults.length} non-dismissed high/critical CodeQL result(s) block this commit`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
