// @ts-nocheck
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
const { providerRegistry } = require("../integrations/services/integrationsService");
const {
  activateWecomForOpenClawAgent,
  buildWecomOpenClawChannelConfig,
  verifyWecomForOpenClawAgent,
} = require("../integrations/providers/wecomActivation");
const nativeFetch = global.fetch;

describe("integration secret handling", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockEncrypt.mockClear();
    mockDecrypt.mockClear();
    mockEnsureEncryptionConfigured.mockClear();
  });

  afterEach(() => {
    global.fetch = nativeFetch;
  });

  it("identifies which integration providers require auth-profile refresh", () => {
    expect(integrations.integrationProviderAffectsLlmAuth("openai")).toBe(true);
    expect(integrations.integrationProviderAffectsLlmAuth("anthropic")).toBe(true);
    expect(integrations.integrationProviderAffectsLlmAuth("huggingface")).toBe(true);
    expect(integrations.integrationProviderAffectsLlmAuth("github")).toBe(false);
    expect(integrations.integrationProviderAffectsLlmAuth("slack")).toBe(false);
  });

  it("fails closed when a catalog provider has no registered strategy", async () => {
    const provider = providerRegistry.resolve("stale-provider");

    await expect(
      provider.test(
        {
          row: { provider: "stale-provider" },
          token: "stored-token",
          config: {},
        },
        { fetch: jest.fn() },
      ),
    ).resolves.toEqual({
      success: false,
      error: 'No integration strategy is registered for provider "stale-provider"',
    });
    expect(() =>
      provider.mapToEnv({
        row: { provider: "stale-provider" },
        token: "stored-token",
        config: {},
      }),
    ).toThrow('No integration strategy is registered for provider "stale-provider"');
  });

  it("re-exports the email config normalizer through the legacy integrations shim", () => {
    expect(typeof integrations.normalizeEmailConfigInput).toBe("function");
    expect(
      integrations.normalizeEmailConfigInput({
        providerPreset: "gmail",
        "auth.username": "ops@example.com",
        "cron.enabled": true,
        "cron.intervalMinutes": 15,
      }),
    ).toMatchObject({
      providerPreset: "gmail",
      auth: { username: "ops@example.com" },
      cron: { enabled: true, intervalMinutes: 15 },
    });
  });

  it("re-exports the WeCom config normalizer through the legacy integrations shim", () => {
    expect(typeof integrations.normalizeWecomConfigInput).toBe("function");
    expect(
      integrations.normalizeWecomConfigInput({
        mode: "both",
        "defaultAccount.bot.botId": "wx_bot_main",
        "defaultAccount.agent.agentId": 1000002,
        accountsJson: '[{"label":"Sales","bot":{"botId":"wx_bot_sales"}}]',
      }),
    ).toMatchObject({
      mode: "both",
      defaultAccount: {
        bot: { botId: "wx_bot_main" },
        agent: { agentId: 1000002 },
      },
      accounts: [
        expect.objectContaining({
          label: "Sales",
          bot: expect.objectContaining({ botId: "wx_bot_sales" }),
        }),
      ],
      activation: {
        lifecycleStatus: "saved",
        readiness: "pending_activation",
      },
    });
  });

  it("rejects malformed WeCom accountsJson", () => {
    expect(() =>
      integrations.normalizeWecomConfigInput({
        mode: "bot",
        "defaultAccount.bot.botId": "wx_bot_main",
        accountsJson: '[{"label":"Sales",}]',
      }),
    ).toThrow("Additional Accounts JSON must be valid JSON.");
  });

  it("rejects wrong-shape WeCom accountsJson", () => {
    expect(() =>
      integrations.normalizeWecomConfigInput({
        mode: "bot",
        "defaultAccount.bot.botId": "wx_bot_main",
        accountsJson: '{"id":"sales"}',
      }),
    ).toThrow("Additional Accounts JSON must be a JSON array.");
  });

  it("rejects malformed WeCom per-group sender allowlists JSON", () => {
    expect(() =>
      integrations.normalizeWecomConfigInput({
        mode: "bot",
        "defaultAccount.bot.botId": "wx_bot_main",
        "defaultAccount.bot.secret": "secret",
        "policies.groupsJson": '{"group-a":{"allowFrom":["user1",]}}',
      }),
    ).toThrow("Per-group sender allowlists must be valid JSON.");
  });

  it("maps the saved WeCom config into the official OpenClaw channels.wecom shape", () => {
    const mapped = buildWecomOpenClawChannelConfig(
      integrations.normalizeWecomConfigInput({
        mode: "both",
        "defaultAccount.id": "main",
        "defaultAccount.bot.botId": "wx-bot-main",
        "defaultAccount.bot.secret": "bot-secret",
        "defaultAccount.agent.corpId": "ww123",
        "defaultAccount.agent.corpSecret": "corp-secret",
        "defaultAccount.agent.agentId": 1000002,
        "defaultAccount.agent.token": "agent-token",
        "defaultAccount.agent.encodingAESKey": "aes-key",
        "policies.dmPolicy": "pairing",
        "policies.allowFrom": ["u1", "u2"],
        "policies.groupPolicy": "allowlist",
        "policies.groupAllowFrom": ["g1"],
        "policies.groupsJson":
          '{"g1":{"allowFrom":["owner1","owner2"]},"g2":{"allowFrom":["owner3"]}}',
        "advanced.mediaLocalRoots": "/tmp/media, /var/data",
        "advanced.egressProxyUrl": "http://proxy.internal:3128",
        "advanced.dynamicAgentEnabled": true,
        accountsJson:
          '[{"id":"support","bot":{"botId":"wx-bot-support","secret":"support-secret"},"agent":{"corpId":"ww123","corpSecret":"support-corp-secret","agentId":1000003,"token":"support-token","encodingAESKey":"support-aes"}}]',
      }),
    );

    expect(mapped).toEqual(
      expect.objectContaining({
        enabled: true,
        defaultAccount: "main",
        botId: "wx-bot-main",
        secret: "bot-secret",
        dmPolicy: "pairing",
        allowFrom: ["u1", "u2"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["g1"],
        groups: {
          g1: { allowFrom: ["owner1", "owner2"] },
          g2: { allowFrom: ["owner3"] },
        },
        mediaLocalRoots: ["/tmp/media", "/var/data"],
        network: {
          egressProxyUrl: "http://proxy.internal:3128",
        },
        dynamicAgents: {
          enabled: true,
        },
        accounts: {
          main: expect.objectContaining({
            botId: "wx-bot-main",
            secret: "bot-secret",
            agent: expect.objectContaining({
              corpId: "ww123",
              corpSecret: "corp-secret",
              agentId: 1000002,
              token: "agent-token",
              encodingAESKey: "aes-key",
            }),
          }),
          support: expect.objectContaining({
            botId: "wx-bot-support",
            secret: "support-secret",
            agent: expect.objectContaining({
              corpId: "ww123",
              corpSecret: "support-corp-secret",
              agentId: 1000003,
              token: "support-token",
              encodingAESKey: "support-aes",
            }),
          }),
        },
      }),
    );
  });

  it("writes only agent config into the runtime when Nora is saved in agent mode", () => {
    const mapped = buildWecomOpenClawChannelConfig(
      integrations.normalizeWecomConfigInput({
        mode: "agent",
        "defaultAccount.bot.botId": "wx-bot-main",
        "defaultAccount.bot.secret": "bot-secret",
        "defaultAccount.agent.corpId": "ww123",
        "defaultAccount.agent.corpSecret": "corp-secret",
        "defaultAccount.agent.agentId": 1000002,
        "defaultAccount.agent.token": "agent-token",
        "defaultAccount.agent.encodingAESKey": "aes-key",
      }),
    );

    expect(mapped).toEqual(
      expect.objectContaining({
        enabled: true,
        agent: expect.objectContaining({
          corpId: "ww123",
          corpSecret: "corp-secret",
          agentId: 1000002,
          token: "agent-token",
          encodingAESKey: "aes-key",
        }),
      }),
    );
    expect(mapped).not.toHaveProperty("botId");
    expect(mapped).not.toHaveProperty("secret");
    expect(mapped).not.toHaveProperty("connectionMode");
  });

  it("verifies a running OpenClaw agent with matching WeCom runtime config", async () => {
    const normalized = integrations.normalizeWecomConfigInput({
      mode: "both",
      "defaultAccount.bot.botId": "wx-bot-main",
      "defaultAccount.bot.secret": "bot-secret",
      "defaultAccount.agent.corpId": "ww123",
      "defaultAccount.agent.corpSecret": "corp-secret",
      "defaultAccount.agent.agentId": 1000002,
      "defaultAccount.agent.token": "agent-token",
      "defaultAccount.agent.encodingAESKey": "aes-key",
    });
    const expectedRuntimeConfig = buildWecomOpenClawChannelConfig(normalized);
    const runContainerCommand = jest
      .fn()
      .mockResolvedValueOnce({ output: "" })
      .mockResolvedValueOnce({ output: JSON.stringify(expectedRuntimeConfig) });
    const rpcCall = jest.fn().mockResolvedValue({ hash: "cfg-hash" });

    const result = await verifyWecomForOpenClawAgent(
      { id: "agent-1", status: "running" },
      normalized,
      { runContainerCommand, rpcCall },
    );

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/plugin is installed/i);
    expect(result.activation).toMatchObject({
      lifecycleStatus: "active",
      readiness: "ready",
    });
    expect(rpcCall).toHaveBeenCalledWith({ id: "agent-1", status: "running" }, "config.get");
    expect(runContainerCommand).toHaveBeenCalledTimes(2);
  });

  it("clears stale WeCom runtime config before writing the selected mode", async () => {
    const normalized = integrations.normalizeWecomConfigInput({
      mode: "agent",
      "defaultAccount.bot.botId": "wx-bot-main",
      "defaultAccount.bot.secret": "bot-secret",
      "defaultAccount.agent.corpId": "ww123",
      "defaultAccount.agent.corpSecret": "corp-secret",
      "defaultAccount.agent.agentId": 1000002,
      "defaultAccount.agent.token": "agent-token",
      "defaultAccount.agent.encodingAESKey": "aes-key",
    });

    const runContainerCommand = jest.fn().mockResolvedValue({ output: "" });
    const rpcCall = jest
      .fn()
      .mockResolvedValueOnce({ hash: "cfg-before" })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ hash: "cfg-after-clear" })
      .mockResolvedValueOnce({ ok: true });

    const result = await activateWecomForOpenClawAgent(
      { id: "agent-1", status: "running" },
      normalized,
      { runContainerCommand, rpcCall },
    );

    expect(result).toMatchObject({
      deferred: false,
      activation: {
        lifecycleStatus: "active",
        readiness: "ready",
      },
    });
    expect(rpcCall).toHaveBeenNthCalledWith(1, { id: "agent-1", status: "running" }, "config.get");
    expect(rpcCall).toHaveBeenNthCalledWith(
      2,
      { id: "agent-1", status: "running" },
      "config.patch",
      {
        raw: JSON.stringify({
          channels: { wecom: null },
          plugins: {
            entries: {
              "wecom-openclaw-plugin": {
                enabled: false,
              },
            },
          },
        }),
        baseHash: "cfg-before",
      },
    );
    expect(rpcCall).toHaveBeenNthCalledWith(3, { id: "agent-1", status: "running" }, "config.get");
    expect(rpcCall).toHaveBeenNthCalledWith(
      4,
      { id: "agent-1", status: "running" },
      "config.patch",
      {
        raw: JSON.stringify({
          channels: {
            wecom: {
              enabled: true,
              agent: {
                corpId: "ww123",
                corpSecret: "corp-secret",
                agentId: 1000002,
                token: "agent-token",
                encodingAESKey: "aes-key",
              },
              dmPolicy: "pairing",
              groupPolicy: "open",
            },
          },
          plugins: {
            entries: {
              "wecom-openclaw-plugin": {
                enabled: true,
              },
            },
          },
        }),
        baseHash: "cfg-after-clear",
      },
    );
    expect(runContainerCommand).toHaveBeenCalledTimes(3);
  });

  it("returns a pending activation result when the OpenClaw agent is not running", async () => {
    const result = await verifyWecomForOpenClawAgent(
      { id: "agent-1", status: "stopped" },
      integrations.normalizeWecomConfigInput({ mode: "bot" }),
      {
        runContainerCommand: jest.fn(),
        rpcCall: jest.fn(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      activation: {
        lifecycleStatus: "saved",
        readiness: "pending_activation",
      },
    });
    expect(result.message).toMatch(/start the agent/i);
  });

  it("reports an activation error when the runtime WeCom mode does not match the saved config", async () => {
    const normalized = integrations.normalizeWecomConfigInput({
      mode: "agent",
      "defaultAccount.agent.corpId": "ww123",
      "defaultAccount.agent.corpSecret": "corp-secret",
      "defaultAccount.agent.agentId": 1000002,
      "defaultAccount.agent.token": "agent-token",
      "defaultAccount.agent.encodingAESKey": "aes-key",
    });

    const result = await verifyWecomForOpenClawAgent(
      { id: "agent-1", status: "running" },
      normalized,
      {
        rpcCall: jest.fn().mockResolvedValue({ hash: "cfg-hash" }),
        runContainerCommand: jest
          .fn()
          .mockResolvedValueOnce({ output: "" })
          .mockResolvedValueOnce({
            output: JSON.stringify({
              enabled: true,
              botId: "wx-bot-main",
              secret: "bot-secret",
            }),
          }),
      },
    );

    expect(result.success).toBe(false);
    expect(result.activation).toMatchObject({
      lifecycleStatus: "activation_failed",
      readiness: "error",
    });
    expect(result.message).toMatch(/saved agent mode/i);
  });

  it("reports an activation error when the runtime WeCom config differs from Nora's saved config", async () => {
    const normalized = integrations.normalizeWecomConfigInput({
      mode: "bot",
      "defaultAccount.bot.botId": "wx-bot-main",
      "defaultAccount.bot.secret": "bot-secret",
    });

    const result = await verifyWecomForOpenClawAgent(
      { id: "agent-1", status: "running" },
      normalized,
      {
        rpcCall: jest.fn().mockResolvedValue({ hash: "cfg-hash" }),
        runContainerCommand: jest
          .fn()
          .mockResolvedValueOnce({ output: "" })
          .mockResolvedValueOnce({
            output: JSON.stringify({
              enabled: true,
              botId: "wx-bot-main",
              secret: "different-secret",
              connectionMode: "websocket",
              websocketUrl: "wss://openws.work.weixin.qq.com",
              sendThinkingMessage: true,
              dmPolicy: "pairing",
              groupPolicy: "open",
            }),
          }),
      },
    );

    expect(result.success).toBe(false);
    expect(result.activation).toMatchObject({
      lifecycleStatus: "activation_failed",
      readiness: "error",
    });
    expect(result.message).toMatch(/does not fully match/i);
  });

  it("redacts sensitive config and does not return access_token after create", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "int-1",
          agent_id: "agent-1",
          provider: "github",
          catalog_id: "github",
          access_token: "enc(secret-token)",
          config: '{"api_key":"enc(config-secret)","base_url":"https://api.github.com"}',
          status: "active",
        },
      ],
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

  it("normalizes and redacts WeCom config on create", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          id: "int-wecom",
          agent_id: "agent-1",
          provider: "wecom",
          catalog_id: "wecom",
          access_token: null,
          config: JSON.stringify({
            mode: "both",
            defaultAccount: {
              label: "Main WeCom",
              bot: {
                botId: "wx_bot_main",
                secret: "enc(bot-secret)",
                websocketUrl: "wss://openws.work.weixin.qq.com",
              },
              agent: {
                corpId: "ww123",
                corpSecret: "enc(corp-secret)",
                agentId: 1000002,
                token: "enc(agent-token)",
                encodingAESKey: "enc(aes-key)",
                callbackPath: "/plugins/wecom/agent/default",
              },
            },
            accounts: [
              {
                id: "sales",
                label: "Sales",
                bot: { botId: "wx_bot_sales", secret: "enc(sales-secret)" },
                agent: { agentId: 1000003 },
              },
            ],
            activation: {
              lifecycleStatus: "saved",
              readiness: "pending_activation",
            },
          }),
          status: "active",
        },
      ],
    });

    const result = await integrations.connectIntegration("agent-1", "wecom", null, {
      mode: "both",
      "defaultAccount.label": "Main WeCom",
      "defaultAccount.bot.botId": "wx_bot_main",
      "defaultAccount.bot.secret": "bot-secret",
      "defaultAccount.agent.corpId": "ww123",
      "defaultAccount.agent.corpSecret": "corp-secret",
      "defaultAccount.agent.agentId": 1000002,
      "defaultAccount.agent.token": "agent-token",
      "defaultAccount.agent.encodingAESKey": "aes-key",
      accountsJson:
        '[{"id":"sales","label":"Sales","bot":{"botId":"wx_bot_sales","secret":"sales-secret"}}]',
    });

    expect(mockEnsureEncryptionConfigured).toHaveBeenCalledWith("Integration credential storage");
    expect(mockEncrypt).toHaveBeenCalledWith("bot-secret");
    expect(mockEncrypt).toHaveBeenCalledWith("corp-secret");
    expect(mockEncrypt).toHaveBeenCalledWith("agent-token");
    expect(mockEncrypt).toHaveBeenCalledWith("aes-key");
    expect(result).toMatchObject({
      id: "int-wecom",
      provider: "wecom",
      config: {
        mode: "both",
        defaultAccount: {
          label: "Main WeCom",
          bot: expect.objectContaining({
            botId: "wx_bot_main",
            secret: "[REDACTED]",
          }),
          agent: expect.objectContaining({
            corpId: "ww123",
            corpSecret: "[REDACTED]",
            token: "[REDACTED]",
            encodingAESKey: "[REDACTED]",
          }),
        },
        accounts: [
          expect.objectContaining({
            label: "Sales",
            bot: expect.objectContaining({
              botId: "wx_bot_sales",
              secret: "[REDACTED]",
            }),
          }),
        ],
      },
    });
  });

  it("replaces an existing provider integration after creating a new one", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "int-twitter",
            agent_id: "agent-1",
            provider: "twitter",
            catalog_id: "twitter",
            access_token: "enc(x-access-token)",
            config: JSON.stringify({ access_token: "enc(x-access-token)", username: "openai" }),
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await integrations.replaceIntegration("agent-1", "twitter", "x-access-token", {
      access_token: "x-access-token",
      username: "openai",
    });

    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM integrations WHERE agent_id = $1 AND provider = $2 AND id <> $3",
      ["agent-1", "twitter", "int-twitter"],
    );
    expect(result).toMatchObject({
      id: "int-twitter",
      provider: "twitter",
      config: {
        access_token: "[REDACTED]",
        username: "openai",
      },
    });
  });

  it("updates an integration while preserving existing secret material when password fields are omitted", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "int-email",
            agent_id: "agent-1",
            provider: "email",
            catalog_id: "email",
            access_token: "enc(existing-password)",
            config: JSON.stringify({
              providerPreset: "gmail",
              auth: {
                mode: "basic",
                username: "ops@example.com",
                password: "enc(existing-password)",
              },
              cron: { enabled: false, intervalMinutes: 60 },
            }),
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "int-email",
            agent_id: "agent-1",
            provider: "email",
            catalog_id: "email",
            access_token: "enc(dec(enc(existing-password)))",
            config: JSON.stringify({
              providerPreset: "gmail",
              auth: {
                mode: "basic",
                username: "alerts@example.com",
                password: "enc(dec(enc(existing-password)))",
              },
              cron: { enabled: true, intervalMinutes: 120 },
            }),
            status: "active",
          },
        ],
      });

    const result = await integrations.updateIntegration("int-email", "agent-1", null, {
      "auth.username": "alerts@example.com",
      "cron.enabled": true,
      "cron.intervalMinutes": 120,
    });

    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE integrations"),
      expect.arrayContaining([
        "enc(dec(enc(existing-password)))",
        expect.any(String),
        "int-email",
        "agent-1",
      ]),
    );
    expect(result).toMatchObject({
      id: "int-email",
      config: expect.objectContaining({
        auth: expect.objectContaining({
          username: "alerts@example.com",
          password: "[REDACTED]",
        }),
        cron: expect.objectContaining({
          enabled: false,
          intervalMinutes: 120,
        }),
      }),
    });
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
      credentialEnv: {
        primary: "GITHUB_TOKEN",
        config: {
          org: "GITHUB_ORG",
        },
      },
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

  it("keeps Twitter/X OAuth app secrets out of runtime sync payloads", () => {
    const entry = integrations.buildIntegrationSyncEntry({
      id: "int-twitter",
      provider: "twitter",
      catalog_id: "twitter",
      catalog_name: "Twitter / X",
      catalog_category: "social",
      config_schema: JSON.stringify({
        authType: "oauth2",
        toolSpecs: [],
      }),
      config: JSON.stringify({
        access_token: "enc(x-access)",
        refresh_token: "enc(x-refresh)",
        client_id: "x-client-id",
        client_secret: "enc(x-client-secret)",
        default_username: "solomon2773",
      }),
      status: "active",
    });

    expect(entry.config).toEqual({
      access_token: "dec(enc(x-access))",
      default_username: "solomon2773",
    });
    expect(entry.config).not.toHaveProperty("refresh_token");
    expect(entry.config).not.toHaveProperty("client_secret");
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
      { reservedNames: new Set(["health_check"]) },
    );

    expect(tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          name: "nora_github_integration",
        }),
        nora: expect.objectContaining({
          source: "integration-manifest",
          executable: true,
          executionState: "runtime_skill",
          provider: "github",
          integrationId: "int-gh",
          runtimeToolName: "nora_github_integration",
        }),
      }),
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
    expect(tools[0].nora.invokeCommand).toContain("nora-integration-tool nora_github_integration");
    expect(tools[1].nora.invokeCommand).toContain("nora-integration-tool github_list_repositories");
  });

  it("maps Agent Hub template credentials from integrations into runtime env", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          provider: "telegram",
          access_token: "enc(telegram-token)",
          config: JSON.stringify({ operator_user_id: "12345" }),
        },
        {
          provider: "instagram",
          access_token: "enc(instagram-token)",
          config: JSON.stringify({
            business_account_id: "17890000000000000",
            page_id: "page-1",
          }),
        },
        {
          provider: "twitter",
          access_token: "enc(twitter-token)",
          config: JSON.stringify({
            default_username: "openai",
          }),
        },
      ],
    });

    const envVars = await integrations.getIntegrationEnvVars("agent-1");

    expect(envVars).toEqual({
      TELEGRAM_BOT_TOKEN: "dec(enc(telegram-token))",
      OPERATOR_TELEGRAM_ID: "12345",
      INSTAGRAM_ACCESS_TOKEN: "dec(enc(instagram-token))",
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "17890000000000000",
      INSTAGRAM_PAGE_ID: "page-1",
      TWITTER_ACCESS_TOKEN: "dec(enc(twitter-token))",
      TWITTER_DEFAULT_USERNAME: "openai",
    });
  });

  it("exposes Agent Hub communication credentials through the integration catalog", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("catalog table unavailable"));

    const catalog = await integrations.getCatalog();

    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "telegram",
          configFields: expect.arrayContaining([
            expect.objectContaining({ key: "bot_token", type: "password" }),
            expect.objectContaining({ key: "operator_user_id", type: "text" }),
          ]),
        }),
        expect.objectContaining({
          id: "instagram",
          configFields: expect.arrayContaining([
            expect.objectContaining({ key: "access_token", type: "password" }),
            expect.objectContaining({ key: "business_account_id", type: "text" }),
          ]),
        }),
      ]),
    );
  });

  it("returns actionable Twitter/X auth errors from connectivity tests", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "int-twitter",
          agent_id: "agent-1",
          provider: "twitter",
          access_token: "enc(read-only-token)",
          config: JSON.stringify({}),
          status: "active",
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          title: "Forbidden",
          detail: "Your credentials do not allow access to this resource",
        }),
    });

    const result = await integrations.testIntegration("int-twitter", "agent-1");

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Twitter/X API returned 403"),
    });
    expect(result.error).toContain("Your credentials do not allow access to this resource");
    expect(result.error).toContain("OAuth 2.0 user access token");
    expect(result.error).toContain("tweet.write");
  });

  it("refreshes a near-expiry Twitter/X OAuth token before running the connectivity test", async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    mockDb.query
      // findIntegration → returns row with an expired access token
      .mockResolvedValueOnce({
        rows: [
          {
            id: "int-twitter",
            agent_id: "agent-1",
            provider: "twitter",
            access_token: "enc(stale-access-token)",
            config: JSON.stringify({
              refresh_token: "enc(stored-refresh)",
              client_id: "client-1",
              expires_at: expiredAt,
            }),
            status: "active",
          },
        ],
      })
      // updateAccessTokenAndConfig → no-op; refresh persists the new token
      .mockResolvedValueOnce({ rows: [] });

    global.fetch = jest
      .fn()
      // 1. OAuth token refresh
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          token_type: "bearer",
          scope: "tweet.read tweet.write users.read offline.access",
          expires_in: 7200,
        }),
        text: async () => "",
      })
      // 2. /users/me connectivity probe
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { username: "solomon" } }),
      });

    const result = await integrations.testIntegration("int-twitter", "agent-1");

    expect(result).toEqual({ success: true, message: "Connected as @solomon" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.x.com/2/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    // The connectivity probe must use the freshly minted access token
    // (round-tripped through the mock encrypt → decrypt pair), not the
    // stale one — otherwise the user sees a 401 even when refresh
    // succeeded.
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.x.com/2/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer dec(enc(fresh-access-token))",
        }),
      }),
    );
    expect(mockEncrypt).toHaveBeenCalledWith("fresh-access-token");
  });
});
