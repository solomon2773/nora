// @ts-nocheck
const { circleciProvider } = require("../../integrations/providers/circleci");

function deps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (u) => u,
    encrypt: (s) => s,
    decrypt: (s) => s,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("circleciProvider", () => {
  it("identifies as circleci / api_key", () => {
    expect(circleciProvider.id).toBe("circleci");
    expect(circleciProvider.authType).toBe("api_key");
  });

  it("hits /api/v2/me with the Circle-Token header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "Alice", login: "alice" }),
    });
    const result = await circleciProvider.test(
      { row: { provider: "circleci" }, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://circleci.com/api/v2/me",
      expect.objectContaining({ headers: expect.objectContaining({ "Circle-Token": "tok" }) }),
    );
    expect(result).toEqual({ success: true, message: "Connected as Alice" });
  });

  it("falls back to login when name is absent", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: "alice" }),
    });
    const result = await circleciProvider.test(
      { row: { provider: "circleci" }, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(result.message).toBe("Connected as alice");
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await circleciProvider.test(
      { row: { provider: "circleci" }, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("CircleCI API returned 401");
  });

  it("emits CIRCLE_TOKEN as primary", () => {
    expect(circleciProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "CIRCLE_TOKEN",
      config: {},
    });
  });
});
