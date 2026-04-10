const fs = require("fs");

const NORA_SYNC_INTEGRATIONS_FILE = "/opt/openclaw/integrations.json";
const NORA_INTEGRATIONS_SKILL_NAME = "nora-integrations";
const NORA_INTEGRATIONS_SKILL_FILE = `skills/${NORA_INTEGRATIONS_SKILL_NAME}/SKILL.md`;
const NORA_INTEGRATION_TOOL_COMMAND = "nora-integration-tool";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_GITHUB_FILE_CONTENT_CHARS = 120000;

const SUPPORTED_INTEGRATION_TOOL_OPERATIONS = Object.freeze({
  github: new Set([
    "repos.list",
    "repos.contents.get",
    "pulls.list",
    "issues.create",
  ]),
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIntegrationToolInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return {};
}

function loadSyncedIntegrations(filePath = NORA_SYNC_INTEGRATIONS_FILE) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.integrations)) return raw.integrations;
  } catch {
    return [];
  }

  return [];
}

function buildExampleValueFromSchema(schema = {}) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  switch (schema.type) {
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${normalizeString(schema.description) || "value"}>`;
  }
}

function buildInvocationExample(spec = {}) {
  const schema =
    spec.inputSchema && typeof spec.inputSchema === "object"
      ? spec.inputSchema
      : spec.parameters && typeof spec.parameters === "object"
        ? spec.parameters
        : {};
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  const input = {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (required.has(key)) {
      input[key] = buildExampleValueFromSchema(propertySchema);
    }
  }

  if (Object.keys(input).length > 0) {
    return input;
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    input[key] = buildExampleValueFromSchema(propertySchema);
    break;
  }

  return input;
}

function isIntegrationToolExecutable(integration = {}, spec = {}) {
  const provider = normalizeString(
    integration.provider || integration.catalog_id || integration.id
  ).toLowerCase();
  const operation = normalizeString(spec.operation);
  const supported = SUPPORTED_INTEGRATION_TOOL_OPERATIONS[provider];
  return Boolean(supported && operation && supported.has(operation));
}

function buildIntegrationToolExecutionMetadata(integration = {}, spec = {}) {
  const runtimeToolName = normalizeString(spec.name) || "tool";
  const executable = isIntegrationToolExecutable(integration, spec);
  const exampleInput = buildInvocationExample(spec);

  return {
    executable,
    executionState: executable ? "runtime_skill" : "manifest_only",
    executionSurface: executable ? "exec" : "manifest_only",
    executor: executable ? NORA_INTEGRATION_TOOL_COMMAND : null,
    runtimeToolName,
    exampleInput,
    invokeCommand: executable
      ? `${NORA_INTEGRATION_TOOL_COMMAND} ${runtimeToolName} '${JSON.stringify(exampleInput)}'`
      : null,
  };
}

function getExecutableIntegrationTools(integrations = []) {
  const executableTools = [];

  for (const integration of Array.isArray(integrations) ? integrations : []) {
    const toolSpecs = Array.isArray(integration.toolSpecs)
      ? integration.toolSpecs
      : [];

    for (const spec of toolSpecs) {
      const execution = buildIntegrationToolExecutionMetadata(integration, spec);
      if (!execution.executable) continue;
      executableTools.push({ integration, spec, execution });
    }
  }

  return executableTools;
}

function buildIntegrationSkillMarkdown(integrations = []) {
  const executableTools = getExecutableIntegrationTools(integrations);
  const lines = [
    "# Nora Integrations",
    "",
    "Use this skill when the operator asks you to work with a provider that Nora connected to this agent.",
    `Run connected provider actions with the \`${NORA_INTEGRATION_TOOL_COMMAND}\` command through the exec tool.`,
    "",
    "## Workflow",
    "",
    "1. Check `NORA_INTEGRATIONS.md` to confirm the provider and tool are connected.",
    "2. Run `nora-integration-tool --list` if you need the executable tool names.",
    "3. Execute the tool with JSON input: `nora-integration-tool <tool_name> '{\"key\":\"value\"}'`.",
    "4. Summarize the result for the operator instead of pasting large raw payloads unless they asked for full output.",
    "",
    "## Notes",
    "",
    "- If the requested provider or tool is not listed, say the integration is not connected to this agent.",
    "- Prefer configured defaults like the synced org or repo when the operator does not specify a target.",
    "- For large file reads, summarize first and quote only the portion the operator asked for.",
    "",
  ];

  if (executableTools.length === 0) {
    lines.push("No executable Nora integration tools are currently synced to this agent.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Connected Executable Tools");
  lines.push("");

  for (const { integration, spec, execution } of executableTools) {
    lines.push(`- \`${execution.runtimeToolName}\` (${integration.provider})`);
    lines.push(`  ${normalizeString(spec.description) || "No description provided."}`);
    if (execution.invokeCommand) {
      lines.push(`  Example: \`${execution.invokeCommand}\``);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function findIntegrationTool(integrations = [], toolName) {
  const normalizedToolName = normalizeString(toolName);
  if (!normalizedToolName) return null;

  for (const integration of Array.isArray(integrations) ? integrations : []) {
    const toolSpecs = Array.isArray(integration.toolSpecs)
      ? integration.toolSpecs
      : [];

    for (const spec of toolSpecs) {
      if (normalizeString(spec.name) !== normalizedToolName) continue;
      return {
        integration,
        spec,
        execution: buildIntegrationToolExecutionMetadata(integration, spec),
      };
    }
  }

  return null;
}

function assertRuntimeFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof fetch === "function") return fetch;
  throw new Error("Fetch is not available in this runtime");
}

function clampInteger(value, { fallback, min = 1, max = 100 }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeIntegrationConfig(integration = {}) {
  return integration.config && typeof integration.config === "object"
    ? integration.config
    : {};
}

function getGitHubToken(integration = {}) {
  const config = normalizeIntegrationConfig(integration);
  return (
    normalizeString(config.personal_access_token) ||
    normalizeString(config.access_token) ||
    normalizeString(config.token) ||
    normalizeString(process.env.GITHUB_TOKEN)
  );
}

function getGitHubBaseUrl(integration = {}) {
  const configuredBaseUrl =
    normalizeString(integration?.api?.baseUrl) ||
    normalizeString(normalizeIntegrationConfig(integration).base_url) ||
    DEFAULT_GITHUB_API_BASE_URL;
  const url = new URL(configuredBaseUrl);

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Unsupported GitHub API protocol: ${url.protocol}`);
  }

  return url;
}

async function readResponseBody(response) {
  const rawText = await response.text();
  if (!rawText) return { rawText: "", data: null };

  try {
    return { rawText, data: JSON.parse(rawText) };
  } catch {
    return { rawText, data: null };
  }
}

function buildGitHubRequestUrl(integration, requestPath, query = {}) {
  const baseUrl = getGitHubBaseUrl(integration);
  const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const basePath =
    baseUrl.pathname && baseUrl.pathname !== "/"
      ? baseUrl.pathname.replace(/\/+$/, "")
      : "";
  baseUrl.pathname = `${basePath}${normalizedPath}`;

  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    baseUrl.searchParams.set(key, String(value));
  }

  return baseUrl.toString();
}

async function gitHubRequest({
  integration,
  requestPath,
  query,
  method = "GET",
  body = null,
  fetchImpl,
}) {
  const token = getGitHubToken(integration);
  if (!token) {
    throw new Error("GitHub token is not configured for this agent");
  }

  const fetcher = assertRuntimeFetch(fetchImpl);
  const url = buildGitHubRequestUrl(integration, requestPath, query);
  const response = await fetcher(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Nora-Agent-Runtime",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const { rawText, data } = await readResponseBody(response);
  if (!response.ok) {
    const message =
      normalizeString(data?.message) ||
      normalizeString(rawText) ||
      `GitHub API returned ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }

  return data ?? rawText;
}

function mapGitHubRepository(repo = {}) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private === true,
    description: repo.description || "",
    default_branch: repo.default_branch || null,
    html_url: repo.html_url || null,
    language: repo.language || null,
    archived: repo.archived === true,
    fork: repo.fork === true,
    updated_at: repo.updated_at || null,
  };
}

