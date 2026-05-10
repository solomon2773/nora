// @ts-nocheck
const { datadogProvider } = require("../../integrations/providers/datadog");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("datadogProvider", () => {
  it("calls /api/v1/validate with DD-API-KEY header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await datadogProvider.test({ row: {}, token: "tok", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.datadoghq.com/api/v1/validate",
      expect.objectContaining({ headers: { "DD-API-KEY": "tok" } }),
    );
  });

  it("emits DD_API_KEY + app_key + site", () => {
    const env = datadogProvider.mapToEnv({
      row: {},
      token: null,
      config: { app_key: "x", site: "datadoghq.eu" },
    });
    expect(env).toEqual({
      primary: "DD_API_KEY",
      config: { app_key: "DD_APP_KEY", site: "DD_SITE" },
    });
  });
});
