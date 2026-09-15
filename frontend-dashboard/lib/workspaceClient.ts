// Workspace + membership API helpers. Wraps fetchWithAuth so callers don't
// have to replicate the headers/credentials boilerplate.

import { fetchWithAuth } from "./api";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  user_id: string;
  created_at: string;
  role: WorkspaceRole | null;
  agent_count?: number;
  member_count?: number;
}

export interface WorkspaceAgent {
  id: string;
  workspaceId: string;
  agentId: string;
  role: string;
  assignedAt: string;
  agentName: string;
  agentStatus: string;
  name?: string;
  status?: string;
  isDirectOwner: boolean;
  runtime_family?: string | null;
  deploy_target?: string | null;
  execution_target_id?: string | null;
  sandbox_profile?: string | null;
  backend_type?: string | null;
}

export interface WorkspaceAgentCandidate {
  id: string;
  agentId: string;
  name: string;
  status: string;
  assigned: boolean;
  runtime_family?: string | null;
  deploy_target?: string | null;
  execution_target_id?: string | null;
  sandbox_profile?: string | null;
  backend_type?: string | null;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  invitedBy: string | null;
  createdAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  token?: string;
  emailDelivery?: { sent: boolean; error?: string; messageId?: string };
}

const ACTIVE_WORKSPACE_KEY = "nora.activeWorkspaceId";
const ACTIVE_WORKSPACE_EVENT = "nora:active-workspace-changed";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await fetchWithAuth("/api/workspaces");
  return jsonOrThrow<Workspace[]>(res);
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/members`);
  return jsonOrThrow<WorkspaceMember[]>(res);
}

export async function listWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgent[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/agents`);
  return jsonOrThrow<WorkspaceAgent[]>(res);
}

export async function listWorkspaceAgentCandidates(
  workspaceId: string,
): Promise<WorkspaceAgentCandidate[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/agent-candidates`);
  return jsonOrThrow<WorkspaceAgentCandidate[]>(res);
}

export async function assignWorkspaceAgent(
  workspaceId: string,
  agentId: string,
  role = "member",
): Promise<{ id: string; workspace_id: string; agent_id: string; role: string }> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/agents`, {
    method: "POST",
    body: JSON.stringify({ agentId, role }),
  });
  return jsonOrThrow<{ id: string; workspace_id: string; agent_id: string; role: string }>(res);
}

export async function removeWorkspaceAgent(workspaceId: string, agentId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/agents/${agentId}`, {
    method: "DELETE",
  });
  await jsonOrThrow<{ success: boolean }>(res);
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
  return jsonOrThrow<WorkspaceMember>(res);
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
  await jsonOrThrow<{ success: boolean }>(res);
}

export async function listInvitations(
  workspaceId: string,
  { includeRevoked = false }: { includeRevoked?: boolean } = {},
): Promise<WorkspaceInvitation[]> {
  const url = `/api/workspaces/${workspaceId}/invitations${
    includeRevoked ? "?includeRevoked=true" : ""
  }`;
  const res = await fetchWithAuth(url);
  return jsonOrThrow<WorkspaceInvitation[]>(res);
}

export async function createInvitation(
  workspaceId: string,
  email: string,
  role: Exclude<WorkspaceRole, "owner">,
): Promise<WorkspaceInvitation> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/invitations`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
  return jsonOrThrow<WorkspaceInvitation>(res);
}

export async function revokeInvitation(
  workspaceId: string,
  invitationId: string,
): Promise<WorkspaceInvitation> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, {
    method: "DELETE",
  });
  return jsonOrThrow<WorkspaceInvitation>(res);
}

export async function acceptInvitation(
  token: string,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const res = await fetchWithAuth("/api/workspaces/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return jsonOrThrow<{ workspaceId: string; role: WorkspaceRole }>(res);
}

export interface ApiKeyScope {
  value: string;
  description: string;
}

export interface ApiKey {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  label: string;
  keyPrefix: string;
  maskedKey: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  apiKey?: string;
}

export async function listApiKeyScopes(workspaceId: string): Promise<ApiKeyScope[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/api-keys/scopes`);
  return jsonOrThrow<ApiKeyScope[]>(res);
}

export async function listApiKeys(workspaceId: string): Promise<ApiKey[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/api-keys`);
  return jsonOrThrow<ApiKey[]>(res);
}

