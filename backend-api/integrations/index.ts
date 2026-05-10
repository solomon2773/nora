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
export { circleciProvider } from "./providers/circleci";
export { vercelProvider } from "./providers/vercel";
export { terraformProvider } from "./providers/terraform";
export { jenkinsProvider } from "./providers/jenkins";
export { dockerHubProvider } from "./providers/dockerHub";
export { kubernetesProvider } from "./providers/kubernetes";
export { discordProvider } from "./providers/discord";
export { telegramProvider } from "./providers/telegram";
export { teamsProvider } from "./providers/teams";
export { emailProvider } from "./providers/email";
export { twilioProvider } from "./providers/twilio";
export { sendgridProvider } from "./providers/sendgrid";
export { postgresqlProvider } from "./providers/postgresql";
export { mongodbProvider } from "./providers/mongodb";
export { redisProvider } from "./providers/redis";
export { supabaseProvider } from "./providers/supabase";
export { firebaseProvider } from "./providers/firebase";
export { googleDriveProvider } from "./providers/googleDrive";
export { dropboxProvider } from "./providers/dropbox";
export { s3Provider } from "./providers/s3";
export { elasticsearchProvider } from "./providers/elasticsearch";
export { pineconeProvider } from "./providers/pinecone";
export { weaviateProvider } from "./providers/weaviate";
export { algoliaProvider } from "./providers/algolia";
export { openaiProvider } from "./providers/openai";
export { anthropicProvider } from "./providers/anthropic";
export { huggingfaceProvider } from "./providers/huggingface";
export { digitaloceanProvider } from "./providers/digitalocean";
export { awsProvider } from "./providers/aws";
export { gcpProvider } from "./providers/gcp";
export { azureProvider } from "./providers/azure";
export { notionProvider } from "./providers/notion";
export { airtableProvider } from "./providers/airtable";
export { asanaProvider } from "./providers/asana";
export { mondayProvider } from "./providers/monday";
export { clickupProvider } from "./providers/clickup";
export { trelloProvider } from "./providers/trello";
export { confluenceProvider } from "./providers/confluence";
export { googleSheetsProvider } from "./providers/googleSheets";
export { googleCalendarProvider } from "./providers/googleCalendar";
export { salesforceProvider } from "./providers/salesforce";
export { hubspotProvider } from "./providers/hubspot";
export { pipedriveProvider } from "./providers/pipedrive";
export { zendeskProvider } from "./providers/zendesk";
export { stripeProvider } from "./providers/stripe";
export { paypalProvider } from "./providers/paypal";
export { googleAnalyticsProvider } from "./providers/googleAnalytics";
export { mixpanelProvider } from "./providers/mixpanel";
export { segmentProvider } from "./providers/segment";

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
