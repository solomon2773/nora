// API-level helpers for the real-creds specs. Everything goes through the
// platform HTTP API — no DB or shell access, so the same helpers work whether
// the backend runs under docker-compose.yml or docker-compose.e2e.yml.

import type { APIRequestContext } from "@playwright/test";
import { apiJson, assertJsonRecord, isJsonRecord } from "./app";

type PlatformRuntimeFamily = {
  id?: string;
  runtimeFamily?: string;
};

type PlatformConfig = {
  enabledBackends?: string[];
  enabledDeployTargets?: string[];
  runtimeFamilies?: PlatformRuntimeFamily[];
  [key: string]: unknown;
};

type AgentRecord = {
  id: string;
  status?: string;
  status_message?: string;
  runtime_family?: string;
  name?: string;
  [key: string]: unknown;
};

type DeployAgentOptions = {
  name?: string;
  runtimeFamily?: string;
  backend?: string;
  sandboxProfile?: string;
  vcpu?: number;
  ramMb?: number;
  diskGb?: number;
  image?: string;
  model?: string;
};

type WaitForAgentStatusOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

type SaveProviderKeyOptions = {
  provider: string;
  apiKey: string;
  model?: string;
};

type IntegrationOptions = {
  provider: string;
  token: string;
  config?: Record<string, unknown>;
};

type ChannelOptions = {
  type: string;
  name: string;
  config?: Record<string, unknown>;
};

type IntegrationRecord = {
  id: string;
  provider?: string;
  [key: string]: unknown;
};

type IntegrationTestResult = {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
};

type ChannelRecord = {
  id: string;
  type?: string;
  name?: string;
  [key: string]: unknown;
};

