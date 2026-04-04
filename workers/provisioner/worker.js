const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { Pool } = require('pg');
const { agentRuntimeUrl } = require('../../agent-runtime/lib/contracts');
const { waitForAgentReadiness } = require('./healthChecks');
const { buildReadinessWarningDetail, buildReadinessWarningState } = require('./readinessWarning');

// ── Connections ──────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null
});

const db = new Pool({
  user: process.env.DB_USER || 'platform',
  password: process.env.DB_PASSWORD || 'platform',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'platform',
  port: parseInt(process.env.DB_PORT || '5432'),
});

// ── Pluggable Backend ────────────────────────────────────
function loadBackend(backendId) {
  const backend = (backendId || process.env.PROVISIONER_BACKEND || 'docker').toLowerCase();
  switch (backend) {
    case 'docker':
      return new (require('./backends/docker'))();
    case 'nemoclaw':
      return new (require('./backends/nemoclaw'))();
    case 'proxmox':
      return new (require('./backends/proxmox'))();
    case 'k8s':
    case 'kubernetes':
      return new (require('./backends/k8s'))();
    default:
      console.warn(`Unknown backend "${backend}", falling back to docker`);
      return new (require('./backends/docker'))();
  }
}

// Default backend from env — individual jobs can override via sandbox field
const defaultProvisioner = loadBackend();
const defaultBackendName = process.env.PROVISIONER_BACKEND || 'docker';
console.log(`Provisioner worker started [default backend=${defaultBackendName}]`);

