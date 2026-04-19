// Real-credential integration tests: connect GitHub / Slack / a URL-based
// provider (Grafana|Jenkins|Confluence) against an OpenClaw+Docker agent and
// exercise both connectivity AND the SSRF guard shipped in integrations.ts.
//
// Requires .env.real entries described in e2e/REAL_TESTS.md.

import { expect, test } from "@playwright/test";
import {
  DEFAULT_PASSWORD,
  apiJson,
  createUserSession,
  uniqueEmail,
  uniqueName,
} from "./support/app";
import {
  deployAgent,
  waitForAgentStatus,
  deleteAgent,
  connectIntegration,
  testIntegration,
  listAgentIntegrations,
  deleteIntegration,
  saveProviderKey,
  getPlatformConfig,
  backendSupported,
} from "./support/agents";
import { real } from "./support/realConfig";

test.describe("Integrations — real credentials", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(real.provisionTimeoutMs + 300000);

  /** @type {{email: string, password: string, token: string} | null} */
  let operator = null;
  /** @type {any} */
  let agent = null;

  test.beforeAll(async ({ request }) => {
    test.skip(
      !real.llmApiKey,
      "REAL_LLM_API_KEY (or provider-specific key) not set"
    );
    test.skip(
      !real.enableOpenclawDocker,
      "OpenClaw+Docker cell disabled; integrations spec needs a host agent"
    );

    operator = await createUserSession(request, {
      email: uniqueEmail("nora-real-integrations"),
      password: DEFAULT_PASSWORD,
    });
    await saveProviderKey(request, operator.token, {
      provider: real.llmProviderId,
      apiKey: real.llmApiKey,
      model: real.llmModel || undefined,
    });

    const platform = await getPlatformConfig(request, operator.token);
    test.skip(!backendSupported(platform, "docker"), "Docker backend not enabled");

    agent = await deployAgent(request, operator.token, {
      name: uniqueName("real-integrations-host"),
      runtimeFamily: "openclaw",
      backend: "docker",
      sandboxProfile: "standard",
    });
    agent = await waitForAgentStatus(
      request,
      operator.token,
      agent.id,
      ["running", "warning"],
      { timeoutMs: real.provisionTimeoutMs }
    );
  });

  test.afterAll(async ({ request }) => {
    if (agent?.id) {
      await deleteAgent(request, operator.token, agent.id);
    }
  });

  test("[I1] GitHub token authenticates against api.github.com", async ({ request }) => {
    test.skip(!real.githubToken, "REAL_GITHUB_TOKEN not set");
    const integration = await connectIntegration(request, operator.token, agent.id, {
      provider: "github",
      token: real.githubToken,
      config: {},
    });
    expect(integration?.id).toBeTruthy();

    const result = await testIntegration(
      request,
      operator.token,
      agent.id,
      integration.id
    );
    expect(result?.success, JSON.stringify(result)).toBe(true);

    await deleteIntegration(request, operator.token, agent.id, integration.id);
  });

  test("[I2] Slack bot token authenticates against slack.com", async ({ request }) => {
    test.skip(!real.slackToken, "REAL_SLACK_TOKEN not set");
    const integration = await connectIntegration(request, operator.token, agent.id, {
      provider: "slack",
      token: real.slackToken,
      config: {},
    });
    expect(integration?.id).toBeTruthy();

    const result = await testIntegration(
      request,
      operator.token,
      agent.id,
      integration.id
    );
    expect(result?.success, JSON.stringify(result)).toBe(true);

    await deleteIntegration(request, operator.token, agent.id, integration.id);
  });

  test("[I3] URL-based integration succeeds on real host", async ({ request }) => {
    test.skip(
      !real.urlIntegrationProvider ||
        !real.urlIntegrationUrl ||
        !real.urlIntegrationToken,
      "REAL_URL_INTEGRATION_* not set"
    );

    const urlField =
      real.urlIntegrationProvider === "confluence"
        ? { base_url: real.urlIntegrationUrl, ...real.urlIntegrationExtra }
        : real.urlIntegrationProvider === "jenkins"
          ? { url: real.urlIntegrationUrl, ...real.urlIntegrationExtra }
          : { url: real.urlIntegrationUrl, ...real.urlIntegrationExtra };

    const integration = await connectIntegration(request, operator.token, agent.id, {
      provider: real.urlIntegrationProvider,
      token: real.urlIntegrationToken,
      config: urlField,
    });

    const result = await testIntegration(
      request,
      operator.token,
      agent.id,
      integration.id
    );
    expect(result?.success, JSON.stringify(result)).toBe(true);

    await deleteIntegration(request, operator.token, agent.id, integration.id);
  });

  test("[I4] SSRF guard — internal URL is refused", async ({ request }) => {
    test.skip(
      !real.urlIntegrationProvider || !real.urlIntegrationToken,
      "REAL_URL_INTEGRATION_* not set"
    );

    // Intentionally point the URL at an internal-network destination. The
    // fix in backend-api/integrations.ts#assertSafeUrl should reject this
    // at test time with a clear error message.
    const forbiddenUrl = "http://169.254.169.254/latest/meta-data/";
    const urlField =
      real.urlIntegrationProvider === "confluence"
        ? { base_url: forbiddenUrl }
        : { url: forbiddenUrl };

    const integration = await connectIntegration(request, operator.token, agent.id, {
      provider: real.urlIntegrationProvider,
      token: real.urlIntegrationToken,
      config: urlField,
    });

    const result = await testIntegration(
      request,
      operator.token,
      agent.id,
      integration.id
    );
    expect(result?.success).toBe(false);
    expect(String(result?.error || "")).toMatch(
      /internal|private network|not a valid url|must use http/i
    );

    await deleteIntegration(request, operator.token, agent.id, integration.id);
  });

  test("integrations list round-trips after cleanup", async ({ request }) => {
    const remaining = await listAgentIntegrations(request, operator.token, agent.id);
    // Every integration created above was explicitly deleted, so the list
    // should not contain any of the providers we exercised.
    const providers = remaining.map((i) => i.provider);
    for (const p of ["github", "slack", real.urlIntegrationProvider].filter(Boolean)) {
      expect(providers).not.toContain(p);
    }
  });
});
