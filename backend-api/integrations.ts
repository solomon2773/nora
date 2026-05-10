// Legacy CommonJS re-export shim for backwards compatibility with
// existing `require("./integrations")` callers (server.ts,
// gatewayProxy.ts, agentMigrations.ts, agentPayloads.ts, authSync.ts,
// routes/integrations.ts, and tests). New code should import from
// `./integrations` (the directory + index.ts) instead.
//
// Real implementations live under
// backend-api/integrations/{repository,catalog,crypto,providers,services}.

const service = require("./integrations/services/integrationsService");

type IntegrationsModule = {
  buildCloneableIntegration: (...args: unknown[]) => unknown;
  buildIntegrationSyncEntry: (...args: unknown[]) => unknown;
  buildIntegrationToolCatalogEntries: (...args: unknown[]) => unknown;
  seedCatalog: (...args: unknown[]) => Promise<unknown>;
  getCatalog: (...args: unknown[]) => Promise<unknown>;
  getCatalogItem: (...args: unknown[]) => Promise<unknown>;
  connectIntegration: (...args: unknown[]) => Promise<unknown>;
  replaceIntegration: (...args: unknown[]) => Promise<unknown>;
  decryptSensitiveConfig: (...args: unknown[]) => unknown;
  listIntegrations: (...args: unknown[]) => Promise<unknown>;
  removeIntegration: (...args: unknown[]) => Promise<unknown>;
  testIntegration: (...args: unknown[]) => Promise<unknown>;
  getIntegrationsForSync: (...args: unknown[]) => Promise<unknown>;
  getIntegrationEnvVars: (...args: unknown[]) => Promise<unknown>;
  integrationProviderAffectsLlmAuth: (provider: string) => boolean;
  stripSensitiveConfig: (...args: unknown[]) => unknown;
};

const exported: IntegrationsModule = {
  buildCloneableIntegration: service.buildCloneableIntegration,
  buildIntegrationSyncEntry: service.buildIntegrationSyncEntry,
  buildIntegrationToolCatalogEntries: service.buildIntegrationToolCatalogEntries,
  seedCatalog: service.seedCatalog,
  getCatalog: service.getCatalog,
  getCatalogItem: service.getCatalogItem,
  connectIntegration: service.connectIntegration,
  replaceIntegration: service.replaceIntegration,
  decryptSensitiveConfig: service.decryptSensitiveConfig,
  listIntegrations: service.listIntegrations,
  removeIntegration: service.removeIntegration,
  testIntegration: service.testIntegration,
  getIntegrationsForSync: service.getIntegrationsForSync,
  getIntegrationEnvVars: service.getIntegrationEnvVars,
  integrationProviderAffectsLlmAuth: service.integrationProviderAffectsLlmAuth,
  stripSensitiveConfig: service.stripSensitiveConfig,
};

module.exports = exported;
