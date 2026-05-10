// @ts-nocheck
const { grafanaProvider } = require("../../integrations/providers/grafana");

const deps = (fetchImpl, assertSafeUrlImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: assertSafeUrlImpl || (async (u) => u),
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("grafanaProvider", () => {
  it("hits /api/org with Bearer at customer's URL", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "Acme" }),
    });
    const assertSafeUrl = jest.fn(async (u) => u);
    const result = await grafanaProvider.test(
      { row: {}, token: "tok", config: { url: "https://grafana.example.com" } },
      deps(fetchImpl, assertSafeUrl),
    );
    expect(assertSafeUrl).toHaveBeenCalledWith("https://grafana.example.com", "Grafana URL");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://grafana.example.com/api/org");
    expect(result.message).toContain("Acme");
  });

  it("rejects missing URL", async () => {
    const result = await grafanaProvider.test({ row: {}, token: "x", config: {} }, deps(jest.fn()));
    expect(result.success).toBe(false);
  });

  it("emits GRAFANA_TOKEN + GRAFANA_URL", () => {
    const env = grafanaProvider.mapToEnv({
      row: {},
      token: null,
      config: { url: "https://g.example.com" },
    });
    expect(env).toEqual({
      primary: "GRAFANA_TOKEN",
      config: { url: "GRAFANA_URL" },
    });
  });
});
