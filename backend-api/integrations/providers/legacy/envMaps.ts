// @ts-nocheck
// Provider → env-var mappings used by the legacy provider adapter.
// Migrated providers' own `mapToEnv()` is canonical; entries here remain
// for any provider not yet on the strategy. PR 6 trims rows for migrated
// providers.

const llmProviders = require("../../../llmProviders");

// Maps provider ID → the env var for the primary credential (the
// access_token column). The access_token column stores the first
// password+required configField per provider.
const INTEGRATION_ENV_MAP = {
  // huggingface → migrated to providers/huggingface.ts
  // github → migrated to providers/github.ts
  // gitlab → migrated to providers/gitlab.ts
  // slack → migrated to providers/slack.ts
  // discord → migrated to providers/discord.ts
  // notion → migrated to providers/notion.ts
  // linear → migrated to providers/linear.ts
  // datadog → migrated to providers/datadog.ts
  // sentry → migrated to providers/sentry.ts
  // sendgrid → migrated to providers/sendgrid.ts
  // openai → migrated to providers/openai.ts
  // anthropic → migrated to providers/anthropic.ts
  // airtable → migrated to providers/airtable.ts
  // asana → migrated to providers/asana.ts
  // stripe → migrated to providers/stripe.ts
  // hubspot → migrated to providers/hubspot.ts
  // pipedrive → migrated to providers/pipedrive.ts
  // pinecone → migrated to providers/pinecone.ts
  // vercel → migrated to providers/vercel.ts
  // circleci → migrated to providers/circleci.ts
  // terraform → migrated to providers/terraform.ts
  // pagerduty → migrated to providers/pagerduty.ts
  // dropbox → migrated to providers/dropbox.ts
  // twilio → migrated to providers/twilio.ts
  // telegram → migrated to providers/telegram.ts
  // shopify → migrated to providers/shopify.ts
  // linkedin → migrated to providers/linkedin.ts
  // instagram → migrated to providers/instagram.ts
  // salesforce → migrated to providers/salesforce.ts
  // twitter → migrated to providers/twitter.ts
  // digitalocean → migrated to providers/digitalocean.ts
  // algolia → migrated to providers/algolia.ts
  // clickup → migrated to providers/clickup.ts
  // monday → migrated to providers/monday.ts
  // zendesk → migrated to providers/zendesk.ts
  // docker-hub → migrated to providers/dockerHub.ts
  // bitbucket → migrated to providers/bitbucket.ts
  // confluence → migrated to providers/confluence.ts
  // jira → migrated to providers/jira.ts
  // jenkins → migrated to providers/jenkins.ts
  // grafana → migrated to providers/grafana.ts
  // woocommerce → migrated to providers/woocommerce.ts
  // trello → migrated to providers/trello.ts
  // elasticsearch → migrated to providers/elasticsearch.ts
  // supabase → migrated to providers/supabase.ts
  // facebook → migrated to providers/facebook.ts
  // Cloud / infra
  // aws → migrated to providers/aws.ts
  // azure → migrated to providers/azure.ts
  // gcp → migrated to providers/gcp.ts (no primary token; uses service_account JSON)
  // s3 → migrated to providers/s3.ts
  // Databases
  // mongodb → migrated to providers/mongodb.ts
  // redis → migrated to providers/redis.ts
  // postgresql → migrated to providers/postgresql.ts
  // Payments
  // paypal → migrated to providers/paypal.ts
  // Analytics / automation
  // segment → migrated to providers/segment.ts
  // mixpanel → migrated to providers/mixpanel.ts
  // Vector DBs
  // weaviate → migrated to providers/weaviate.ts
  // Communication
  // email → migrated to providers/email.ts
  // Automation webhooks have no token; webhook_url is in INTEGRATION_CONFIG_ENV_MAP.
};

