// @ts-nocheck
const { createProviderRegistry } = require("../integrations/providers/base/registry");

// A fail-closed fallback mirroring the integrations service behavior for a
// stale catalog id whose provider strategy is not present in this deployment.
function makeFailClosedFallback(providerId) {
  const unsupportedMessage = `No integration strategy is registered for provider "${providerId}"`;
  return {
    id: providerId,
    authType: "custom",
    async test() {
      return {
        success: false,
        error: unsupportedMessage,
      };
    },
    mapToEnv() {
      throw new Error(unsupportedMessage);
    },
  };
}

describe("createProviderRegistry", () => {
  it("fails closed for unregistered ids", async () => {
    const registry = createProviderRegistry(makeFailClosedFallback);

    const provider = registry.resolve("unknown-id");
    expect(provider.id).toBe("unknown-id");
    expect(provider.authType).toBe("custom");

    expect(() =>
      provider.mapToEnv({
        row: { provider: "unknown-id" },
        token: null,
        config: { whatever: "x" },
      }),
    ).toThrow('No integration strategy is registered for provider "unknown-id"');

    const result = await provider.test(
      { row: { provider: "unknown-id" }, token: "x", config: {} },
      { fetch: jest.fn(), assertSafeUrl: async (u) => u },
    );
    expect(result).toEqual({
      success: false,
      error: 'No integration strategy is registered for provider "unknown-id"',
    });
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
    const registry = createProviderRegistry(makeFailClosedFallback);

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
    const registry = createProviderRegistry(makeFailClosedFallback);
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
