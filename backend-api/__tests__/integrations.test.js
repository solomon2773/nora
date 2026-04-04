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
});
