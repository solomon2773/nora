// @ts-nocheck
const { mixpanelProvider } = require("../../integrations/providers/mixpanel");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("mixpanelProvider", () => {
  it("uses Basic auth with SA username when configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await mixpanelProvider.test(
      {
        row: {},
        token: "sa-secret",
        config: { service_account_username: "sa.acme" },
      },
      deps(fetchImpl),
    );
    const expected = "Basic " + Buffer.from("sa.acme:sa-secret").toString("base64");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(expected);
  });

  it("falls back to project-token-only mode when SA username missing", async () => {
    const fetchImpl = jest.fn();
    const result = await mixpanelProvider.test(
      { row: {}, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("Project token stored");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits MIXPANEL_API_SECRET + service_account_username", () => {
    const env = mixpanelProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_username: "sa.acme", project_id: "1" },
    });
    expect(env.primary).toBe("MIXPANEL_API_SECRET");
    expect(env.config.service_account_username).toBe("MIXPANEL_SERVICE_ACCOUNT_USERNAME");
    expect(env.config.project_id).toBe("MIXPANEL_PROJECT_ID");
  });
});