function mapGitHubPullRequest(pr = {}) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft === true,
    html_url: pr.html_url || null,
    author: pr.user?.login || null,
    created_at: pr.created_at || null,
    updated_at: pr.updated_at || null,
    head: pr.head?.ref || null,
    base: pr.base?.ref || null,
  };
}

function mapGitHubIssue(issue = {}) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url || null,
    created_at: issue.created_at || null,
    updated_at: issue.updated_at || null,
  };
}

async function resolveGitHubOwnerType(integration, owner, fetchImpl) {
  const data = await gitHubRequest({
    integration,
    requestPath: `/users/${encodeURIComponent(owner)}`,
    fetchImpl,
  });
  return data?.type === "Organization" ? "Organization" : "User";
}

async function resolveGitHubOwner(integration, input, fetchImpl) {
  const config = normalizeIntegrationConfig(integration);
  const explicitOwner = normalizeString(input.owner);
  if (explicitOwner) return explicitOwner;

  const configuredOrg = normalizeString(config.org);
  if (configuredOrg) return configuredOrg;

  const viewer = await gitHubRequest({
    integration,
    requestPath: "/user",
    fetchImpl,
  });
  if (!normalizeString(viewer?.login)) {
    throw new Error("Could not resolve a default GitHub owner");
  }
  return viewer.login;
}