type ChannelTestResult = {
  delivered?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function ensureAgentRecord(
  value: AgentRecord | string | null,
  description: string
): AgentRecord {
  const record = assertJsonRecord<AgentRecord>(value, description);
  if (typeof record.id !== "string" || !record.id) {
    throw new Error(`Expected agent id in ${description}`);
  }
  return record;
}

function ensureIntegrationRecord(
  value: IntegrationRecord | string | null,
  description: string
): IntegrationRecord {
  const record = assertJsonRecord<IntegrationRecord>(value, description);
  if (typeof record.id !== "string" || !record.id) {
    throw new Error(`Expected integration id in ${description}`);
  }
  return record;
}

function ensureChannelRecord(
  value: ChannelRecord | string | null,
  description: string
): ChannelRecord {
  const record = assertJsonRecord<ChannelRecord>(value, description);
  if (typeof record.id !== "string" || !record.id) {
    throw new Error(`Expected channel id in ${description}`);
  }
  return record;
}

function normalizePlatformConfig(
  value: PlatformConfig | string | null
): PlatformConfig {
  if (!isJsonRecord(value)) {
    return {};
  }

  return {
    ...value,
    enabledBackends: isStringArray(value.enabledBackends)
      ? value.enabledBackends
      : undefined,
    enabledDeployTargets: isStringArray(value.enabledDeployTargets)
      ? value.enabledDeployTargets
      : undefined,
    runtimeFamilies: Array.isArray(value.runtimeFamilies)
      ? value.runtimeFamilies.filter(isJsonRecord) as PlatformRuntimeFamily[]
      : undefined,
  };
}

async function getPlatformConfig(request: APIRequestContext, token: string) {
  const { body } = await apiJson<PlatformConfig>(request, "/api/config/platform", { token });
  return normalizePlatformConfig(body);
}

function backendSupported(platform: PlatformConfig, backendId: string) {
  const enabled = platform.enabledBackends || platform.enabledDeployTargets || [];
  return enabled.includes(backendId);
}

function runtimeSupported(platform: PlatformConfig, runtimeFamily: string) {
  const families = Array.isArray(platform.runtimeFamilies)
    ? platform.runtimeFamilies
    : [];
  return families.some(
    (fam) => (fam?.id || fam?.runtimeFamily) === runtimeFamily
  );
}

async function deployAgent(
  request: APIRequestContext,
  token: string,
  {
    name,
    runtimeFamily = "openclaw",
    backend = "docker",
    sandboxProfile = "standard",
    vcpu = 1,
    ramMb = 1024,
    diskGb = 5,
    image,
    model,
  }: DeployAgentOptions = {}
) {
  const { body } = await apiJson<AgentRecord>(request, "/api/agents/deploy", {
    method: "POST",
    token,
    data: {
      name,
      runtime_family: runtimeFamily,
      backend_type: backend,
      deploy_target: backend,
      sandbox_profile: sandboxProfile,
      vcpu,
      ram_mb: ramMb,
      disk_gb: diskGb,
      image,
      model,
    },
  });
  return ensureAgentRecord(body, "/api/agents/deploy");
}

async function getAgent(request: APIRequestContext, token: string, agentId: string) {
  const { body } = await apiJson<AgentRecord>(request, `/api/agents/${agentId}`, { token });
  return ensureAgentRecord(body, `/api/agents/${agentId}`);
}

async function waitForAgentStatus(
  request: APIRequestContext,
  token: string,
  agentId: string,
  desiredStatuses: string | string[],
  { timeoutMs = 300000, intervalMs = 5000 }: WaitForAgentStatusOptions = {}
) {
  const targets = Array.isArray(desiredStatuses)
    ? desiredStatuses
    : [desiredStatuses];
  const startedAt = Date.now();
  let lastStatus = "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const agent = await getAgent(request, token, agentId);
      lastStatus = agent?.status || "unknown";
      if (targets.includes(lastStatus)) return agent;
      if (lastStatus === "error" && !targets.includes("error")) {
        throw new Error(
          `Agent ${agentId} entered error state (last message: ${agent?.status_message || "none"})`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("error state")) {
        throw error;
      }
      // 404 / transient — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for agent ${agentId} to reach ${targets.join(" | ")}; last status: ${lastStatus}`
  );
}

async function stopAgent(request: APIRequestContext, token: string, agentId: string) {
  // Backend may take >60s on K8s while it waits for the runtime to fully
  // settle; nginx returns 504 in that window. Either is fine — the actual
  // stop kicked off, and the test polls status afterwards.
  const { response, body } = await apiJson(request, `/api/agents/${agentId}/stop`, {
    method: "POST",
    token,
    failOnStatus: false,
  });
  if (!response.ok() && response.status() !== 504) {
    throw new Error(`stopAgent: ${response.status()} ${JSON.stringify(body)}`);
  }
}

async function startAgent(request: APIRequestContext, token: string, agentId: string) {
  const { response, body } = await apiJson(request, `/api/agents/${agentId}/start`, {
    method: "POST",
    token,
    failOnStatus: false,
  });
  if (!response.ok() && response.status() !== 504) {
    throw new Error(`startAgent: ${response.status()} ${JSON.stringify(body)}`);
  }
}

async function deleteAgent(request: APIRequestContext, token: string, agentId: string) {
  await apiJson(request, `/api/agents/${agentId}`, {
    method: "DELETE",
    token,
    failOnStatus: false,
  });
}

async function chatOpenClaw(request: APIRequestContext, token: string, agentId: string, message: string) {
  const { body } = await apiJson(
    request,
    `/api/agents/${agentId}/gateway/chat`,
    {
      method: "POST",
      token,
      data: { message, stream: false },
    }
  );
  return body;
}

async function chatHermes(request: APIRequestContext, token: string, agentId: string, message: string) {
  const { body } = await apiJson(
    request,
    `/api/agents/${agentId}/hermes-ui/chat`,
    {
      method: "POST",
      token,
      data: { messages: [{ role: "user", content: message }] },
    }
  );
  return body;
}

async function chatWithAgent(request: APIRequestContext, token: string, agent: AgentRecord, message: string) {
  const family = agent.runtime_family || "openclaw";
  if (family === "hermes") return chatHermes(request, token, agent.id, message);
  return chatOpenClaw(request, token, agent.id, message);
}

// ── LLM provider key ──────────────────────────────────────
async function saveProviderKey(
  request: APIRequestContext,
  token: string,
  { provider, apiKey, model }: SaveProviderKeyOptions
) {
  const { body } = await apiJson(request, "/api/llm-providers", {
    method: "POST",
    token,
    data: { provider, apiKey, model },
  });
  return body;
}

async function listProviders(request: APIRequestContext, token: string) {
  const { body } = await apiJson(request, "/api/llm-providers", { token });
  return Array.isArray(body) ? body : [];
}

// ── Integrations ──────────────────────────────────────────
async function connectIntegration(
  request: APIRequestContext,
  token: string,
  agentId: string,
  { provider, token: providerToken, config = {} }: IntegrationOptions
) {
  const { body } = await apiJson<IntegrationRecord>(
    request,
    `/api/agents/${agentId}/integrations`,
    {
      method: "POST",
      token,
      data: { provider, token: providerToken, config },
    }
  );
  return ensureIntegrationRecord(body, `/api/agents/${agentId}/integrations`);
}

async function testIntegration(request: APIRequestContext, token: string, agentId: string, integrationId: string) {
  const { body } = await apiJson<IntegrationTestResult>(
    request,
    `/api/agents/${agentId}/integrations/${integrationId}/test`,
    { method: "POST", token, failOnStatus: false }
  );
  return assertJsonRecord<IntegrationTestResult>(
    body,
    `/api/agents/${agentId}/integrations/${integrationId}/test`
  );
}

async function listAgentIntegrations(request: APIRequestContext, token: string, agentId: string) {
  const { body } = await apiJson(
    request,
    `/api/agents/${agentId}/integrations`,
    { token }
  );
  return Array.isArray(body)
    ? body.filter(isJsonRecord) as IntegrationRecord[]
    : [];
}

async function deleteIntegration(request: APIRequestContext, token: string, agentId: string, integrationId: string) {
  await apiJson(
    request,
    `/api/agents/${agentId}/integrations/${integrationId}`,
    { method: "DELETE", token, failOnStatus: false }
  );
}

// ── Channels ──────────────────────────────────────────────
async function createChannel(
  request: APIRequestContext,
  token: string,
  agentId: string,
  { type, name, config = {} }: ChannelOptions
) {
  const { body, response } = await apiJson<ChannelRecord>(
    request,
    `/api/agents/${agentId}/channels`,
    {
      method: "POST",
      token,
      data: { type, name, config },
      failOnStatus: false,
    }
  );
  if (!response.ok()) {
    throw Object.assign(
      new Error(
        `createChannel(${type}) failed: ${response.status()} ${JSON.stringify(body)}`
      ),
      { status: response.status(), body }
    );
  }
  return ensureChannelRecord(body, `/api/agents/${agentId}/channels`);
}

async function testChannel(request: APIRequestContext, token: string, agentId: string, channelId: string) {
  const { body } = await apiJson<ChannelTestResult>(
    request,
    `/api/agents/${agentId}/channels/${channelId}/test`,
    { method: "POST", token, failOnStatus: false }
  );
  return assertJsonRecord<ChannelTestResult>(
    body,
    `/api/agents/${agentId}/channels/${channelId}/test`
  );
}

async function deleteChannel(request: APIRequestContext, token: string, agentId: string, channelId: string) {
  await apiJson(request, `/api/agents/${agentId}/channels/${channelId}`, {
    method: "DELETE",
    token,
    failOnStatus: false,
  });
}

export {
  getPlatformConfig,
  backendSupported,
  runtimeSupported,
  deployAgent,
  getAgent,
  waitForAgentStatus,
  stopAgent,
  startAgent,
  deleteAgent,
  chatWithAgent,
  chatOpenClaw,
  chatHermes,
  saveProviderKey,
  listProviders,
  connectIntegration,
  testIntegration,
  listAgentIntegrations,
  deleteIntegration,
  createChannel,
  testChannel,
  deleteChannel,
};
