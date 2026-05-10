// Domain types for the integrations module.
// These describe the shapes that flow between the database, the catalog,
// and the runtime sync layer. They are intentionally permissive on `config`
// (it can arrive as a JSON string from Postgres or already-parsed) so the
// repository and service layers can hydrate them safely.

export type ConfigBlob = Record<string, unknown> | string | null | undefined;

export interface IntegrationRow {
  id: string;
  agent_id: string;
  provider: string;
  catalog_id: string | null;
  access_token: string | null;
  config: ConfigBlob;
  status: string;
  created_at?: string | Date;
  // Optional fields populated by joined catalog reads (listIntegrations).
  catalog_name?: string | null;
  catalog_icon?: string | null;
  catalog_category?: string | null;
  catalog_description?: string | null;
  auth_type?: string | null;
  config_schema?: string | Record<string, unknown> | null;
}

export interface IntegrationCatalogRow {
  id: string;
  name: string;
  icon?: string | null;
  category?: string | null;
  description?: string | null;
  auth_type?: string | null;
  config_schema?: string | Record<string, unknown> | null;
  enabled?: boolean;
}

export interface CatalogConfigField {
  key: string;
  type?: string;
  required?: boolean;
  label?: string;
  placeholder?: string;
  description?: string;
}

export interface CatalogToolSpec {
  name: string;
  description?: string;
  operation?: string;
  inputSchema?: Record<string, unknown>;
  capabilities?: string[];
}

export interface CatalogSetupGuide {
  steps: string[];
  scopes?: string[];
}

export interface CatalogMcpInfo {
  available: boolean;
  transport?: "stdio" | "sse" | "http";
  npmPackage?: string;
  pyPackage?: string;
  serverUrl?: string;
  docsUrl?: string;
  notes?: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  icon?: string | null;
  category?: string | null;
  description?: string | null;
  authType?: string;
  configFields?: CatalogConfigField[];
  capabilities?: string[];
  toolSpecs?: CatalogToolSpec[];
  api?: Record<string, unknown> | null;
  mcp?: CatalogMcpInfo | Record<string, unknown> | null;
  usageHints?: string[];
  credentialsUrl?: string;
  setupGuide?: CatalogSetupGuide;
}

export interface SyncEntry {
  id: string;
  provider: string;
  name: string;
  category: string | null;
  authType: string;
  activatedAt: string | Date | null;
  expiresAt: string | null;
  config: Record<string, unknown>;
  redactedConfig: Record<string, unknown>;
  status: string;
  capabilities: string[];
  toolSpecs: CatalogToolSpec[];
  mcp: Record<string, unknown> | null;
  api: Record<string, unknown> | null;
  usageHints: string[];
  credentialEnv: {
    primary: string | null;
    config: Record<string, string>;
  };
}

export interface ToolCatalogEntry {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  nora: {
    source: "integration-manifest";
    executable: boolean;
    executionState: "runtime_skill";
    executor: string;
    provider: string;
    integrationId: string;
    operation?: string;
    runtimeToolName: string;
    invokeCommand: string;
    exampleInput?: Record<string, unknown>;
    authType?: string;
    capabilities?: string[];
    api?: Record<string, unknown> | null;
    mcp?: Record<string, unknown> | null;
    usageHints?: string[];
    config?: Record<string, unknown>;
  };
}

export interface OAuthStateRow {
  state: string;
  provider: string;
  user_id: string;
  agent_id: string;
  code_verifier: string;
  client_id: string;
  client_secret: string | null;
  config: ConfigBlob;
  redirect_path: string;
  expires_at: string | Date;
  agent_user_id?: string;
}
