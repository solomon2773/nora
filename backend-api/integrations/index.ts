// Canonical entry point for the integrations feature module. New code
// should import from "./integrations" rather than the legacy shim at
// backend-api/integrations.ts.
//
// The shim continues to exist for the original CommonJS callers
// (server.ts, gatewayProxy.ts, agentMigrations.ts, agentPayloads.ts,
// authSync.ts, routes/integrations.ts) and will be retired once those
// migrate to import from this module path directly.

export * from "./types/integration";
export * from "./types/provider";

export { createIntegrationsRepository } from "./repository/integrationsRepository";
export type { IntegrationsRepository } from "./repository/integrationsRepository";
export { createOAuthStatesRepository } from "./repository/oauthStatesRepository";
export type { OAuthStatesRepository } from "./repository/oauthStatesRepository";

export {
  loadCatalog,
  seedCatalog,
  getCatalog,
  getCatalogItem,
  getSensitiveConfigKeys,
  hydrateRow,
  resolveCatalogSchema,
} from "./catalog/catalogLoader";

export { createSecretEncryption } from "./crypto/secretEncryption";
export type { SecretEncryption, SecretEncryptionDeps } from "./crypto/secretEncryption";

export { buildIntegrationToolCatalogEntries } from "./services/toolCatalogBuilder";
export type { BuildToolCatalogOptions } from "./services/toolCatalogBuilder";

export { createProviderRegistry } from "./providers/base/registry";
export type { ProviderRegistry, LegacyFactory } from "./providers/base/registry";
export { BaseProvider } from "./providers/base/provider";
export { createLegacyProviderAdapter } from "./providers/legacy";
export { githubProvider } from "./providers/github";
export { slackProvider } from "./providers/slack";
export { linearProvider } from "./providers/linear";
export { jiraProvider } from "./providers/jira";
export { twitterProvider } from "./providers/twitter";
export { linkedinProvider } from "./providers/linkedin";
export { gitlabProvider } from "./providers/gitlab";
export { bitbucketProvider } from "./providers/bitbucket";

// The orchestration service is the recommended import for callers that
// need the high-level operations (connect, list, test, sync, env-vars).
// Re-exporting via `* from` keeps named exports stable for new callers
// while leaving the CommonJS shim at backend-api/integrations.ts in
// place for legacy code paths.
const integrationsService = require("./services/integrationsService");
export const {
  connectIntegration,
  replaceIntegration,
  listIntegrations,
  removeIntegration,
  testIntegration,
  getIntegrationsForSync,
  getIntegrationEnvVars,
  buildIntegrationSyncEntry,
  buildIntegrationToolCatalogEntries: buildIntegrationToolCatalogEntriesFromService,
  buildCloneableIntegration,
  refreshTwitterOAuthRowIfNeeded,
  decryptSensitiveConfig,
  redactSensitiveConfig,
  stripSensitiveConfig,
  encryptSensitiveConfig,
  integrationProviderAffectsLlmAuth,
  providerRegistry,
} = integrationsService as Record<string, unknown>;
