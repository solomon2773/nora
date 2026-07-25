// @ts-nocheck
const { linearProvider } = require("../../integrations/providers/linear");

function makeDeps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (url) => url,
    encrypt: (value) => value,
    decrypt: (value) => value,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("linearProvider", () => {
  it("identifies as linear / api_key", () => {
    expect(linearProvider.id).toBe("linear");
    expect(linearProvider.authType).toBe("api_key");
  });

  it("verifies the API key with the GraphQL viewer query", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { viewer: { id: "user-1", name: "Alice" } } }),
    });

    const result = await linearProvider.test(
      { row: {}, token: "lin_api_key", config: {} },
      makeDeps(fetchImpl),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "lin_api_key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as Alice" });
  });

  it("rejects HTTP and GraphQL-level credential failures", async () => {
    const httpFailure = await linearProvider.test(
      { row: {}, token: "bad", config: {} },
      makeDeps(jest.fn().mockResolvedValue({ ok: false, status: 401 })),
    );
    expect(httpFailure).toEqual({ success: false, error: "Linear API returned 401" });

    const graphqlFailure = await linearProvider.test(
      { row: {}, token: "bad", config: {} },
      makeDeps(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ errors: [{ message: "Authentication required" }] }),
        }),
      ),
    );
    expect(graphqlFailure).toEqual({
      success: false,
      error: "Linear API rejected the credentials",
    });
  });

  it("converts network failures into a connectivity result", async () => {
    const result = await linearProvider.test(
      { row: {}, token: "lin_api_key", config: {} },
      makeDeps(jest.fn().mockRejectedValue(new Error("network unavailable"))),
    );
    expect(result).toEqual({ success: false, error: "network unavailable" });
  });

  it("maps the API key and optional default team to runtime env vars", () => {
    expect(
      linearProvider.mapToEnv({ row: {}, token: null, config: { team_id: "team-1" } }),
    ).toEqual({
      primary: "LINEAR_API_KEY",
      config: { team_id: "LINEAR_TEAM_ID" },
    });
    expect(linearProvider.mapToEnv({ row: {}, token: null, config: {} }).config).toEqual({});
  });
});
