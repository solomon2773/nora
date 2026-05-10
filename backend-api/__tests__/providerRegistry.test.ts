// @ts-nocheck
const { createProviderRegistry } = require("../integrations/providers/base/registry");

// A minimal stub fallback that mirrors what the integrations service
// installs when a catalog id has no strategy registered yet.
function makeStubFallback(providerId) {
  return {
    id: providerId,
    authType: "custom",
    async test() {
      return {
        success: true,
        message: "Credentials stored — no strategy registered for this provider yet",
      };
    },
    mapToEnv() {
      return { primary: null, config: {} };
    },
  };
}

describe("createProviderRegistry", () => {
  it("falls back to the stub provider for unregistered ids", async () => {
    const registry = createProviderRegistry(makeStubFallback);

    const provider = registry.resolve("unknown-id");
    expect(provider.id).toBe("unknown-id");
    expect(provider.authType).toBe("custom");

    const env = provider.mapToEnv({
      row: { provider: "unknown-id" },
      token: null,
      config: { whatever: "x" },
    });
    expect(env).toEqual({ primary: null, config: {} });

    const result = await provider.test(
      { row: { provider: "unknown-id" }, token: "x", config: {} },
      { fetch: jest.fn(), assertSafeUrl: async (u) => u },
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("no strategy registered");
  });

  it("registered providers override the fallback", () => {
    const stub = {
      id: "github",
      authType: "api_key",
      async test() {
        return { success: true, message: "stub" };
      },
      mapToEnv() {
        return { primary: "STUB_PRIMARY", config: { stubKey: "STUB_ENV" } };
      },
    };
    const registry = createProviderRegistry(makeStubFallback);

    expect(registry.has("github")).toBe(false);
    registry.register(stub);
    expect(registry.has("github")).toBe(true);

    const provider = registry.resolve("github");
    expect(provider).toBe(stub);

    const env = provider.mapToEnv({
      row: { provider: "github" },
      token: null,
      config: {},
    });
    expect(env.primary).toBe("STUB_PRIMARY");
  });

  it("lists registered providers", () => {
    const registry = createProviderRegistry(makeStubFallback);
    const a = {
      id: "a",
      authType: "api_key",
      test: async () => ({ success: true }),
      mapToEnv: () => ({ primary: null, config: {} }),
    };
    const b = {
      id: "b",
      authType: "api_key",
      test: async () => ({ success: true }),
      mapToEnv: () => ({ primary: null, config: {} }),
    };

    registry.register(a);
    registry.register(b);
    expect(registry.list()).toEqual([a, b]);
  });
});