export async function createApiKey(
  workspaceId: string,
  payload: { label: string; scopes: string[]; expiresAt?: string | null },
): Promise<ApiKey> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/api-keys`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<ApiKey>(res);
}

export async function revokeApiKey(workspaceId: string, keyId: string): Promise<ApiKey> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/api-keys/${keyId}`, {
    method: "DELETE",
  });
  return jsonOrThrow<ApiKey>(res);
}

export interface AlertChannel {
  type: "webhook";
  url: string;
  headers?: Record<string, string>;
}

export interface AlertRule {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  name: string;
  eventPattern: string;
  channels: AlertChannel[];
  enabled: boolean;
  lastFiredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAlertRules(workspaceId: string): Promise<AlertRule[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/alert-rules`);
  return jsonOrThrow<AlertRule[]>(res);
}

export async function createAlertRule(
  workspaceId: string,
  payload: { name: string; eventPattern: string; channels: AlertChannel[]; enabled?: boolean },
): Promise<AlertRule> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/alert-rules`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<AlertRule>(res);
}

export async function updateAlertRule(
  workspaceId: string,
  ruleId: string,
  payload: Partial<{
    name: string;
    eventPattern: string;
    channels: AlertChannel[];
    enabled: boolean;
  }>,
): Promise<AlertRule> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/alert-rules/${ruleId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<AlertRule>(res);
}

export async function deleteAlertRule(workspaceId: string, ruleId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/alert-rules/${ruleId}`, {
    method: "DELETE",
  });
  await jsonOrThrow<{ success: boolean }>(res);
}

export async function testAlertRule(workspaceId: string, ruleId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/alert-rules/${ruleId}/test`, {
    method: "POST",
  });
  await jsonOrThrow<{ success: boolean }>(res);
}

export interface AgentCostEntry {
  agentId: string;
  agentName: string;
  status?: string | null;
  runtime_family?: string | null;
  deploy_target?: string | null;
  execution_target_id?: string | null;
  sandbox_profile?: string | null;
  backend_type?: string | null;
  workspaceRole?: string | null;
  token_cost: number;
  total_cost: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  cost_details?: {
    tokens?: {
      fallback_per_1k?: number;
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      total_cost?: number;
      models?: Array<{
        model: string;
        provider?: string | null;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        token_cost: number;
        request_count: number;
        rate_source: "model" | "model_total" | "fallback" | "unknown" | string;
        rates?: {
          input_per_1k?: number | null;
          output_per_1k?: number | null;
          per_1k?: number | null;
        };
      }>;
    };
  };
}

export interface WorkspaceCost {
  workspaceId: string;
  periodDays: number;
  periodStart: string;
  periodEnd: string;
  totalUsd: number;
  perAgent: AgentCostEntry[];
  crossings: Array<{
    bucket: "soft" | "hard";
    pct: number;
    currentUsd: number;
    budget: WorkspaceBudget;
  }>;
}

export interface WorkspaceCostGroup extends WorkspaceCost {
  workspaceName: string;
  role: WorkspaceRole | null;
}

export interface WorkspaceCostSummary {
  periodDays: number;
  periodStart: string;
  periodEnd: string;
  workspaceTotalUsd: number;
  uniqueFleetTotalUsd: number;
  workspaces: WorkspaceCostGroup[];
  unassigned: {
    totalUsd: number;
    perAgent: AgentCostEntry[];
  };
}

export interface WorkspaceBudget {
  id: string;
  workspaceId: string;
  period: "daily" | "weekly" | "monthly";
  limitUsd: number;
  softThresholdPct: number;
  lastAlertedAt: string | null;
  lastAlertedPct: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CostQueryOptions {
  periodDays?: number;
  periodStart?: string;
  periodEnd?: string;
}

function buildCostQuery({ periodDays = 30, periodStart, periodEnd }: CostQueryOptions = {}) {
  const params = new URLSearchParams();
  if (periodStart || periodEnd) {
    if (periodStart) params.set("period_start", periodStart);
    if (periodEnd) params.set("period_end", periodEnd);
  } else {
    params.set("period_days", String(periodDays));
  }
  return params.toString();
}

export async function getWorkspaceCost(
  workspaceId: string,
  options: CostQueryOptions = {},
): Promise<WorkspaceCost> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/cost?${buildCostQuery(options)}`);
  return jsonOrThrow<WorkspaceCost>(res);
}

export async function getWorkspaceCostSummary(
  options: CostQueryOptions = {},
): Promise<WorkspaceCostSummary> {
  const res = await fetchWithAuth(`/api/workspaces/cost?${buildCostQuery(options)}`);
  return jsonOrThrow<WorkspaceCostSummary>(res);
}

export async function listBudgets(workspaceId: string): Promise<WorkspaceBudget[]> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/budgets`);
  return jsonOrThrow<WorkspaceBudget[]>(res);
}

