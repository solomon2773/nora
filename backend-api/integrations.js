// integration registry backed by PostgreSQL + catalog

const db = require("./db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("./crypto");
const path = require("path");
const fs = require("fs");
const {
  buildIntegrationToolExecutionMetadata,
} = require("../agent-runtime/lib/integrationTools");

// ── Integration → Env Var Name Map ───────────────────────
// Maps provider ID → the env var for the primary credential (the access_token column).
// The access_token column stores the first password+required configField per provider.
const INTEGRATION_ENV_MAP = {
  huggingface:          'HF_TOKEN',
  github:               'GITHUB_TOKEN',
  gitlab:               'GITLAB_TOKEN',
  slack:                'SLACK_TOKEN',
  discord:              'DISCORD_TOKEN',
  notion:               'NOTION_TOKEN',
  linear:               'LINEAR_API_KEY',
  datadog:              'DD_API_KEY',
  sentry:               'SENTRY_AUTH_TOKEN',
  sendgrid:             'SENDGRID_API_KEY',
  openai:               'OPENAI_API_KEY',
  anthropic:            'ANTHROPIC_API_KEY',
  airtable:             'AIRTABLE_API_KEY',
  asana:                'ASANA_TOKEN',
  stripe:               'STRIPE_SECRET_KEY',
  hubspot:              'HUBSPOT_ACCESS_TOKEN',
  pipedrive:            'PIPEDRIVE_API_KEY',
  pinecone:             'PINECONE_API_KEY',
  vercel:               'VERCEL_TOKEN',
  circleci:             'CIRCLE_TOKEN',
  terraform:            'TFE_TOKEN',
  pagerduty:            'PAGERDUTY_TOKEN',
  dropbox:              'DROPBOX_ACCESS_TOKEN',
  twilio:               'TWILIO_AUTH_TOKEN',
  shopify:              'SHOPIFY_ACCESS_TOKEN',
  linkedin:             'LINKEDIN_ACCESS_TOKEN',
  salesforce:           'SALESFORCE_ACCESS_TOKEN',
  twitter:              'TWITTER_BEARER_TOKEN',
  digitalocean:         'DIGITALOCEAN_TOKEN',
  algolia:              'ALGOLIA_API_KEY',
  clickup:              'CLICKUP_API_KEY',
  monday:               'MONDAY_API_KEY',
  zendesk:              'ZENDESK_API_TOKEN',
  'docker-hub':         'DOCKER_HUB_TOKEN',
  bitbucket:            'BITBUCKET_TOKEN',
  confluence:           'CONFLUENCE_TOKEN',
  jira:                 'JIRA_API_TOKEN',
  jenkins:              'JENKINS_TOKEN',
  grafana:              'GRAFANA_TOKEN',
  woocommerce:          'WOOCOMMERCE_SECRET_KEY',
  trello:               'TRELLO_TOKEN',
  elasticsearch:        'ELASTICSEARCH_PASSWORD',
  supabase:             'SUPABASE_SERVICE_ROLE_KEY',
  facebook:             'FACEBOOK_ACCESS_TOKEN',
  // Cloud / infra
  aws:                  'AWS_SECRET_ACCESS_KEY',
  azure:                'AZURE_CLIENT_SECRET',
  s3:                   'S3_SECRET_ACCESS_KEY',
  // Databases
  mongodb:              'MONGODB_URI',
  redis:                'REDIS_PASSWORD',
  postgresql:           'PGPASSWORD',
  // Payments
  paypal:               'PAYPAL_CLIENT_SECRET',
  // Analytics / automation
  segment:              'SEGMENT_WRITE_KEY',
  mixpanel:             'MIXPANEL_API_SECRET',
  // Vector DBs
  weaviate:             'WEAVIATE_API_KEY',
  // Communication
  email:                'SMTP_PASS',
  // Automation webhooks — these have no token; webhook_url is in config
  // (handled via INTEGRATION_CONFIG_ENV_MAP below)
};

// ── Integration Config Field → Env Var Map ────────────────
// Maps "provider.configFieldKey" → env var name for non-secret config fields
// (and optional secondary secrets) that the agent needs alongside the primary token.
const INTEGRATION_CONFIG_ENV_MAP = {
  // Developer tools
  'github.org':                       'GITHUB_ORG',
  'gitlab.base_url':                  'GITLAB_BASE_URL',
  'bitbucket.username':               'BITBUCKET_USERNAME',
  'bitbucket.workspace':              'BITBUCKET_WORKSPACE',
  'jira.email':                       'JIRA_EMAIL',
  'jira.site_url':                    'JIRA_BASE_URL',
  'jira.project_key':                 'JIRA_PROJECT_KEY',
  'linear.team_id':                   'LINEAR_TEAM_ID',
  // Communication
  'slack.default_channel':            'SLACK_DEFAULT_CHANNEL',
  'discord.guild_id':                 'DISCORD_GUILD_ID',
  'teams.webhook_url':                'TEAMS_WEBHOOK_URL',
  'email.smtp_host':                  'SMTP_HOST',
  'email.smtp_port':                  'SMTP_PORT',
  'email.smtp_user':                  'SMTP_USER',
  'email.from_address':               'SMTP_FROM_ADDRESS',
  'twilio.account_sid':               'TWILIO_ACCOUNT_SID',
  'twilio.phone_number':              'TWILIO_PHONE_NUMBER',
  'sendgrid.from_email':              'SENDGRID_FROM_EMAIL',
  // AI / ML
  'openai.org_id':                    'OPENAI_ORG_ID',
  'huggingface.model_id':             'HF_DEFAULT_MODEL',
  // Cloud
  'aws.access_key_id':                'AWS_ACCESS_KEY_ID',
  'aws.region':                       'AWS_DEFAULT_REGION',
  'gcp.service_account_json':         'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'gcp.project_id':                   'GCP_PROJECT_ID',
  'azure.tenant_id':                  'AZURE_TENANT_ID',
  'azure.client_id':                  'AZURE_CLIENT_ID',
  // Storage
  's3.access_key_id':                 'S3_ACCESS_KEY_ID',
  's3.region':                        'S3_REGION',
  's3.bucket':                        'S3_BUCKET',
  'google-drive.service_account_json':'GOOGLE_DRIVE_SA_JSON',
  'google-drive.folder_id':           'GOOGLE_DRIVE_FOLDER_ID',
  // Databases
  'postgresql.host':                  'PGHOST',
  'postgresql.port':                  'PGPORT',
  'postgresql.database':              'PGDATABASE',
  'postgresql.user':                  'PGUSER',
  'mongodb.database':                 'MONGODB_DATABASE',
  'redis.host':                       'REDIS_HOST',
  'redis.port':                       'REDIS_PORT',
  'redis.password':                   'REDIS_PASSWORD',
  'supabase.url':                     'SUPABASE_URL',
  'firebase.service_account_json':    'FIREBASE_SA_JSON',
  'firebase.database_url':            'FIREBASE_DATABASE_URL',
  'elasticsearch.node_url':           'ELASTICSEARCH_URL',
  'elasticsearch.username':           'ELASTICSEARCH_USERNAME',
  'elasticsearch.password':           'ELASTICSEARCH_PASSWORD',
  'elasticsearch.index':              'ELASTICSEARCH_INDEX',
  'weaviate.host':                    'WEAVIATE_HOST',
  'weaviate.api_key':                 'WEAVIATE_API_KEY',
  // Search
  'pinecone.environment':             'PINECONE_ENVIRONMENT',
  'pinecone.index_name':              'PINECONE_INDEX',
  'algolia.app_id':                   'ALGOLIA_APP_ID',
  'algolia.index_name':               'ALGOLIA_INDEX',
  // Monitoring
  'datadog.app_key':                  'DD_APP_KEY',
  'datadog.site':                     'DD_SITE',
  'pagerduty.routing_key':            'PAGERDUTY_ROUTING_KEY',
  'sentry.organization':              'SENTRY_ORG',
  'sentry.project':                   'SENTRY_PROJECT',
  'grafana.url':                      'GRAFANA_URL',
  // DevOps
  'jenkins.url':                      'JENKINS_URL',
  'jenkins.username':                 'JENKINS_USERNAME',
  'vercel.team_id':                   'VERCEL_TEAM_ID',
  'terraform.organization':           'TF_ORGANIZATION',
  'kubernetes.kubeconfig':            'KUBECONFIG_CONTENT',
  'kubernetes.context':               'KUBE_CONTEXT',
  // Productivity
  'notion.workspace_id':              'NOTION_WORKSPACE_ID',
  'airtable.base_id':                 'AIRTABLE_BASE_ID',
  'trello.api_key':                   'TRELLO_API_KEY',
  'trello.board_id':                  'TRELLO_BOARD_ID',
  'clickup.workspace_id':             'CLICKUP_WORKSPACE_ID',
  'confluence.base_url':              'CONFLUENCE_BASE_URL',
  'confluence.email':                 'CONFLUENCE_EMAIL',
  'google-sheets.service_account_json': 'GOOGLE_SHEETS_SA_JSON',
  'google-sheets.spreadsheet_id':     'GOOGLE_SHEETS_SPREADSHEET_ID',
  'google-calendar.service_account_json': 'GOOGLE_CALENDAR_SA_JSON',
  'google-calendar.calendar_id':      'GOOGLE_CALENDAR_ID',
  // CRM
  'salesforce.instance_url':          'SALESFORCE_INSTANCE_URL',
  'zendesk.subdomain':                'ZENDESK_SUBDOMAIN',
  'zendesk.email':                    'ZENDESK_EMAIL',
  'pipedrive.company_domain':         'PIPEDRIVE_DOMAIN',
  // Payment
  'paypal.client_id':                 'PAYPAL_CLIENT_ID',
  'stripe.webhook_secret':            'STRIPE_WEBHOOK_SECRET',
  // Social
  'twitter.api_key':                  'TWITTER_API_KEY',
  'twitter.api_secret':               'TWITTER_API_SECRET',
  'facebook.page_id':                 'FACEBOOK_PAGE_ID',
  // Analytics
  'mixpanel.project_token':           'MIXPANEL_PROJECT_TOKEN',
  'google-analytics.service_account_json': 'GOOGLE_ANALYTICS_SA_JSON',
  'google-analytics.property_id':     'GA4_PROPERTY_ID',
  // E-commerce
  'shopify.shop_domain':              'SHOPIFY_SHOP_DOMAIN',
  'woocommerce.site_url':             'WOOCOMMERCE_STORE_URL',
  'woocommerce.consumer_key':         'WOOCOMMERCE_CONSUMER_KEY',
  // Automation webhooks
  'zapier.webhook_url':               'ZAPIER_WEBHOOK_URL',
  'make.webhook_url':                 'MAKE_WEBHOOK_URL',
  'n8n.webhook_url':                  'N8N_WEBHOOK_URL',
  'n8n.api_key':                      'N8N_API_KEY',
  // DevOps
  'docker-hub.username':              'DOCKER_HUB_USERNAME',
};

// ── SSRF Protection ──────────────────────────────────────
// Block user-supplied URLs from targeting internal/private network addresses.
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i;

function assertSafeUrl(rawUrl, label = "URL") {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http or https`);
  }
  const host = parsed.hostname;
  if (PRIVATE_IP_RE.test(host)) {
    throw new Error(`${label} must not target internal or private network addresses`);
  }
  return parsed.origin; // return validated origin only (strips path/query)
}

// ── Catalog ──────────────────────────────────────────────

let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  const catalogPath = path.join(__dirname, "integrations", "catalog", "catalog.json");
  try {
    catalogCache = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch {
    catalogCache = [];
    console.warn("Could not load integration catalog from disk");
  }
  return catalogCache;
}

/**
 * Seed the integration_catalog table from the JSON spec files.
 * Called once on server startup.
 */
async function seedCatalog() {
  catalogCache = null; // force re-read from disk
  const catalog = loadCatalog();
  for (const item of catalog) {
    try {
      await db.query(
        `INSERT INTO integration_catalog(id, name, icon, category, description, auth_type, config_schema, enabled)
         VALUES($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           icon = EXCLUDED.icon,
           category = EXCLUDED.category,
           description = EXCLUDED.description,
           auth_type = EXCLUDED.auth_type,
           config_schema = EXCLUDED.config_schema`,
        [item.id, item.name, item.icon, item.category, item.description, item.authType, JSON.stringify(item)]
      );
    } catch (e) {
      // Table may not exist yet during first boot — silently skip
      if (!e.message.includes("does not exist")) {
        console.error(`Failed to seed catalog item ${item.id}:`, e.message);
      }
    }
  }
  console.log(`Integration catalog seeded: ${catalog.length} items`);
}

function resolveCatalogSchema(row = {}) {
  const rawSchema =
    row.config_schema ??
    loadCatalog().find(
      (item) => item.id === row.catalog_id || item.id === row.provider || item.id === row.id
    );

  if (!rawSchema) return {};

  if (typeof rawSchema === "string") {
    try {
      return JSON.parse(rawSchema);
    } catch {
      return {};
    }
  }

  return rawSchema && typeof rawSchema === "object" ? rawSchema : {};
}

function hydrateRow(row) {
  const schema = resolveCatalogSchema(row);
  return {
    ...row,
    configFields: schema.configFields || [],
    capabilities: schema.capabilities || [],
    authType: schema.authType || row.auth_type,
    toolSpecs: schema.toolSpecs || [],
    mcp: schema.mcp || null,
    api: schema.api || null,
    usageHints: schema.usageHints || [],
  };
}

async function getCatalog(category) {
  let query = "SELECT * FROM integration_catalog WHERE enabled = true";
  const params = [];
  if (category) {
    query += " AND category = $1";
    params.push(category);
  }
  query += " ORDER BY category, name";
  try {
    const result = await db.query(query, params);
    return result.rows.map(hydrateRow);
  } catch {
    // Fallback to in-memory catalog if table doesn't exist yet
    const catalog = loadCatalog();
    if (category) return catalog.filter((c) => c.category === category);
    return catalog;
  }
}

async function getCatalogItem(catalogId) {
  try {
    const result = await db.query("SELECT * FROM integration_catalog WHERE id = $1", [catalogId]);
    return result.rows[0] ? hydrateRow(result.rows[0]) : null;
  } catch {
    return loadCatalog().find((c) => c.id === catalogId) || null;
  }
}

const SECRET_CONFIG_KEY_RE = /(token|secret|password|api[_-]?key|private[_-]?key|service[_-]?account|credentials?)/i;
const REDACTED_SECRET = "[REDACTED]";

function getSensitiveConfigKeys(provider) {
  const catalogItem = loadCatalog().find((item) => item.id === provider);
  const schemaKeys = new Set(
    (catalogItem?.configFields || [])
      .filter((field) => field?.type === "password" || SECRET_CONFIG_KEY_RE.test(field?.key || ""))
      .map((field) => field.key)
  );
  if (provider === "gcp" || provider === "google-drive" || provider === "google-sheets" || provider === "google-calendar" || provider === "firebase" || provider === "google-analytics") {
    for (const key of ["service_account_json", "credentials_json"]) schemaKeys.add(key);
  }
  return schemaKeys;
}

function parseConfig(config) {
  return typeof config === "string" ? JSON.parse(config) : (config || {});
}

function encryptSensitiveConfig(provider, config = {}) {
  const plain = parseConfig(config);
  const sensitiveKeys = getSensitiveConfigKeys(provider);
  const secured = { ...plain };
  let hasSensitiveMaterial = false;

  for (const key of Object.keys(secured)) {
    const value = secured[key];
    if (!value) continue;
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      hasSensitiveMaterial = true;
      secured[key] = encrypt(String(value));
    }
  }

  return { secured, hasSensitiveMaterial };
}

function decryptSensitiveConfig(provider, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveConfigKeys(provider);
  const revealed = { ...parsed };

  for (const key of Object.keys(revealed)) {
    const value = revealed[key];
    if (!value) continue;
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      revealed[key] = decrypt(String(value));
    }
  }

  return revealed;
}

function redactSensitiveConfig(provider, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveConfigKeys(provider);
  const redacted = { ...parsed };

  for (const key of Object.keys(redacted)) {
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      if (redacted[key]) redacted[key] = REDACTED_SECRET;
    }
  }

  return redacted;
}

function stripSensitiveConfig(provider, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveConfigKeys(provider);
  const stripped = { ...parsed };
  let removedSensitive = false;

  for (const key of Object.keys(stripped)) {
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      if (stripped[key]) removedSensitive = true;
      stripped[key] = null;
    }
  }

  return { config: stripped, removedSensitive };
}

function buildCloneableIntegration(row = {}) {
  const { config, removedSensitive } = stripSensitiveConfig(
    row.provider,
    row.config
  );
  const hasPrimarySecret = Boolean(row.access_token);

  return {
    provider: row.provider,
    catalog_id: row.catalog_id || row.provider,
    config,
    status:
      hasPrimarySecret || removedSensitive
        ? "needs_reconnect"
        : row.status || "active",
  };
}

function buildIntegrationSyncEntry(row = {}) {
  const hydrated = hydrateRow(row);
  const provider = row.provider || row.catalog_id || row.id;
  const config = decryptSensitiveConfig(provider, row.config);

  return {
    id: row.id,
    provider,
    name: row.catalog_name || hydrated.name || provider,
    category: row.catalog_category || hydrated.category || "unknown",
    authType: hydrated.authType || null,
    config,
    redactedConfig: redactSensitiveConfig(provider, config),
    status: row.status || "active",
    capabilities: Array.isArray(hydrated.capabilities) ? hydrated.capabilities : [],
    toolSpecs: Array.isArray(hydrated.toolSpecs) ? hydrated.toolSpecs : [],
    mcp: hydrated.mcp || null,
    api: hydrated.api || null,
    usageHints: Array.isArray(hydrated.usageHints) ? hydrated.usageHints : [],
  };
}

function normalizeToolName(rawName, fallback) {
  const candidate = String(rawName || fallback || "tool")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return candidate || "tool";
}

function ensureUniqueToolName(baseName, reservedNames) {
  let nextName = baseName;
  let suffix = 2;
  while (reservedNames.has(nextName)) {
    nextName = `${baseName}_${suffix}`;
    suffix += 1;
  }
  reservedNames.add(nextName);
  return nextName;
}

function normalizeToolParameterSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return schema;
}

function buildIntegrationToolCatalogEntries(integrations = [], options = {}) {
  const reservedNames =
    options.reservedNames instanceof Set
      ? new Set(options.reservedNames)
      : new Set();
  const tools = [];

  for (const integration of Array.isArray(integrations) ? integrations : []) {
    const toolSpecs = Array.isArray(integration.toolSpecs)
      ? integration.toolSpecs
      : [];

    for (let index = 0; index < toolSpecs.length; index += 1) {
      const spec = toolSpecs[index] || {};
      const uniqueName = ensureUniqueToolName(
        normalizeToolName(spec.name, `${integration.provider}_${index + 1}`),
        reservedNames
      );
      const execution = buildIntegrationToolExecutionMetadata(integration, spec);

      tools.push({
        type: "function",
        function: {
          name: uniqueName,
          description:
            String(spec.description || "").trim() ||
            `Declared ${integration.name || integration.provider} integration capability.`,
          parameters: normalizeToolParameterSchema(
            spec.inputSchema || spec.parameters
          ),
        },
        nora: {
          source: "integration-manifest",
          executable: execution.executable,
          executionState: execution.executionState,
          executionSurface: execution.executionSurface,
          executor: execution.executor,
          provider: integration.provider,
          providerName: integration.name || integration.provider,
          integrationId: integration.id,
          operation: spec.operation || null,
          runtimeToolName: execution.runtimeToolName,
          invokeCommand: execution.invokeCommand,
          exampleInput: execution.exampleInput,
          authType: integration.authType || null,
          capabilities: Array.isArray(integration.capabilities)
            ? integration.capabilities
            : [],
          api: integration.api || null,
          mcp: integration.mcp || null,
          usageHints: Array.isArray(integration.usageHints)
            ? integration.usageHints
            : [],
          config: integration.redactedConfig || {},
        },
      });
    }
  }

  return tools;
}

// ── Agent Integrations (CRUD) ────────────────────────────

async function connectIntegration(agentId, provider, token, config = {}) {
  // If no explicit token, try to extract from config (first password+required field)
  if (!token) {
    const catalogItem = await getCatalogItem(provider);
    if (catalogItem) {
      const fields = catalogItem.configFields || [];
      const tokenField = fields.find((f) => f.type === "password" && f.required);
      if (tokenField && config[tokenField.key]) {
        token = config[tokenField.key];
      }
    }
  }

  const { secured: securedConfig, hasSensitiveMaterial } = encryptSensitiveConfig(provider, config);
  if (token || hasSensitiveMaterial) {
    ensureEncryptionConfigured("Integration credential storage");
  }

  const encryptedToken = token ? encrypt(token) : null;
  const result = await db.query(
    "INSERT INTO integrations(agent_id, provider, catalog_id, access_token, config) VALUES($1, $2, $3, $4, $5) RETURNING *",
    [agentId, provider, provider, encryptedToken, JSON.stringify(securedConfig)]
  );
  const { access_token, ...safeRow } = result.rows[0] || {};
  return {
    ...safeRow,
    config: redactSensitiveConfig(provider, securedConfig),
  };
}

async function listIntegrations(agentId) {
  const result = await db.query(
    `SELECT i.id, i.agent_id, i.provider, i.catalog_id, i.config, i.status, i.created_at,
            ic.name as catalog_name, ic.icon as catalog_icon, ic.category as catalog_category, ic.description as catalog_description
     FROM integrations i
     LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
     WHERE i.agent_id = $1
     ORDER BY i.created_at DESC`,
    [agentId]
  );
  return result.rows.map((row) => ({
    ...row,
    config: redactSensitiveConfig(row.provider, row.config),
  }));
}

async function removeIntegration(integrationId, agentId) {
  const result = await db.query(
    "DELETE FROM integrations WHERE id = $1 AND agent_id = $2 RETURNING id",
    [integrationId, agentId]
  );
  if (!result.rows[0]) throw new Error("Integration not found");
}

async function testIntegration(integrationId, agentId) {
  const result = await db.query(
    "SELECT * FROM integrations WHERE id = $1 AND agent_id = $2",
    [integrationId, agentId]
  );
  const integration = result.rows[0];
  if (!integration) throw new Error("Integration not found");

  if (!integration.access_token) {
    return { success: false, error: "No access token configured" };
  }

  const token = decrypt(integration.access_token);
  const provider = integration.provider;
  integration.config = decryptSensitiveConfig(provider, integration.config);

  // Real API connectivity tests per provider
  const connectivityTests = {
    github: async () => {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "Nora-Platform" },
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.login}` };
    },
    gitlab: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const baseUrl = assertSafeUrl(config.base_url || "https://gitlab.com", "GitLab base URL");
      const res = await fetch(`${baseUrl}/api/v4/user`, {
        headers: { "PRIVATE-TOKEN": token },
      });
      if (!res.ok) throw new Error(`GitLab API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    },
    slack: async () => {
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`Slack: ${data.error}`);
      return { success: true, message: `Connected to ${data.team}` };
    },
    discord: async () => {
      const res = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) throw new Error(`Discord API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    },
    notion: async () => {
      const res = await fetch("https://api.notion.com/v1/users/me", {
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
      });
      if (!res.ok) throw new Error(`Notion API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || data.id}` };
    },
    jira: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const domain = config.site_url || config.domain || config.base_url;
      if (!domain) throw new Error("Jira site URL not configured");
      const rawUrl = domain.includes("://") ? domain : `https://${domain}`;
      const url = assertSafeUrl(rawUrl, "Jira site URL");
      const email = config.email;
      if (!email) throw new Error("Jira email not configured");
      const res = await fetch(`${url}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`Jira API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.displayName}` };
    },
    linear: async () => {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
      });
      if (!res.ok) throw new Error(`Linear API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.data?.viewer?.name || "verified"}` };
    },
    datadog: async () => {
      const res = await fetch("https://api.datadoghq.com/api/v1/validate", {
        headers: { "DD-API-KEY": token },
      });
      if (!res.ok) throw new Error(`Datadog API returned ${res.status}`);
      return { success: true, message: "API key validated" };
    },
    sentry: async () => {
      const res = await fetch("https://sentry.io/api/0/", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Sentry API returned ${res.status}`);
      return { success: true, message: "Authenticated successfully" };
    },
    sendgrid: async () => {
      const res = await fetch("https://api.sendgrid.com/v3/user/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`SendGrid API returned ${res.status}`);
      return { success: true, message: "API key validated" };
    },
    openai: async () => {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`OpenAI API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected (${data.data?.length || 0} models available)` };
    },
    anthropic: async () => {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);
      return { success: true, message: "API key validated" };
    },
    huggingface: async () => {
      const res = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Hugging Face API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || data.fullname || "verified"}` };
    },
    bitbucket: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const username = config.username;
      if (!username) throw new Error("Bitbucket username not configured");
      const res = await fetch("https://api.bitbucket.org/2.0/user", {
        headers: { Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`Bitbucket API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.username || data.display_name}` };
    },
    airtable: async () => {
      const res = await fetch("https://api.airtable.com/v0/meta/whoami", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Airtable API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.email || data.id}` };
    },
    asana: async () => {
      const res = await fetch("https://app.asana.com/api/1.0/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Asana API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.data?.name || "verified"}` };
    },
    monday: async () => {
      const res = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ me { name } }" }),
      });
      if (!res.ok) throw new Error(`Monday.com API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.data?.me?.name || "verified"}` };
    },
    clickup: async () => {
      const res = await fetch("https://api.clickup.com/api/v2/user", {
        headers: { Authorization: token },
      });
      if (!res.ok) throw new Error(`ClickUp API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.user?.username || "verified"}` };
    },
    trello: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const apiKey = config.api_key;
      if (!apiKey) throw new Error("Trello API key not configured");
      const res = await fetch(`https://api.trello.com/1/members/me?key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error(`Trello API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    },
    confluence: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const baseUrl = config.base_url;
      const email = config.email;
      if (!baseUrl) throw new Error("Confluence URL not configured");
      if (!email) throw new Error("Confluence email not configured");
      const url = baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`;
      const res = await fetch(`${url}/wiki/rest/api/user/current`, {
        headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`Confluence API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.displayName || data.username || "verified"}` };
    },
    digitalocean: async () => {
      const res = await fetch("https://api.digitalocean.com/v2/account", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`DigitalOcean API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected (${data.account?.email || "verified"})` };
    },
    supabase: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const url = config.url;
      if (!url) throw new Error("Supabase project URL not configured");
      const res = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: token, Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Supabase API returned ${res.status}`);
      return { success: true, message: "Connected to Supabase" };
    },
    stripe: async () => {
      const res = await fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Stripe API returned ${res.status}`);
      return { success: true, message: "Balance verified" };
    },
    hubspot: async () => {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HubSpot API returned ${res.status}`);
      return { success: true, message: "Connected to HubSpot" };
    },
    pipedrive: async () => {
      const res = await fetch(`https://api.pipedrive.com/v1/users/me?api_token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error(`Pipedrive API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.data?.name || "verified"}` };
    },
    zendesk: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const subdomain = config.subdomain;
      const email = config.email;
      if (!subdomain) throw new Error("Zendesk subdomain not configured");
      if (!email) throw new Error("Zendesk email not configured");
      const res = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, {
        headers: { Authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`Zendesk API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.user?.name || "verified"}` };
    },
    elasticsearch: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const nodeUrl = config.node_url;
      if (!nodeUrl) throw new Error("Elasticsearch node URL not configured");
      const headers = {};
      if (config.username) {
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${token}`).toString("base64")}`;
      }
      const res = await fetch(nodeUrl, { headers });
      if (!res.ok) throw new Error(`Elasticsearch returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected to cluster "${data.cluster_name || "unknown"}"` };
    },
    pinecone: async () => {
      const res = await fetch("https://api.pinecone.io/indexes", {
        headers: { "Api-Key": token },
      });
      if (!res.ok) throw new Error(`Pinecone API returned ${res.status}`);
      return { success: true, message: "Connected to Pinecone" };
    },
    algolia: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const appId = config.app_id;
      if (!appId) throw new Error("Algolia Application ID not configured");
      const res = await fetch(`https://${appId}-dsn.algolia.net/1/keys`, {
        headers: { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": token },
      });
      if (!res.ok) throw new Error(`Algolia API returned ${res.status}`);
      return { success: true, message: "Connected to Algolia" };
    },
    vercel: async () => {
      const res = await fetch("https://api.vercel.com/v2/user", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Vercel API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.user?.username || "verified"}` };
    },
    circleci: async () => {
      const res = await fetch("https://circleci.com/api/v2/me", {
        headers: { "Circle-Token": token },
      });
      if (!res.ok) throw new Error(`CircleCI API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || data.login || "verified"}` };
    },
    terraform: async () => {
      const res = await fetch("https://app.terraform.io/api/v2/account/details", {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.api+json" },
      });
      if (!res.ok) throw new Error(`Terraform Cloud API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.data?.attributes?.username || "verified"}` };
    },
    grafana: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const url = config.url;
      if (!url) throw new Error("Grafana URL not configured");
      const res = await fetch(`${url}/api/org`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Grafana API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected to ${data.name || "Grafana"}` };
    },
    pagerduty: async () => {
      const res = await fetch("https://api.pagerduty.com/users/me", {
        headers: { Authorization: `Token token=${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`PagerDuty API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.user?.name || "verified"}` };
    },
    jenkins: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const url = config.url;
      const username = config.username;
      if (!url) throw new Error("Jenkins URL not configured");
      if (!username) throw new Error("Jenkins username not configured");
      const res = await fetch(`${url}/api/json`, {
        headers: { Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`Jenkins API returned ${res.status}`);
      return { success: true, message: "Connected to Jenkins" };
    },
    dropbox: async () => {
      const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Dropbox API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name?.display_name || "verified"}` };
    },
    twilio: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const sid = config.account_sid;
      if (!sid) throw new Error("Twilio Account SID not configured");
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`Twilio API returned ${res.status}`);
      return { success: true, message: "Connected to Twilio" };
    },
    shopify: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const shop = config.shop_domain;
      if (!shop) throw new Error("Shopify shop domain not configured");
      const domain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
      const res = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
        headers: { "X-Shopify-Access-Token": token },
      });
      if (!res.ok) throw new Error(`Shopify API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected to ${data.shop?.name || shop}` };
    },
    woocommerce: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const siteUrl = config.site_url;
      const consumerKey = config.consumer_key;
      if (!siteUrl) throw new Error("WooCommerce site URL not configured");
      if (!consumerKey) throw new Error("WooCommerce consumer key not configured");
      const url = siteUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/wp-json/wc/v3/system_status`, {
        headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`WooCommerce API returned ${res.status}`);
      return { success: true, message: "Connected to WooCommerce" };
    },
    linkedin: async () => {
      const res = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`LinkedIn API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || data.given_name || "verified"}` };
    },
    facebook: async () => {
      const res = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error(`Facebook API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || "verified"}` };
    },
    "docker-hub": async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const username = config.username;
      if (!username) throw new Error("Docker Hub username not configured");
      const res = await fetch("https://hub.docker.com/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: token }),
      });
      if (!res.ok) throw new Error(`Docker Hub API returned ${res.status}`);
      return { success: true, message: `Connected as ${username}` };
    },
    salesforce: async () => {
      const config = typeof integration.config === "string" ? JSON.parse(integration.config) : (integration.config || {});
      const instanceUrl = config.instance_url;
      if (!instanceUrl) throw new Error("Salesforce instance URL not configured");
      const res = await fetch(`${instanceUrl}/services/data/v59.0/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Salesforce API returned ${res.status}`);
      return { success: true, message: "Connected to Salesforce" };
    },
    twitter: async () => {
      const res = await fetch("https://api.twitter.com/2/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Twitter/X API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as @${data.data?.username || "verified"}` };
    },
  };

  const tester = connectivityTests[provider];
  if (tester) {
    try {
      return await tester();
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Fallback for providers without specific tests
  return { success: true, message: "Credentials stored (connectivity not verified for this provider)" };
}

/**
 * Build integration summary for syncing to agent containers.
 */
async function getIntegrationsForSync(agentId) {
  const result = await db.query(
    `SELECT i.id, i.provider, i.catalog_id, i.config, i.status,
            ic.name as catalog_name, ic.category as catalog_category,
            ic.auth_type, ic.config_schema
     FROM integrations i
     LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
     WHERE i.agent_id = $1 AND i.status = 'active'`,
    [agentId]
  );
  return result.rows.map(buildIntegrationSyncEntry);
}

/**
 * Return a plain object of { ENV_VAR_NAME: decryptedToken } for all active
 * integrations on the given agent that have a known env var mapping.
 * Used by the provisioner (bake into container at creation time) and by the
 * integrations sync route (push live tokens into a running gateway via RPC).
 */
async function getIntegrationEnvVars(agentId) {
  const result = await db.query(
    "SELECT provider, access_token, config FROM integrations WHERE agent_id = $1 AND status = 'active'",
    [agentId]
  );
  const envVars = {};
  for (const row of result.rows) {
    // 1. Primary credential stored in access_token column
    const envName = INTEGRATION_ENV_MAP[row.provider];
    if (envName && row.access_token) {
      envVars[envName] = decrypt(row.access_token);
    }

    // 2. Additional config fields (URLs, usernames, IDs, secondary secrets)
    const cfg = decryptSensitiveConfig(row.provider, row.config);
    for (const [cfgKey, cfgValue] of Object.entries(cfg)) {
      if (!cfgValue) continue;
      const cfgEnvName = INTEGRATION_CONFIG_ENV_MAP[`${row.provider}.${cfgKey}`];
      if (cfgEnvName) {
        envVars[cfgEnvName] = String(cfgValue);
      }
    }
  }
  return envVars;
}

module.exports = {
  buildCloneableIntegration,
  buildIntegrationSyncEntry,
  buildIntegrationToolCatalogEntries,
  seedCatalog,
  getCatalog,
  getCatalogItem,
  connectIntegration,
  listIntegrations,
  removeIntegration,
  testIntegration,
  getIntegrationsForSync,
  getIntegrationEnvVars,
  INTEGRATION_ENV_MAP,
  INTEGRATION_CONFIG_ENV_MAP,
  stripSensitiveConfig,
};
