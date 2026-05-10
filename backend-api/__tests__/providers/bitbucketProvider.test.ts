// @ts-nocheck
const { bitbucketProvider } = require("../../integrations/providers/bitbucket");

function makeDeps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (u) => u,
    encrypt: (s) => `enc(${s})`,
    decrypt: (s) => `dec(${s})`,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("bitbucketProvider", () => {
  it("identifies as bitbucket / basic", () => {
    expect(bitbucketProvider.id).toBe("bitbucket");
    expect(bitbucketProvider.authType).toBe("basic");
  });

  it("sends a Basic auth header built from username + app password", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "alice", display_name: "Alice" }),
    });
    const expected = "Basic " + Buffer.from("alice:apppass").toString("base64");
    const result = await bitbucketProvider.test(
      {
        row: { provider: "bitbucket" },
        token: "apppass",
        config: { username: "alice" },
      },
      makeDeps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expected }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as alice" });
  });

  it("falls back to display_name when username is absent in response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ display_name: "Alice Wonderland" }),
    });
    const result = await bitbucketProvider.test(
      { row: { provider: "bitbucket" }, token: "p", config: { username: "alice" } },
      makeDeps(fetchImpl),
    );
    expect(result.message).toBe("Connected as Alice Wonderland");
  });

  it("returns success=false when username is not configured", async () => {
    const fetchImpl = jest.fn();
    const result = await bitbucketProvider.test(
      { row: { provider: "bitbucket" }, token: "p", config: {} },
      makeDeps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Bitbucket username not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await bitbucketProvider.test(
      { row: { provider: "bitbucket" }, token: "bad", config: { username: "alice" } },
      makeDeps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Bitbucket API returned 401");
  });

  it("maps username, app password, and workspace to env vars", () => {
    const env = bitbucketProvider.mapToEnv({
      row: { provider: "bitbucket" },
      token: null,
      config: { username: "alice", workspace: "acme-eng" },
    });
    expect(env).toEqual({
      primary: "BITBUCKET_APP_PASSWORD",
      config: { username: "BITBUCKET_USERNAME", workspace: "BITBUCKET_WORKSPACE" },
    });
  });
});
