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
  datadog: "DD_API_KEY",
  sentry: "SENTRY_AUTH_TOKEN",
  // sendgrid → migrated to providers/sendgrid.ts
  // openai → migrated to providers/openai.ts
  // anthropic → migrated to providers/anthropic.ts
  // airtable → migrated to providers/airtable.ts
  // asana → migrated to providers/asana.ts
  stripe: "STRIPE_SECRET_KEY",
  hubspot: "HUBSPOT_ACCESS_TOKEN",
  pipedrive: "PIPEDRIVE_API_KEY",
  // pinecone → migrated to providers/pinecone.ts
  // vercel → migrated to providers/vercel.ts
  // circleci → migrated to providers/circleci.ts
  // terraform → migrated to providers/terraform.ts
  pagerduty: "PAGERDUTY_TOKEN",
  // dropbox → migrated to providers/dropbox.ts
  // twilio → migrated to providers/twilio.ts
  // telegram → migrated to providers/telegram.ts
  shopify: "SHOPIFY_ACCESS_TOKEN",
  // linkedin → migrated to providers/linkedin.ts
  instagram: "INSTAGRAM_ACCESS_TOKEN",
  salesforce: "SALESFORCE_ACCESS_TOKEN",
  // twitter → migrated to providers/twitter.ts
  // digitalocean → migrated to providers/digitalocean.ts
  // algolia → migrated to providers/algolia.ts
  // clickup → migrated to providers/clickup.ts
  // monday → migrated to providers/monday.ts
  zendesk: "ZENDESK_API_TOKEN",
  // docker-hub → migrated to providers/dockerHub.ts
  // bitbucket → migrated to providers/bitbucket.ts
  // confluence → migrated to providers/confluence.ts
  // jira → migrated to providers/jira.ts
  // jenkins → migrated to providers/jenkins.ts
  grafana: "GRAFANA_TOKEN",
  woocommerce: "WOOCOMMERCE_SECRET_KEY",
  // trello → migrated to providers/trello.ts
  // elasticsearch → migrated to providers/elasticsearch.ts
  // supabase → migrated to providers/supabase.ts
  facebook: "FACEBOOK_ACCESS_TOKEN",
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
  paypal: "PAYPAL_CLIENT_SECRET",
  // Analytics / automation
  segment: "SEGMENT_WRITE_KEY",
  mixpanel: "MIXPANEL_API_SECRET",
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
  // Monitoring
  "datadog.app_key": "DD_APP_KEY",
  "datadog.site": "DD_SITE",
  "pagerduty.routing_key": "PAGERDUTY_ROUTING_KEY",
  "sentry.organization": "SENTRY_ORG",
  "sentry.project": "SENTRY_PROJECT",
  "grafana.url": "GRAFANA_URL",
  // DevOps
  "jenkins.url": "JENKINS_URL",
  "jenkins.username": "JENKINS_USERNAME",
  "vercel.team_id": "VERCEL_TEAM_ID",
  "terraform.organization": "TF_ORGANIZATION",
  "kubernetes.kubeconfig": "KUBECONFIG_CONTENT",
  "kubernetes.context": "KUBE_CONTEXT",
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
  // CRM
  "salesforce.instance_url": "SALESFORCE_INSTANCE_URL",
  "zendesk.subdomain": "ZENDESK_SUBDOMAIN",
  "zendesk.email": "ZENDESK_EMAIL",
  "pipedrive.company_domain": "PIPEDRIVE_DOMAIN",
  // Payment
  "paypal.client_id": "PAYPAL_CLIENT_ID",
  "stripe.webhook_secret": "STRIPE_WEBHOOK_SECRET",
  // Social
  // twitter.api_key/api_secret/default_username → providers/twitter.ts
  "facebook.page_id": "FACEBOOK_PAGE_ID",
  "instagram.business_account_id": "INSTAGRAM_BUSINESS_ACCOUNT_ID",
  "instagram.page_id": "INSTAGRAM_PAGE_ID",
  // Analytics
  "mixpanel.project_token": "MIXPANEL_PROJECT_TOKEN",
  "google-analytics.service_account_json": "GOOGLE_ANALYTICS_SA_JSON",
  "google-analytics.property_id": "GA4_PROPERTY_ID",
  // E-commerce
  "shopify.shop_domain": "SHOPIFY_SHOP_DOMAIN",
  "woocommerce.site_url": "WOOCOMMERCE_STORE_URL",
  "woocommerce.consumer_key": "WOOCOMMERCE_CONSUMER_KEY",
  // Automation webhooks
  "zapier.webhook_url": "ZAPIER_WEBHOOK_URL",
  "make.webhook_url": "MAKE_WEBHOOK_URL",
  "n8n.webhook_url": "N8N_WEBHOOK_URL",
  "n8n.api_key": "N8N_API_KEY",
  // DevOps
  "docker-hub.username": "DOCKER_HUB_USERNAME",
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
