// @ts-nocheck
const { createProviderRegistry } = require("../integrations/providers/base/registry");
const { createLegacyProviderAdapter } = require("../integrations/providers/legacy");

describe("createProviderRegistry", () => {
  it("falls back to the legacy adapter for unregistered providers", () => {
    const legacyFactory = (id) =>
      createLegacyProviderAdapter(id, {
        envMap: { github: "GITHUB_TOKEN" },
        configEnvMap: { "github.org": "GITHUB_ORG" },
      });
    const registry = createProviderRegistry(legacyFactory);

    const provider = registry.resolve("github");
    expect(provider.id).toBe("github");
    expect(provider.authType).toBe("custom");

    const env = provider.mapToEnv({
      row: { provider: "github" },
      token: null,
      config: { org: "openai", other: "x" },
    });
    expect(env.primary).toBe("GITHUB_TOKEN");
    expect(env.config).toEqual({ org: "GITHUB_ORG" });
  });

  it("registered providers override the legacy adapter", () => {
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
    const legacyFactory = (id) =>
      createLegacyProviderAdapter(id, {
        envMap: { github: "GITHUB_TOKEN" },
        configEnvMap: {},
      });
    const registry = createProviderRegistry(legacyFactory);

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

  it("returns a fallback connectivity message when the provider has no test", async () => {
    const legacyFactory = (id) => createLegacyProviderAdapter(id, { envMap: {}, configEnvMap: {} });
    const registry = createProviderRegistry(legacyFactory);

    const provider = registry.resolve("unknown-provider");
    const result = await provider.test(
      { row: { provider: "unknown-provider" }, token: "t", config: {} },
      { fetch, assertSafeUrl: async (u) => u },
    );
    expect(result).toEqual({
      success: true,
      message: "Credentials stored (connectivity not verified for this provider)",
    });
  });

  it("returns the no-tester fallback for unknown providers (legacy connectivity table is now empty)", async () => {
    // After PR 8 every catalog provider has a strategy and the legacy
    // connectivityTests object is effectively empty. Unknown ids resolve
    // through LegacyProviderAdapter and report the "credentials stored
    // (not verified)" shape.
    const legacyFactory = (id) => createLegacyProviderAdapter(id, { envMap: {}, configEnvMap: {} });
    const registry = createProviderRegistry(legacyFactory);

    const provider = registry.resolve("not-a-real-provider");
    const result = await provider.test(
      { row: { provider: "not-a-real-provider" }, token: "x", config: {} },
      { fetch: jest.fn(), assertSafeUrl: async (u) => u },
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("connectivity not verified");
  });

  it("lists registered providers", () => {
    const legacyFactory = (id) => createLegacyProviderAdapter(id, { envMap: {}, configEnvMap: {} });
    const registry = createProviderRegistry(legacyFactory);
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