// Maps "provider.configFieldKey" → env var name for non-secret config
// fields (and optional secondary secrets) that the agent needs alongside
// the primary token.
const INTEGRATION_CONFIG_ENV_MAP = {
  // Developer tools
  // github.org → providers/github.ts
  // gitlab.base_url → providers/gitlab.ts
  // bitbucket.username/workspace → providers/bitbucket.ts
  // jira.email/site_url/project_key → providers/jira.ts
  // linear.team_id → providers/linear.ts
  // Communication
  // slack.default_channel → providers/slack.ts
  // discord.guild_id → providers/discord.ts
  // teams.webhook_url → providers/teams.ts
  // email.* → providers/email.ts
  // twilio.account_sid/phone_number → providers/twilio.ts
  "sendgrid.from_email": "SENDGRID_FROM_EMAIL",
  // telegram.operator_user_id → providers/telegram.ts
  // AI / ML
  "openai.org_id": "OPENAI_ORG_ID",
  "huggingface.model_id": "HF_DEFAULT_MODEL",
  // Cloud — all migrated:
  //   aws → providers/aws.ts
  //   gcp → providers/gcp.ts
  //   azure → providers/azure.ts
  // Storage / Databases / Search — all migrated to per-provider strategies:
  //   s3 → providers/s3.ts
  //   google-drive → providers/googleDrive.ts
  //   postgresql → providers/postgresql.ts
  //   mongodb → providers/mongodb.ts
  //   redis → providers/redis.ts
  //   supabase → providers/supabase.ts
  //   firebase → providers/firebase.ts
  //   elasticsearch → providers/elasticsearch.ts
  //   weaviate → providers/weaviate.ts
  //   pinecone → providers/pinecone.ts
  //   algolia → providers/algolia.ts
  // Monitoring — all migrated:
  //   datadog → providers/datadog.ts
  //   pagerduty → providers/pagerduty.ts
  //   sentry → providers/sentry.ts
  //   grafana → providers/grafana.ts
  // DevOps — all migrated:
  //   jenkins → providers/jenkins.ts
  //   vercel → providers/vercel.ts
  //   terraform → providers/terraform.ts
  //   kubernetes → providers/kubernetes.ts
  // Productivity
  // Productivity — all migrated to per-provider strategies:
  //   notion → providers/notion.ts
  //   airtable → providers/airtable.ts
  //   trello → providers/trello.ts
  //   clickup → providers/clickup.ts
  //   asana → providers/asana.ts
  //   monday → providers/monday.ts
  //   confluence → providers/confluence.ts
  //   google-sheets → providers/googleSheets.ts
  //   google-calendar → providers/googleCalendar.ts
  // CRM / Payment — all migrated:
  //   salesforce → providers/salesforce.ts
  //   zendesk → providers/zendesk.ts
  //   pipedrive → providers/pipedrive.ts
  //   stripe → providers/stripe.ts
  //   paypal → providers/paypal.ts
  // Social — all migrated:
  //   twitter → providers/twitter.ts
  //   facebook → providers/facebook.ts
  //   instagram → providers/instagram.ts
  // Analytics — all migrated:
  //   mixpanel → providers/mixpanel.ts
  //   google-analytics → providers/googleAnalytics.ts
  // E-commerce / Automation — all migrated:
  //   shopify → providers/shopify.ts
  //   woocommerce → providers/woocommerce.ts
  //   zapier → providers/zapier.ts
  //   make → providers/make.ts
  //   n8n → providers/n8n.ts
  // DevOps — docker-hub migrated to providers/dockerHub.ts
};

const LLM_AUTH_ENV_VARS = new Set(
  (Array.isArray(llmProviders.PROVIDERS) ? llmProviders.PROVIDERS : [])
    .map((provider) => provider.envVar)
    .filter(Boolean),
);

// Strategy-provider IDs whose primary env var matters for LLM auth.
// Mirrors what the legacy INTEGRATION_ENV_MAP used to provide; kept here
// so this file can answer the question without importing the registry
// (which would be circular).
const LLM_AUTH_PROVIDER_IDS = new Set(["openai", "anthropic", "huggingface"]);

function integrationProviderAffectsLlmAuth(provider) {
  const providerId = String(provider || "").trim();
  if (!providerId) return false;

  if (LLM_AUTH_PROVIDER_IDS.has(providerId)) return true;

  const primaryEnv = INTEGRATION_ENV_MAP[providerId];
  if (primaryEnv && LLM_AUTH_ENV_VARS.has(primaryEnv)) return true;

  return Object.entries(INTEGRATION_CONFIG_ENV_MAP).some(
    ([configKey, envVar]) =>
      configKey.startsWith(`${providerId}.`) && envVar && LLM_AUTH_ENV_VARS.has(envVar),
  );
}

module.exports = {
  INTEGRATION_ENV_MAP,
  INTEGRATION_CONFIG_ENV_MAP,
  LLM_AUTH_ENV_VARS,
  integrationProviderAffectsLlmAuth,
};
