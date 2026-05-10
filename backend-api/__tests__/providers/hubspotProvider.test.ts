// @ts-nocheck
const { hubspotProvider } = require("../../integrations/providers/hubspot");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("hubspotProvider", () => {
  it("hits /crm/v3/objects/contacts with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await hubspotProvider.test({ row: {}, token: "pat-na1-x", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer pat-na1-x" }),
      }),
    );
  });

  it("emits HUBSPOT_ACCESS_TOKEN", () => {
    expect(hubspotProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "HUBSPOT_ACCESS_TOKEN",
      config: {},
    });
  });
});
