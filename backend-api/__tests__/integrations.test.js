const mockDb = { query: jest.fn() };
const mockEncrypt = jest.fn((value) => `enc(${value})`);
const mockDecrypt = jest.fn((value) => `dec(${value})`);
const mockEnsureEncryptionConfigured = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  ensureEncryptionConfigured: mockEnsureEncryptionConfigured,
}));

const integrations = require("../integrations");

describe("integration secret handling", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockEncrypt.mockClear();
    mockDecrypt.mockClear();
    mockEnsureEncryptionConfigured.mockClear();
  });

  it("redacts sensitive config and does not return access_token after create", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "int-1",
        agent_id: "agent-1",
        provider: "github",
        catalog_id: "github",
        access_token: "enc(secret-token)",
        config: '{"api_key":"enc(config-secret)","base_url":"https://api.github.com"}',
        status: "active",
      }],
    });

    const result = await integrations.connectIntegration("agent-1", "github", "secret-token", {
      api_key: "config-secret",
      base_url: "https://api.github.com",
    });

    expect(mockEnsureEncryptionConfigured).toHaveBeenCalledWith("Integration credential storage");
    expect(mockEncrypt).toHaveBeenCalledWith("secret-token");
    expect(mockEncrypt).toHaveBeenCalledWith("config-secret");
    expect(result).toMatchObject({
      id: "int-1",
      agent_id: "agent-1",
      provider: "github",
      catalog_id: "github",
      status: "active",
      config: {
        api_key: "[REDACTED]",
        base_url: "https://api.github.com",
      },
    });
    expect(result).not.toHaveProperty("access_token");
  });

  it("builds sync entries with manifest metadata and redacted config", () => {
    const entry = integrations.buildIntegrationSyncEntry({
      id: "int-gh",
      provider: "github",
      catalog_id: "github",
      catalog_name: "GitHub",
      catalog_category: "developer-tools",
      auth_type: "api_key",
      config_schema: JSON.stringify({
        authType: "api_key",
        capabilities: ["read", "write", "webhook"],
        toolSpecs: [
          {
            name: "github_list_repositories",
            description: "List repositories.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        api: { type: "rest", baseUrl: "https://api.github.com" },
        mcp: { available: false },
        usageHints: ["Use for repo inspection."],
      }),
      config: JSON.stringify({
        personal_access_token: "enc(pat)",
        org: "openai",
      }),
      status: "active",
    });

    expect(entry).toMatchObject({
      id: "int-gh",
      provider: "github",
      name: "GitHub",
      category: "developer-tools",
      authType: "api_key",
      status: "active",
      capabilities: ["read", "write", "webhook"],
      api: { type: "rest", baseUrl: "https://api.github.com" },
      mcp: { available: false },
      usageHints: ["Use for repo inspection."],
      config: {
        personal_access_token: "dec(enc(pat))",
        org: "openai",
      },
      redactedConfig: {
        personal_access_token: "[REDACTED]",
        org: "openai",
      },
    });
    expect(entry.toolSpecs).toHaveLength(1);
  });

  it("converts integration tool specs into OpenClaw-compatible tool catalog entries", () => {
    const tools = integrations.buildIntegrationToolCatalogEntries(
      [
        {
          id: "int-gh",
          provider: "github",
          name: "GitHub",
          authType: "api_key",
          capabilities: ["read", "write"],
          redactedConfig: { org: "openai" },
          api: { type: "rest", baseUrl: "https://api.github.com" },
          mcp: { available: false },
          usageHints: ["Use for repo inspection."],
          toolSpecs: [
            {
              name: "github_list_repositories",
              description: "List repositories.",
              operation: "repos.list",
              inputSchema: { type: "object", properties: { owner: { type: "string" } } },
            },
          ],
        },
      ],
      { reservedNames: new Set(["health_check"]) }
    );

    expect(tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: {
          name: "github_list_repositories",
          description: "List repositories.",
          parameters: { type: "object", properties: { owner: { type: "string" } } },
        },
        nora: expect.objectContaining({
          source: "integration-manifest",
          executable: true,
          executionState: "runtime_skill",
          provider: "github",
          integrationId: "int-gh",
          runtimeToolName: "github_list_repositories",
        }),
      }),
    ]);
    expect(tools[0].nora.invokeCommand).toContain("nora-integration-tool github_list_repositories");
  });
});
