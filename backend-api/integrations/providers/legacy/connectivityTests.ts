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
    // datadog → migrated to providers/datadog.ts
    // sentry → migrated to providers/sentry.ts
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
    // grafana → migrated to providers/grafana.ts
    // pagerduty → migrated to providers/pagerduty.ts
    // jenkins → migrated to providers/jenkins.ts
    // dropbox → migrated to providers/dropbox.ts
    // twilio → migrated to providers/twilio.ts
    // telegram → migrated to providers/telegram.ts
    // shopify → migrated to providers/shopify.ts
    // woocommerce → migrated to providers/woocommerce.ts
    // facebook → migrated to providers/facebook.ts
    // instagram → migrated to providers/instagram.ts
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
