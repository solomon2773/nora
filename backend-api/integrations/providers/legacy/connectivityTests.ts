// @ts-nocheck
// Verbatim move of the 52-provider connectivity-test object that
// previously lived inline inside testIntegration() in integrations.ts.
// Each test closes over `integration` and `token` from the factory args.
// PR 4 begins migrating individual providers to the strategy interface;
// once a provider is registered via ProviderRegistry, its entry here is
// removed.

const TWITTER_OAUTH_AUTH_HINT =
  "Use an OAuth 2.0 user access token with tweet.read, users.read, and tweet.write scopes. The app-only Bearer Token and read-only OAuth 1.0 Access Token from Keys and Tokens are not valid for Nora's user-context Twitter/X integration.";

async function readProviderErrorResponse(res) {
  const rawText = await res.text().catch(() => "");
  if (!rawText) return { rawText: "", data: null };

  try {
    return { rawText, data: JSON.parse(rawText) };
  } catch {
    return { rawText, data: null };
  }
}

function providerErrorMessage(data, rawText) {
  const firstError = Array.isArray(data?.errors) ? data.errors[0] : null;
  return (
    firstError?.detail ||
    firstError?.message ||
    data?.detail ||
    data?.message ||
    data?.title ||
    rawText ||
    ""
  );
}

function buildTwitterApiError(status, data, rawText) {
  const detail = providerErrorMessage(data, rawText);
  const hint = status === 401 || status === 403 ? TWITTER_OAUTH_AUTH_HINT : "";
  return ["Twitter/X API returned " + status, detail, hint].filter(Boolean).join(": ");
}

function buildConnectivityTests(integration, token, deps) {
  const { assertSafeUrl } = deps;

  return {
    // gitlab → migrated to providers/gitlab.ts
    // discord → migrated to providers/discord.ts
    notion: async () => {
      const res = await fetch("https://api.notion.com/v1/users/me", {
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
      });
      if (!res.ok) throw new Error(`Notion API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || data.id}` };
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
    // sendgrid → migrated to providers/sendgrid.ts
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
    // bitbucket → migrated to providers/bitbucket.ts
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
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const apiKey = config.api_key;
      if (!apiKey) throw new Error("Trello API key not configured");
      const res = await fetch(
        `https://api.trello.com/1/members/me?key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) throw new Error(`Trello API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    },
    confluence: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const baseUrl = config.base_url;
      const email = config.email;
      if (!baseUrl) throw new Error("Confluence URL not configured");
      if (!email) throw new Error("Confluence email not configured");
      const rawUrl = baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`;
      const url = await assertSafeUrl(rawUrl, "Confluence base URL");
      const res = await fetch(`${url}/wiki/rest/api/user/current`, {
        headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
      });
      if (!res.ok) throw new Error(`Confluence API returned ${res.status}`);
      const data = await res.json();
      return {
        success: true,
        message: `Connected as ${data.displayName || data.username || "verified"}`,
      };
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
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const rawUrl = config.url;
      if (!rawUrl) throw new Error("Supabase project URL not configured");
      const url = await assertSafeUrl(rawUrl, "Supabase URL");
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
      const res = await fetch(
        `https://api.pipedrive.com/v1/users/me?api_token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) throw new Error(`Pipedrive API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.data?.name || "verified"}` };
    },
    zendesk: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const subdomain = config.subdomain;
      const email = config.email;
      if (!subdomain) throw new Error("Zendesk subdomain not configured");
      if (!email) throw new Error("Zendesk email not configured");
      const res = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`,
        },
      });
      if (!res.ok) throw new Error(`Zendesk API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.user?.name || "verified"}` };
    },
    elasticsearch: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const rawUrl = config.node_url;
      if (!rawUrl) throw new Error("Elasticsearch node URL not configured");
      const nodeUrl = await assertSafeUrl(rawUrl, "Elasticsearch node URL");
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
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const appId = config.app_id;
      if (!appId) throw new Error("Algolia Application ID not configured");
      const res = await fetch(`https://${appId}-dsn.algolia.net/1/keys`, {
        headers: { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": token },
      });
      if (!res.ok) throw new Error(`Algolia API returned ${res.status}`);
      return { success: true, message: "Connected to Algolia" };
    },
    // vercel → migrated to providers/vercel.ts
    // circleci → migrated to providers/circleci.ts
    // terraform → migrated to providers/terraform.ts
    grafana: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const rawUrl = config.url;
      if (!rawUrl) throw new Error("Grafana URL not configured");
      const url = await assertSafeUrl(rawUrl, "Grafana URL");
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
    // jenkins → migrated to providers/jenkins.ts
    dropbox: async () => {
      const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Dropbox API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name?.display_name || "verified"}` };
    },
    // twilio → migrated to providers/twilio.ts
    // telegram → migrated to providers/telegram.ts
    shopify: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
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
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const siteUrl = config.site_url;
      const consumerKey = config.consumer_key;
      if (!siteUrl) throw new Error("WooCommerce site URL not configured");
      if (!consumerKey) throw new Error("WooCommerce consumer key not configured");
      const url = await assertSafeUrl(siteUrl, "WooCommerce site URL");
      const res = await fetch(`${url}/wp-json/wc/v3/system_status`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${consumerKey}:${token}`).toString("base64")}`,
        },
      });
      if (!res.ok) throw new Error(`WooCommerce API returned ${res.status}`);
      return { success: true, message: "Connected to WooCommerce" };
    },
    facebook: async () => {
      const res = await fetch(
        `https://graph.facebook.com/v18.0/me?access_token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) throw new Error(`Facebook API returned ${res.status}`);
      const data = await res.json();
      return { success: true, message: `Connected as ${data.name || "verified"}` };
    },
    instagram: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const accountId = String(config.business_account_id || "").trim();
      const path = accountId
        ? `${encodeURIComponent(accountId)}?fields=id,username`
        : "me?fields=id,name";
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${path}&access_token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) throw new Error(`Instagram Graph API returned ${res.status}`);
      const data = await res.json();
      return {
        success: true,
        message: `Connected as ${data.username || data.name || data.id || "verified"}`,
      };
    },
    // docker-hub → migrated to providers/dockerHub.ts
    salesforce: async () => {
      const config =
        typeof integration.config === "string"
          ? JSON.parse(integration.config)
          : integration.config || {};
      const rawUrl = config.instance_url;
      if (!rawUrl) throw new Error("Salesforce instance URL not configured");
      const instanceUrl = await assertSafeUrl(rawUrl, "Salesforce instance URL");
      const res = await fetch(`${instanceUrl}/services/data/v59.0/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Salesforce API returned ${res.status}`);
      return { success: true, message: "Connected to Salesforce" };
    },
  };
}

module.exports = {
  buildConnectivityTests,
  readProviderErrorResponse,
  providerErrorMessage,
  buildTwitterApiError,
};
