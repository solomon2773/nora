// @ts-nocheck
const { pipedriveProvider } = require("../../integrations/providers/pipedrive");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("pipedriveProvider", () => {
  it("passes the token as a query-string param", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { name: "Alice" } }),
    });
    await pipedriveProvider.test({ row: {}, token: "tok", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith("https://api.pipedrive.com/v1/users/me?api_token=tok");
  });

  it("emits PIPEDRIVE_API_KEY + company_domain", () => {
    const env = pipedriveProvider.mapToEnv({
      row: {},
      token: null,
      config: { company_domain: "acme" },
    });
    expect(env).toEqual({
      primary: "PIPEDRIVE_API_KEY",
      config: { company_domain: "PIPEDRIVE_COMPANY_DOMAIN" },
    });
  });
});
