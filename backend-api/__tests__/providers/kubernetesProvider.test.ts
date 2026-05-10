// @ts-nocheck
const { kubernetesProvider } = require("../../integrations/providers/kubernetes");

function deps() {
  return {
    fetch: jest.fn(),
    assertSafeUrl: async (u) => u,
    encrypt: (s) => s,
    decrypt: (s) => s,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("kubernetesProvider", () => {
  it("identifies as kubernetes / credentials", () => {
    expect(kubernetesProvider.id).toBe("kubernetes");
    expect(kubernetesProvider.authType).toBe("credentials");
  });

  it("accepts well-formed YAML kubeconfigs without calling the API server", async () => {
    const yamlConfig = `
apiVersion: v1
kind: Config
clusters:
  - name: my-cluster
    cluster:
      server: https://api.example.com
`;
    const d = deps();
    const result = await kubernetesProvider.test(
      { row: {}, token: null, config: { kubeconfig: yamlConfig } },
      d,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("connectivity not verified");
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("accepts JSON kubeconfigs", async () => {
    const json = JSON.stringify({ apiVersion: "v1", clusters: [{ name: "c" }] });
    const result = await kubernetesProvider.test(
      { row: {}, token: null, config: { kubeconfig: json } },
      deps(),
    );
    expect(result.success).toBe(true);
  });

  it("rejects empty or malformed kubeconfigs", async () => {
    let result = await kubernetesProvider.test(
      { row: {}, token: null, config: { kubeconfig: "" } },
      deps(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Kubeconfig is required");

    result = await kubernetesProvider.test(
      { row: {}, token: null, config: { kubeconfig: "not yaml or json" } },
      deps(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not valid YAML/JSON");
  });

  it("emits KUBECONFIG_CONTENTS / KUBECONFIG_CONTEXT (no primary token)", () => {
    const env = kubernetesProvider.mapToEnv({
      row: {},
      token: null,
      config: { kubeconfig: "yaml here", context: "prod" },
    });
    expect(env).toEqual({
      primary: null,
      config: { kubeconfig: "KUBECONFIG_CONTENTS", context: "KUBECONFIG_CONTEXT" },
    });
  });
});