export async function upsertBudget(
  workspaceId: string,
  payload: {
    period: "daily" | "weekly" | "monthly";
    limitUsd: number;
    softThresholdPct?: number;
  },
): Promise<WorkspaceBudget> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/budgets`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<WorkspaceBudget>(res);
}

export async function deleteBudget(workspaceId: string, budgetId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/budgets/${budgetId}`, {
    method: "DELETE",
  });
  await jsonOrThrow<{ success: boolean }>(res);
}

export interface AgentVersion {
  id: string;
  agentId: string;
  versionNumber: number;
  config: any;
  createdBy: string | null;
  message: string | null;
  source: "edit" | "deploy" | "redeploy" | "duplicate" | "hub-install" | "restore" | "rollback";
  createdAt: string;
}

export async function listAgentVersions(agentId: string): Promise<AgentVersion[]> {
  const res = await fetchWithAuth(`/api/agents/${agentId}/versions`);
  return jsonOrThrow<AgentVersion[]>(res);
}

export async function getAgentVersion(agentId: string, versionId: string): Promise<AgentVersion> {
  const res = await fetchWithAuth(`/api/agents/${agentId}/versions/${versionId}`);
  return jsonOrThrow<AgentVersion>(res);
}

export async function rollbackAgent(
  agentId: string,
  versionId: string,
): Promise<{ success: boolean; restored: AgentVersion; redeployed: boolean }> {
  const res = await fetchWithAuth(`/api/agents/${agentId}/rollback/${versionId}`, {
    method: "POST",
  });
  return jsonOrThrow<{ success: boolean; restored: AgentVersion; redeployed: boolean }>(res);
}

// Active-workspace selection lives in localStorage so it survives reloads.
// Components that care can subscribe to the custom event.

export function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
}

export function setActiveWorkspaceId(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  if (workspaceId) {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
  } else {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  }
  window.dispatchEvent(new CustomEvent(ACTIVE_WORKSPACE_EVENT, { detail: workspaceId }));
}

export function subscribeToActiveWorkspace(handler: (id: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<string | null>).detail ?? null;
    handler(detail);
  };
  window.addEventListener(ACTIVE_WORKSPACE_EVENT, listener);
  return () => window.removeEventListener(ACTIVE_WORKSPACE_EVENT, listener);
}

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function roleSatisfies(actual: WorkspaceRole | null, required: WorkspaceRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// `GET`/`PUT /workspaces/:id/log-settings` — see backend-api/routes/
// observability.ts's `readWorkspaceLogSettingsRow`/PUT handler for the exact
// contract. `traceSampleRate` is read-only here on purpose (see that file):
// no PUT field changes it, it stays whatever the column already holds.
export interface WorkspaceLogSettings {
  runtimeRetentionDays: number;
  traceRetentionDays: number;
  gatewayLogsEnabled: boolean;
  tracesEnabled: boolean;
  traceSampleRate: number;
}

export async function getWorkspaceLogSettings(workspaceId: string): Promise<WorkspaceLogSettings> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/log-settings`);
  return jsonOrThrow<WorkspaceLogSettings>(res);
}

export async function updateWorkspaceLogSettings(
  workspaceId: string,
  payload: Partial<{
    runtimeRetentionDays: number;
    traceRetentionDays: number;
    gatewayLogsEnabled: boolean;
    tracesEnabled: boolean;
  }>,
): Promise<WorkspaceLogSettings> {
  const res = await fetchWithAuth(`/api/workspaces/${workspaceId}/log-settings`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<WorkspaceLogSettings>(res);
}
