// @ts-nocheck
const { jenkinsProvider } = require("../../integrations/providers/jenkins");

function deps(fetchImpl, assertSafeUrlImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: assertSafeUrlImpl || (async (u) => u),
    encrypt: (s) => s,
    decrypt: (s) => s,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("jenkinsProvider", () => {
  it("identifies as jenkins / credentials", () => {
    expect(jenkinsProvider.id).toBe("jenkins");
    expect(jenkinsProvider.authType).toBe("credentials");
  });

  it("uses HTTP Basic and validates the URL through assertSafeUrl", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const assertSafeUrl = jest.fn(async (u) => u);
    const result = await jenkinsProvider.test(
      {
        row: { provider: "jenkins" },
        token: "tok",
        config: { url: "https://jenkins.example.com", username: "alice" },
      },
      deps(fetchImpl, assertSafeUrl),
    );
    expect(assertSafeUrl).toHaveBeenCalledWith("https://jenkins.example.com", "Jenkins URL");
    const expectedAuth = "Basic " + Buffer.from("alice:tok").toString("base64");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://jenkins.example.com/api/json",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expectedAuth }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("returns success=false when URL or username missing", async () => {
    const fetchImpl = jest.fn();
    let result = await jenkinsProvider.test(
      { row: {}, token: "t", config: { username: "alice" } },
      deps(fetchImpl),
    );
    expect(result.error).toContain("Jenkins URL not configured");

    result = await jenkinsProvider.test(
      { row: {}, token: "t", config: { url: "https://j.example.com" } },
      deps(fetchImpl),
    );
    expect(result.error).toContain("Jenkins username not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits the JENKINS_* env vars from config", () => {
    const env = jenkinsProvider.mapToEnv({
      row: {},
      token: null,
      config: { url: "https://j.example.com", username: "alice" },
    });
    expect(env).toEqual({
      primary: "JENKINS_TOKEN",
      config: { url: "JENKINS_URL", username: "JENKINS_USERNAME" },
    });
  });
});