// ── Worker ───────────────────────────────────────────────
const worker = new Worker('deployments', async (job) => {
  const { id, name, image, specs, userId, sandbox, container_name } = job.data;
  const vcpu = specs?.vcpu || 2;
  const ram_mb = specs?.ram_mb || 2048;
  const disk_gb = specs?.disk_gb || 20;

  // Select provisioner: per-job sandbox type overrides default backend
  const provisioner = sandbox === 'nemoclaw' ? loadBackend('nemoclaw') : defaultProvisioner;
  const backendName = sandbox === 'nemoclaw' ? 'nemoclaw' : defaultBackendName;

  console.log(`Processing deployment job ${job.id}: agent=${id} name=${name} backend=${backendName} (${vcpu}vCPU/${ram_mb}MB/${disk_gb}GB)`);

  // Fetch user's LLM provider keys from DB for injection into container
  let llmEnvVars = {};
  if (userId && (process.env.KEY_STORAGE || 'database') === 'database') {
    try {
      const keysResult = await db.query(
        "SELECT provider, api_key FROM llm_providers WHERE user_id = $1",
        [userId]
      );
      // Map provider names to env var names
      const providerEnvMap = {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GEMINI_API_KEY',
        groq: 'GROQ_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        together: 'TOGETHER_API_KEY',
        cohere: 'COHERE_API_KEY',
        xai: 'XAI_API_KEY',
        moonshot: 'MOONSHOT_API_KEY',
        zai: 'ZAI_API_KEY',
        ollama: 'OLLAMA_API_KEY',
        minimax: 'MINIMAX_API_KEY',
        'github-copilot': 'COPILOT_GITHUB_TOKEN',
        huggingface: 'HF_TOKEN',
        cerebras: 'CEREBRAS_API_KEY',
        nvidia: 'NVIDIA_API_KEY',
      };
      for (const row of keysResult.rows) {
        const envName = providerEnvMap[row.provider];
        if (envName && row.api_key) {
          try {
            const { decrypt } = require('./crypto');
            llmEnvVars[envName] = decrypt(row.api_key);
          } catch {
            llmEnvVars[envName] = row.api_key;
          }
        }
      }
      if (Object.keys(llmEnvVars).length > 0) {
        console.log(`[provisioner] Injecting ${Object.keys(llmEnvVars).length} LLM provider key(s) for user ${userId}`);
      }
    } catch (e) {
      console.warn(`[provisioner] Failed to fetch LLM keys for user ${userId}:`, e.message);
    }
  }

  // Fetch integration credentials for this agent and inject as env vars into the container
  let integrationEnvVars = {};
  try {
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
      aws:                  'AWS_SECRET_ACCESS_KEY',
      azure:                'AZURE_CLIENT_SECRET',
      s3:                   'S3_SECRET_ACCESS_KEY',
      mongodb:              'MONGODB_URI',
      redis:                'REDIS_PASSWORD',
      postgresql:           'PGPASSWORD',
      paypal:               'PAYPAL_CLIENT_SECRET',
      segment:              'SEGMENT_WRITE_KEY',
      mixpanel:             'MIXPANEL_API_SECRET',
      weaviate:             'WEAVIATE_API_KEY',
      email:                'SMTP_PASS',
    };
    const INTEGRATION_CONFIG_ENV_MAP = {
      'github.org':                       'GITHUB_ORG',
      'gitlab.base_url':                  'GITLAB_BASE_URL',
      'bitbucket.username':               'BITBUCKET_USERNAME',
      'bitbucket.workspace':              'BITBUCKET_WORKSPACE',
      'jira.email':                       'JIRA_EMAIL',
      'jira.site_url':                    'JIRA_BASE_URL',
      'jira.project_key':                 'JIRA_PROJECT_KEY',
      'linear.team_id':                   'LINEAR_TEAM_ID',
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
      'openai.org_id':                    'OPENAI_ORG_ID',
      'huggingface.model_id':             'HF_DEFAULT_MODEL',
      'aws.access_key_id':                'AWS_ACCESS_KEY_ID',
      'aws.region':                       'AWS_DEFAULT_REGION',
      'gcp.service_account_json':         'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      'gcp.project_id':                   'GCP_PROJECT_ID',
      'azure.tenant_id':                  'AZURE_TENANT_ID',
      'azure.client_id':                  'AZURE_CLIENT_ID',
      's3.access_key_id':                 'S3_ACCESS_KEY_ID',
      's3.region':                        'S3_REGION',
      's3.bucket':                        'S3_BUCKET',
      'google-drive.service_account_json':'GOOGLE_DRIVE_SA_JSON',
      'google-drive.folder_id':           'GOOGLE_DRIVE_FOLDER_ID',
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
      'pinecone.environment':             'PINECONE_ENVIRONMENT',
      'pinecone.index_name':              'PINECONE_INDEX',
      'algolia.app_id':                   'ALGOLIA_APP_ID',
      'algolia.index_name':               'ALGOLIA_INDEX',
      'datadog.app_key':                  'DD_APP_KEY',
      'datadog.site':                     'DD_SITE',
      'pagerduty.routing_key':            'PAGERDUTY_ROUTING_KEY',
      'sentry.organization':              'SENTRY_ORG',
      'sentry.project':                   'SENTRY_PROJECT',
      'grafana.url':                      'GRAFANA_URL',
      'jenkins.url':                      'JENKINS_URL',
      'jenkins.username':                 'JENKINS_USERNAME',
      'vercel.team_id':                   'VERCEL_TEAM_ID',
      'terraform.organization':           'TF_ORGANIZATION',
      'kubernetes.kubeconfig':            'KUBECONFIG_CONTENT',
      'kubernetes.context':               'KUBE_CONTEXT',
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
      'salesforce.instance_url':          'SALESFORCE_INSTANCE_URL',
      'zendesk.subdomain':                'ZENDESK_SUBDOMAIN',
      'zendesk.email':                    'ZENDESK_EMAIL',
      'pipedrive.company_domain':         'PIPEDRIVE_DOMAIN',
      'paypal.client_id':                 'PAYPAL_CLIENT_ID',
      'stripe.webhook_secret':            'STRIPE_WEBHOOK_SECRET',
      'twitter.api_key':                  'TWITTER_API_KEY',
      'twitter.api_secret':               'TWITTER_API_SECRET',
      'facebook.page_id':                 'FACEBOOK_PAGE_ID',
      'mixpanel.project_token':           'MIXPANEL_PROJECT_TOKEN',
      'google-analytics.service_account_json': 'GOOGLE_ANALYTICS_SA_JSON',
      'google-analytics.property_id':     'GA4_PROPERTY_ID',
      'shopify.shop_domain':              'SHOPIFY_SHOP_DOMAIN',
      'woocommerce.site_url':             'WOOCOMMERCE_STORE_URL',
      'woocommerce.consumer_key':         'WOOCOMMERCE_CONSUMER_KEY',
      'zapier.webhook_url':               'ZAPIER_WEBHOOK_URL',
      'make.webhook_url':                 'MAKE_WEBHOOK_URL',
      'n8n.webhook_url':                  'N8N_WEBHOOK_URL',
      'n8n.api_key':                      'N8N_API_KEY',
      'docker-hub.username':              'DOCKER_HUB_USERNAME',
    };
    const intResult = await db.query(
      "SELECT provider, access_token, config FROM integrations WHERE agent_id = $1 AND status = 'active'",
      [id]
    );
    const { decrypt } = require('./crypto');
    for (const row of intResult.rows) {
      // Primary token
      const envName = INTEGRATION_ENV_MAP[row.provider];
      if (envName && row.access_token) {
        try {
          integrationEnvVars[envName] = decrypt(row.access_token);
        } catch {
          integrationEnvVars[envName] = row.access_token;
        }
      }
      // Config fields (URLs, usernames, IDs, secondary secrets)
      const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {});
      for (const [cfgKey, cfgValue] of Object.entries(cfg)) {
        if (!cfgValue) continue;
        const cfgEnvName = INTEGRATION_CONFIG_ENV_MAP[`${row.provider}.${cfgKey}`];
        if (cfgEnvName) {
          integrationEnvVars[cfgEnvName] = String(cfgValue);
        }
      }
    }
    if (Object.keys(integrationEnvVars).length > 0) {
      console.log(`[provisioner] Injecting ${Object.keys(integrationEnvVars).length} integration credential(s) for agent ${id}`);
    }
  } catch (e) {
    console.warn(`[provisioner] Failed to fetch integration credentials for agent ${id}:`, e.message);
  }

  const PROVISION_TIMEOUT = 240000; // 4 min (leaving 1 min margin for the 5-min job timeout)

  let containerId, host, gatewayToken, containerName, gatewayHostPort, runtimeHost, runtimePort, gatewayHost, gatewayPort;
  try {
    const result = await Promise.race([
      provisioner.create({
        id,
        name,
        image: image || 'node:22-slim',
        vcpu,
        ram_mb,
        disk_gb,
        container_name,
        env: { AGENT_ID: String(id), AGENT_NAME: name || '', ...llmEnvVars, ...integrationEnvVars },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Provisioner create() timed out after ${PROVISION_TIMEOUT / 1000}s`)), PROVISION_TIMEOUT)
      ),
    ]);
    containerId = result.containerId;
    host = result.host;
    gatewayToken = result.gatewayToken;
    containerName = result.containerName || container_name;
    gatewayHostPort = result.gatewayHostPort || null;
    runtimeHost = result.runtimeHost || null;
    runtimePort = result.runtimePort || null;
    gatewayHost = result.gatewayHost || null;
    gatewayPort = result.gatewayPort || null;

    // If network discovery failed, host may be "localhost" which is unreachable
    // from backend-api. Attempt to resolve the correct Compose network IP.
    if (host === "localhost" && containerId) {
      try {
        const Docker = require('dockerode');
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        const info = await docker.getContainer(containerId).inspect();
        const nets = info.NetworkSettings?.Networks || {};
        for (const [netName, netInfo] of Object.entries(nets)) {
          if (netName.endsWith('_default') && netInfo.IPAddress) {
            host = netInfo.IPAddress;
            console.log(`[provisioner] Resolved host via container inspect: ${host} (${netName})`);
            break;
          }
        }
      } catch (e) {
        console.warn(`[provisioner] Failed to resolve host from container networks: ${e.message}`);
      }
      // Last resort: use container name (Docker DNS resolves it on the compose network)
      if (host === "localhost" && containerName) {
        host = containerName;
        console.log(`[provisioner] Falling back to container name as host: ${host}`);
      }
    }
  } catch (err) {
    console.error(`[${backendName}] Provisioning failed for agent ${id} (attempt ${job.attemptsMade + 1}/${job.opts?.attempts || 1}):`, err.message);
    // Mark as failed in DB
    await db.query("UPDATE agents SET status = 'error' WHERE id = $1", [id]);
    await db.query("UPDATE deployments SET status = 'failed' WHERE agent_id = $1", [id]);
    await db.query(
      "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
      ['agent_deploy_failed', `Agent "${name}" failed to deploy: ${err.message}`, JSON.stringify({ agentId: id, attempt: job.attemptsMade + 1 })]
    );
    throw err;
  }

  // Update agent with real container info
  try {
    await db.query(
      "UPDATE agents SET status = 'running', container_id = $2, host = $3, backend_type = $4, gateway_token = $5, container_name = COALESCE($6, container_name), gateway_host_port = COALESCE($7, gateway_host_port) WHERE id = $1",
      [id, containerId, host, backendName, gatewayToken, containerName || null, gatewayHostPort ? parseInt(gatewayHostPort) : null]
    );
    await db.query("UPDATE deployments SET status = 'completed' WHERE agent_id = $1", [id]);
    await db.query(
      "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
      ['agent_deployed', `Agent "${name}" is now running on ${backendName}`, JSON.stringify({ agentId: id, containerId, host })]
    );
    console.log(`Agent ${id} deployed: containerId=${containerId} host=${host}`);

    // Post-deploy readiness check: verify both the runtime sidecar and the gateway.
    // First boot may need time for npm installation and initial startup, so we allow
    // generous bounded retries and emit a warning state with explicit component detail.
    const readiness = await waitForAgentReadiness({
      host,
      runtimeHost,
      runtimePort,
      gatewayHost,
      gatewayHostPort,
      gatewayPort,
    });
    if (!readiness.ok) {
      const detail = buildReadinessWarningDetail(readiness);
      const warningState = buildReadinessWarningState({ agentId: id, name, host, readiness });
      console.warn(`[provisioner] Readiness check failed for agent ${id}: ${detail}`);
      await db.query(`UPDATE agents SET status = '${warningState.agentStatus}' WHERE id = $1`, [id]);
      await db.query(`UPDATE deployments SET status = '${warningState.deploymentStatus}' WHERE agent_id = $1`, [id]);
      await db.query(
        "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
        [warningState.event.type, warningState.event.message, JSON.stringify(warningState.event.metadata)]
      );
    }

    // Sync integrations to newly deployed agent container
    try {
      const intResult = await db.query(
        `SELECT i.id, i.provider, i.catalog_id, i.config, i.status,
                ic.name as catalog_name, ic.category as catalog_category
         FROM integrations i
         LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
         WHERE i.agent_id = $1 AND i.status = 'active'`,
        [id]
      );
      if (intResult.rows.length > 0) {
        const syncData = intResult.rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          name: r.catalog_name || r.provider,
          category: r.catalog_category || "unknown",
          config: typeof r.config === "string" ? JSON.parse(r.config) : (r.config || {}),
          status: r.status,
        }));
        await fetch(agentRuntimeUrl(host, "/integrations/sync"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(syncData),
        });
        console.log(`[provisioner] Synced ${syncData.length} integration(s) to agent ${id}`);
      }
    } catch (e) {
      console.warn(`[provisioner] Failed to sync integrations for agent ${id}:`, e.message);
    }
  } catch (err) {
    console.error('Failed to update agent status:', err.message);
    throw err;
  }
}, { connection, concurrency: 3 });

worker.on('failed', async (job, err) => {
  const attempts = job?.attemptsMade || 0;
  const maxAttempts = job?.opts?.attempts || 1;
  console.error(`Job ${job?.id} failed (attempt ${attempts}/${maxAttempts}): ${err.message}`);

  if (job && attempts >= maxAttempts) {
    // Final failure — job exhausted all retries, now in dead letter queue
    console.error(`[DLQ] Agent "${job.data.name}" (${job.data.id}) exhausted all ${maxAttempts} retry attempts`);
    try {
      await db.query(
        "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
        ['agent_deploy_dlq', `Agent "${job.data.name}" exhausted all ${maxAttempts} retry attempts`, JSON.stringify({ agentId: job.data.id, error: err.message, jobId: job.id })]
      );
    } catch (dbErr) {
      console.error('[DLQ] Failed to log DLQ event:', dbErr.message);
    }
  }
});

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

// ── Health Check Server ──────────────────────────────────────────
const http = require('http');
const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || '4001');
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const isReady = worker.isRunning();
    res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isReady ? 'ok' : 'not_ready', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(HEALTH_PORT, () => {
  console.log(`Worker health check listening on port ${HEALTH_PORT}`);
});
