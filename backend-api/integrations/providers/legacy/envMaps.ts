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
  huggingface: "HF_TOKEN",
  // github → migrated to providers/github.ts
  // gitlab → migrated to providers/gitlab.ts
  // slack → migrated to providers/slack.ts
  // discord → migrated to providers/discord.ts
  notion: "NOTION_TOKEN",
  // linear → migrated to providers/linear.ts
  datadog: "DD_API_KEY",
  sentry: "SENTRY_AUTH_TOKEN",
  // sendgrid → migrated to providers/sendgrid.ts
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  airtable: "AIRTABLE_API_KEY",
  asana: "ASANA_TOKEN",
  stripe: "STRIPE_SECRET_KEY",
  hubspot: "HUBSPOT_ACCESS_TOKEN",
  pipedrive: "PIPEDRIVE_API_KEY",
  pinecone: "PINECONE_API_KEY",
  // vercel → migrated to providers/vercel.ts
  // circleci → migrated to providers/circleci.ts
  // terraform → migrated to providers/terraform.ts
  pagerduty: "PAGERDUTY_TOKEN",
  dropbox: "DROPBOX_ACCESS_TOKEN",
  // twilio → migrated to providers/twilio.ts
  // telegram → migrated to providers/telegram.ts
  shopify: "SHOPIFY_ACCESS_TOKEN",
  // linkedin → migrated to providers/linkedin.ts
  instagram: "INSTAGRAM_ACCESS_TOKEN",
  salesforce: "SALESFORCE_ACCESS_TOKEN",
  // twitter → migrated to providers/twitter.ts
  digitalocean: "DIGITALOCEAN_TOKEN",
  algolia: "ALGOLIA_API_KEY",
  clickup: "CLICKUP_API_KEY",
  monday: "MONDAY_API_KEY",
  zendesk: "ZENDESK_API_TOKEN",
  // docker-hub → migrated to providers/dockerHub.ts
  // bitbucket → migrated to providers/bitbucket.ts
  confluence: "CONFLUENCE_TOKEN",
  // jira → migrated to providers/jira.ts
  // jenkins → migrated to providers/jenkins.ts
  grafana: "GRAFANA_TOKEN",
  woocommerce: "WOOCOMMERCE_SECRET_KEY",
  trello: "TRELLO_TOKEN",
  elasticsearch: "ELASTICSEARCH_PASSWORD",
  supabase: "SUPABASE_SERVICE_ROLE_KEY",
  facebook: "FACEBOOK_ACCESS_TOKEN",
  // Cloud / infra
  aws: "AWS_SECRET_ACCESS_KEY",
  azure: "AZURE_CLIENT_SECRET",
  s3: "S3_SECRET_ACCESS_KEY",
  // Databases
  mongodb: "MONGODB_URI",
  redis: "REDIS_PASSWORD",
  postgresql: "PGPASSWORD",
  // Payments
  paypal: "PAYPAL_CLIENT_SECRET",
  // Analytics / automation
  segment: "SEGMENT_WRITE_KEY",
  mixpanel: "MIXPANEL_API_SECRET",
  // Vector DBs
  weaviate: "WEAVIATE_API_KEY",
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
  // Cloud
  "aws.access_key_id": "AWS_ACCESS_KEY_ID",
  "aws.region": "AWS_DEFAULT_REGION",
  "gcp.service_account_json": "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  "gcp.project_id": "GCP_PROJECT_ID",
  "azure.tenant_id": "AZURE_TENANT_ID",
  "azure.client_id": "AZURE_CLIENT_ID",
  // Storage
  "s3.access_key_id": "S3_ACCESS_KEY_ID",
  "s3.region": "S3_REGION",
  "s3.bucket": "S3_BUCKET",
  "google-drive.service_account_json": "GOOGLE_DRIVE_SA_JSON",
  "google-drive.folder_id": "GOOGLE_DRIVE_FOLDER_ID",
  // Databases
  "postgresql.host": "PGHOST",
  "postgresql.port": "PGPORT",
  "postgresql.database": "PGDATABASE",
  "postgresql.user": "PGUSER",
  "mongodb.database": "MONGODB_DATABASE",
  "redis.host": "REDIS_HOST",
  "redis.port": "REDIS_PORT",
  "redis.password": "REDIS_PASSWORD",
  "supabase.url": "SUPABASE_URL",
  "firebase.service_account_json": "FIREBASE_SA_JSON",
  "firebase.database_url": "FIREBASE_DATABASE_URL",
  "elasticsearch.node_url": "ELASTICSEARCH_URL",
  "elasticsearch.username": "ELASTICSEARCH_USERNAME",
  "elasticsearch.password": "ELASTICSEARCH_PASSWORD",
  "elasticsearch.index": "ELASTICSEARCH_INDEX",
  "weaviate.host": "WEAVIATE_HOST",
  "weaviate.api_key": "WEAVIATE_API_KEY",
  // Search
  "pinecone.environment": "PINECONE_ENVIRONMENT",
  "pinecone.index_name": "PINECONE_INDEX",
  "algolia.app_id": "ALGOLIA_APP_ID",
  "algolia.index_name": "ALGOLIA_INDEX",
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
  "notion.workspace_id": "NOTION_WORKSPACE_ID",
  "airtable.base_id": "AIRTABLE_BASE_ID",
  "trello.api_key": "TRELLO_API_KEY",
  "trello.board_id": "TRELLO_BOARD_ID",
  "clickup.workspace_id": "CLICKUP_WORKSPACE_ID",
  "confluence.base_url": "CONFLUENCE_BASE_URL",
  "confluence.email": "CONFLUENCE_EMAIL",
  "google-sheets.service_account_json": "GOOGLE_SHEETS_SA_JSON",
  "google-sheets.spreadsheet_id": "GOOGLE_SHEETS_SPREADSHEET_ID",
  "google-calendar.service_account_json": "GOOGLE_CALENDAR_SA_JSON",
  "google-calendar.calendar_id": "GOOGLE_CALENDAR_ID",
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

function integrationProviderAffectsLlmAuth(provider) {
  const providerId = String(provider || "").trim();
  if (!providerId) return false;

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
