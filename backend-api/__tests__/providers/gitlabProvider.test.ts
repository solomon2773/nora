// @ts-nocheck
const { gitlabProvider } = require("../../integrations/providers/gitlab");

function makeDeps(fetchImpl, assertSafeUrlImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: assertSafeUrlImpl || (async (u) => u),
    encrypt: (s) => `enc(${s})`,
    decrypt: (s) => `dec(${s})`,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("gitlabProvider", () => {
  it("identifies as gitlab / api_key", () => {
    expect(gitlabProvider.id).toBe("gitlab");
    expect(gitlabProvider.authType).toBe("api_key");
  });

  it("hits gitlab.com by default and reports the username", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "alice" }),
    });
    const result = await gitlabProvider.test(
      { row: { provider: "gitlab" }, token: "glpat_x", config: {} },
      makeDeps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/user",
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "glpat_x" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as alice" });
  });

  it("uses a self-hosted base URL when configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "bob" }),
    });
    const assertSafeUrl = jest.fn(async (u) => u);
    await gitlabProvider.test(
      {
        row: { provider: "gitlab" },
        token: "t",
        config: { base_url: "https://gitlab.example.com" },
      },
      makeDeps(fetchImpl, assertSafeUrl),
    );
    expect(assertSafeUrl).toHaveBeenCalledWith("https://gitlab.example.com", "GitLab base URL");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gitlab.example.com/api/v4/user");
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await gitlabProvider.test(
      { row: { provider: "gitlab" }, token: "bad", config: {} },
      makeDeps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("GitLab API returned 401");
  });

  it("emits GITLAB_TOKEN and GITLAB_BASE_URL when configured", () => {
    const env = gitlabProvider.mapToEnv({
      row: { provider: "gitlab" },
      token: null,
      config: { base_url: "https://gitlab.example.com" },
    });
    expect(env).toEqual({
      primary: "GITLAB_TOKEN",
      config: { base_url: "GITLAB_BASE_URL" },
    });
  });
});
