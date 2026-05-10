// @ts-nocheck
const { asanaProvider } = require("../../integrations/providers/asana");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("asanaProvider", () => {
  it("hits /users/me with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { name: "Alice" } }),
    });
    const result = await asanaProvider.test(
      { row: {}, token: "1/abc", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.asana.com/api/1.0/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer 1/abc" }),
      }),
    );
    expect(result.message).toContain("Alice");
  });

  it("emits ASANA_TOKEN + ASANA_WORKSPACE_ID", () => {
    const env = asanaProvider.mapToEnv({ row: {}, token: null, config: { workspace_id: "ws1" } });
    expect(env).toEqual({
      primary: "ASANA_TOKEN",
      config: { workspace_id: "ASANA_WORKSPACE_ID" },
    });
  });
});
