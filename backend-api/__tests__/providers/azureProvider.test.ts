// @ts-nocheck
const { azureProvider } = require("../../integrations/providers/azure");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

const tenantId = "11111111-2222-3333-4444-555555555555";
const clientId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("azureProvider", () => {
  it("accepts a valid Service Principal credential set", async () => {
    const result = await azureProvider.test(
      { row: {}, token: "secret", config: { tenant_id: tenantId, client_id: clientId } },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain(tenantId);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed UUIDs", async () => {
    const result = await azureProvider.test(
      {
        row: {},
        token: "secret",
        config: { tenant_id: "not-a-uuid", client_id: clientId },
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("UUID");
  });

  it("rejects missing client secret", async () => {
    const result = await azureProvider.test(
      { row: {}, token: "", config: { tenant_id: tenantId, client_id: clientId } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("client secret");
  });

  it("emits AZURE_* env vars", () => {
    const env = azureProvider.mapToEnv({
      row: {},
      token: null,
      config: { tenant_id: tenantId, client_id: clientId },
    });
    expect(env).toEqual({
      primary: "AZURE_CLIENT_SECRET",
      config: { tenant_id: "AZURE_TENANT_ID", client_id: "AZURE_CLIENT_ID" },
    });
  });
});
