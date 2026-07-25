// @ts-nocheck
const { n8nProvider } = require("../../integrations/providers/n8n");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (url) => url,
  encrypt: (value) => value,
  decrypt: (value) => value,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("n8nProvider", () => {
  beforeEach(() => {
    deps.fetch.mockClear();
  });

  it("identifies as n8n / webhook", () => {
    expect(n8nProvider.id).toBe("n8n");
    expect(n8nProvider.authType).toBe("webhook");
  });

  it.each(["https://automation.example.com/webhook/nora", "http://n8n.internal:5678/webhook/nora"])(
    "accepts supported self-hosted webhook URL %s without invoking it",
    async (webhookUrl) => {
      const result = await n8nProvider.test(
        { row: {}, token: "optional-api-key", config: { webhook_url: webhookUrl } },
        deps,
      );
      expect(result).toEqual({
        success: true,
        message: "Webhook URL stored — n8n webhooks have no validation endpoint",
      });
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{}, "not configured"],
    [{ webhook_url: "not-a-url" }, "not a valid URL"],
    [{ webhook_url: "ftp://automation.example.com/hook" }, "must use http:// or https://"],
  ])("rejects invalid webhook configuration %#", async (config, error) => {
    const result = await n8nProvider.test({ row: {}, token: null, config }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain(error);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("maps the optional API key and webhook URL to runtime env vars", () => {
    expect(
      n8nProvider.mapToEnv({
        row: {},
        token: null,
        config: { webhook_url: "https://automation.example.com/webhook/nora" },
      }),
    ).toEqual({
      primary: "N8N_API_KEY",
      config: { webhook_url: "N8N_WEBHOOK_URL" },
    });
    expect(n8nProvider.mapToEnv({ row: {}, token: null, config: {} }).config).toEqual({});
  });
});