function resolveGitHubRepo(integration, input) {
  const config = normalizeIntegrationConfig(integration);
  const repo = normalizeString(input.repo) || normalizeString(config.repo);
  if (!repo) {
    throw new Error("GitHub repository is required");
  }
  return repo;
}

function filterRepositoriesByVisibility(repositories = [], visibility = "all") {
  if (visibility === "public") {
    return repositories.filter((repo) => repo.private !== true);
  }
  if (visibility === "private") {
    return repositories.filter((repo) => repo.private === true);
  }
  return repositories;
}

function decodeGitHubFileContent(file = {}) {
  const encodedContent = normalizeString(file.content).replace(/\n/g, "");
  if (!encodedContent || file.encoding !== "base64") {
    return {
      content: normalizeString(file.content),
      truncated: false,
    };
  }

  const decoded = Buffer.from(encodedContent, "base64").toString("utf8");
  if (decoded.length <= MAX_GITHUB_FILE_CONTENT_CHARS) {
    return {
      content: decoded,
      truncated: false,
    };
  }

  return {
    content: decoded.slice(0, MAX_GITHUB_FILE_CONTENT_CHARS),
    truncated: true,
  };
}

async function executeGitHubOperation({
  integration,
  spec,
  input,
  fetchImpl,
}) {
  const normalizedInput = normalizeIntegrationToolInput(input);
  const operation = normalizeString(spec.operation);

  switch (operation) {
    case "repos.list": {
      const perPage = clampInteger(normalizedInput.per_page, {
        fallback: 20,
        min: 1,
        max: 100,
      });
      const visibility = normalizeString(normalizedInput.visibility) || "all";
      const requestedOwner = normalizeString(normalizedInput.owner);

      if (requestedOwner || normalizeString(normalizeIntegrationConfig(integration).org)) {
        const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
        const ownerType = await resolveGitHubOwnerType(integration, owner, fetchImpl);
        const repositories = await gitHubRequest({
          integration,
          requestPath:
            ownerType === "Organization"
              ? `/orgs/${encodeURIComponent(owner)}/repos`
              : `/users/${encodeURIComponent(owner)}/repos`,
          query: {
            per_page: perPage,
            sort: "updated",
          },
          fetchImpl,
        });

        return {
          owner,
          ownerType,
          repositories: filterRepositoriesByVisibility(
            Array.isArray(repositories) ? repositories : [],
            visibility
          ).map(mapGitHubRepository),
        };
      }

      const repositories = await gitHubRequest({
        integration,
        requestPath: "/user/repos",
        query: {
          per_page: perPage,
          sort: "updated",
          visibility,
          affiliation: "owner,organization_member,collaborator",
        },
        fetchImpl,
      });

      return {
        owner: null,
        ownerType: "AuthenticatedUser",
        repositories: (Array.isArray(repositories) ? repositories : []).map(
          mapGitHubRepository
        ),
      };
    }

    case "repos.contents.get": {
      const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
      const repo = resolveGitHubRepo(integration, normalizedInput);
      const filePath = normalizeString(normalizedInput.path);
      if (!filePath) {
        throw new Error("GitHub file path is required");
      }

      const encodedPath = filePath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const data = await gitHubRequest({
        integration,
        requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
        query: {
          ref: normalizeString(normalizedInput.ref) || undefined,
        },
        fetchImpl,
      });

      if (Array.isArray(data)) {
        return {
          owner,
          repo,
          path: filePath,
          type: "directory",
          entries: data.map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size,
            html_url: entry.html_url || null,
          })),
        };
      }

      const decoded = decodeGitHubFileContent(data);
      return {
        owner,
        repo,
        path: data.path || filePath,
        type: data.type || "file",
        sha: data.sha || null,
        size: data.size || 0,
        encoding: data.encoding || null,
        download_url: data.download_url || null,
        html_url: data.html_url || null,
        content: decoded.content,
        truncated: decoded.truncated,
      };
    }

    case "pulls.list": {
      const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
      const repo = resolveGitHubRepo(integration, normalizedInput);
      const state = normalizeString(normalizedInput.state) || "open";
      const pulls = await gitHubRequest({
        integration,
        requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        query: { state },
        fetchImpl,
      });

      return {
        owner,
        repo,
        state,
        pullRequests: (Array.isArray(pulls) ? pulls : []).map(mapGitHubPullRequest),
      };
    }

    case "issues.create": {
      const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
      const repo = resolveGitHubRepo(integration, normalizedInput);
      const title = normalizeString(normalizedInput.title);
      if (!title) {
        throw new Error("GitHub issue title is required");
      }

      const issue = await gitHubRequest({
        integration,
        requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        method: "POST",
        body: {
          title,
          body: normalizeString(normalizedInput.body) || undefined,
        },
        fetchImpl,
      });

      return {
        owner,
        repo,
        issue: mapGitHubIssue(issue),
      };
    }

    default:
      throw new Error(`Unsupported GitHub integration operation: ${operation}`);
  }
}

