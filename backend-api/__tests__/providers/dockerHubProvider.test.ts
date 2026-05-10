// @ts-nocheck
const { dockerHubProvider } = require("../../integrations/providers/dockerHub");

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

describe("dockerHubProvider", () => {
  it("identifies as docker-hub / credentials", () => {
    expect(dockerHubProvider.id).toBe("docker-hub");
    expect(dockerHubProvider.authType).toBe("credentials");
  });

  it("POSTs username + password to /v2/users/login", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await dockerHubProvider.test(
      { row: {}, token: "tok", config: { username: "alice" } },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hub.docker.com/v2/users/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "alice", password: "tok" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as alice" });
  });

  it("returns success=false when username is missing", async () => {
    const fetchImpl = jest.fn();
    const result = await dockerHubProvider.test(
      { row: {}, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Docker Hub username not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits DOCKER_HUB_TOKEN + DOCKER_HUB_USERNAME", () => {
    const env = dockerHubProvider.mapToEnv({
      row: {},
      token: null,
      config: { username: "alice" },
    });
    expect(env).toEqual({
      primary: "DOCKER_HUB_TOKEN",
      config: { username: "DOCKER_HUB_USERNAME" },
    });
  });
});
