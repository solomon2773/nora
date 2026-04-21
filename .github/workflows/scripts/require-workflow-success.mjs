function parseWorkflowList(value) {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const requiredWorkflowNames = parseWorkflowList(process.env.REQUIRED_WORKFLOWS || "");
const optionalWorkflowNames = new Set(parseWorkflowList(process.env.OPTIONAL_WORKFLOWS || ""));

const repository = process.env.GITHUB_REPOSITORY || "";
const headSha = process.env.TARGET_SHA || process.env.GITHUB_SHA || "";
const token = process.env.GITHUB_TOKEN || "";
const timeoutMs = Number.parseInt(process.env.CI_GATE_TIMEOUT_MS || "1800000", 10);
const pollIntervalMs = Number.parseInt(process.env.CI_GATE_POLL_INTERVAL_MS || "15000", 10);

if (!repository || !headSha || !token || requiredWorkflowNames.length === 0) {
  console.error("Missing repository, head SHA, token, or required workflow list.");
  process.exit(1);
}

const apiBaseUrl = `https://api.github.com/repos/${repository}/actions/runs`;
const deadline = Date.now() + timeoutMs;

async function fetchWorkflowRuns() {
  const url = new URL(apiBaseUrl);
  url.searchParams.set("head_sha", headSha);
  url.searchParams.set("per_page", "100");

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "nora-ci-gate",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
}

function summarizeStatusByWorkflow(runs) {
  const latestByName = new Map();

  for (const run of runs) {
    if (!requiredWorkflowNames.includes(run.name)) {
      continue;
    }

    const previous = latestByName.get(run.name);
    if (!previous) {
      latestByName.set(run.name, run);
      continue;
    }

    if (new Date(run.created_at).getTime() > new Date(previous.created_at).getTime()) {
      latestByName.set(run.name, run);
    }
  }

  return latestByName;
}

function isSuccessfulConclusion(conclusion) {
  return ["success", "skipped", "neutral"].includes(conclusion);
}

function isFailureConclusion(conclusion) {
  return ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(
    conclusion,
  );
}

while (Date.now() < deadline) {
  const runs = await fetchWorkflowRuns();
  const latestByName = summarizeStatusByWorkflow(runs);
  let hasPending = false;

  for (const workflowName of requiredWorkflowNames) {
    const run = latestByName.get(workflowName);
    const isOptional = optionalWorkflowNames.has(workflowName);

    if (!run) {
      if (isOptional) {
        console.log(`${workflowName}: optional workflow not triggered for ${headSha}`);
        continue;
      }

      hasPending = true;
      console.log(`${workflowName}: waiting for workflow run on ${headSha}`);
      continue;
    }

    if (run.status !== "completed") {
      hasPending = true;
      console.log(`${workflowName}: ${run.status}`);
      continue;
    }

    if (isSuccessfulConclusion(run.conclusion)) {
      console.log(`${workflowName}: success`);
      continue;
    }

    if (isFailureConclusion(run.conclusion)) {
      console.error(`${workflowName}: ${run.conclusion}`);
      process.exit(1);
    }

    hasPending = true;
    console.log(
      `${workflowName}: completed with ${run.conclusion}, waiting for a definitive status`,
    );
  }

  if (!hasPending) {
    console.log(`All required workflows passed for ${headSha}.`);
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}

console.error(`Timed out waiting for CI workflows on ${headSha}.`);
process.exit(1);
