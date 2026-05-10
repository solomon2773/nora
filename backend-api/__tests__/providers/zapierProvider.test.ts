// @ts-nocheck
const { zapierProvider } = require("../../integrations/providers/zapier");
const { makeProvider } = require("../../integrations/providers/make");
const { n8nProvider } = require("../../integrations/providers/n8n");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe.each([
  ["zapier", zapierProvider, "ZAPIER_WEBHOOK_URL"],
  ["make", makeProvider, "MAKE_WEBHOOK_URL"],
  ["n8n", n8nProvider, "N8N_WEBHOOK_URL"],
])("%s webhook provider", (id, provider, envKey) => {
  it("identifies as " + id + " / webhook", () => {
    expect(provider.id).toBe(id);
    expect(provider.authType).toBe("webhook");
  });

  it("accepts a https webhook URL", async () => {
    const result = await provider.test(
      {
        row: {},
        token: null,
        config: { webhook_url: `https://hooks.example.com/${id}/123` },
      },
      deps,
    );
    expect(result.success).toBe(true);
  });

  it("rejects empty URL", async () => {
    const result = await provider.test({ row: {}, token: null, config: {} }, deps);
    expect(result.success).toBe(false);
  });

  it("emits the webhook env var via configEnv", () => {
    const env = provider.mapToEnv({
      row: {},
      token: null,
      config: { webhook_url: "https://x.com/y" },
    });
    expect(env.config.webhook_url).toBe(envKey);
  });
});
