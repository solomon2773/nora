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
    // notion → migrated to providers/notion.ts
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
    // openai → migrated to providers/openai.ts
    // anthropic → migrated to providers/anthropic.ts
    // huggingface → migrated to providers/huggingface.ts
    // bitbucket → migrated to providers/bitbucket.ts
    // airtable → migrated to providers/airtable.ts
    // asana → migrated to providers/asana.ts
    // monday → migrated to providers/monday.ts
    // clickup → migrated to providers/clickup.ts
    // trello → migrated to providers/trello.ts
    // confluence → migrated to providers/confluence.ts
    // digitalocean → migrated to providers/digitalocean.ts
    // supabase → migrated to providers/supabase.ts
    // stripe → migrated to providers/stripe.ts
    // hubspot → migrated to providers/hubspot.ts
    // pipedrive → migrated to providers/pipedrive.ts
    // zendesk → migrated to providers/zendesk.ts
    // elasticsearch → migrated to providers/elasticsearch.ts
    // pinecone → migrated to providers/pinecone.ts
    // algolia → migrated to providers/algolia.ts
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
    // dropbox → migrated to providers/dropbox.ts
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
    // salesforce → migrated to providers/salesforce.ts
  };
}

module.exports = {
  buildConnectivityTests,
  readProviderErrorResponse,
  providerErrorMessage,
  buildTwitterApiError,
};