async function executeIntegrationToolInvocation({
  toolName,
  input = {},
  integrations = null,
  fetchImpl,
}) {
  const syncedIntegrations = Array.isArray(integrations)
    ? integrations
    : loadSyncedIntegrations();
  const match = findIntegrationTool(syncedIntegrations, toolName);

  if (!match) {
    throw new Error(`Nora integration tool "${toolName}" is not synced to this agent`);
  }

  if (!match.execution.executable) {
    throw new Error(
      `Nora integration tool "${toolName}" is connected but not executable in this runtime`
    );
  }

  let result;
  switch (normalizeString(match.integration.provider).toLowerCase()) {
    case "github":
      result = await executeGitHubOperation({
        integration: match.integration,
        spec: match.spec,
        input,
        fetchImpl,
      });
      break;
    default:
      throw new Error(
        `Nora integration provider "${match.integration.provider}" is not executable in this runtime`
      );
  }

  return {
    ok: true,
    toolName: match.spec.name,
    provider: match.integration.provider,
    providerName: match.integration.name || match.integration.provider,
    operation: match.spec.operation || null,
    input: normalizeIntegrationToolInput(input),
    result,
    executedAt: new Date().toISOString(),
  };
}

module.exports = {
  NORA_INTEGRATION_TOOL_COMMAND,
  NORA_INTEGRATIONS_SKILL_FILE,
  NORA_INTEGRATIONS_SKILL_NAME,
  NORA_SYNC_INTEGRATIONS_FILE,
  buildIntegrationSkillMarkdown,
  buildIntegrationToolExecutionMetadata,
  executeIntegrationToolInvocation,
  getExecutableIntegrationTools,
  isIntegrationToolExecutable,
  loadSyncedIntegrations,
  normalizeIntegrationToolInput,
};
