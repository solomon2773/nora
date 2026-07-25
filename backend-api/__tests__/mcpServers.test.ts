// @ts-nocheck
const mcpServers = require("../mcpServers");
const {
  buildMcpServerEnvAlias,
  buildMcpServersConfig,
} = require("../../agent-runtime/lib/mcpServersConfig");

const GITLAB_TOKEN_ALIAS = buildMcpServerEnvAlias("gitlab", "GITLAB_PERSONAL_ACCESS_TOKEN");
const GITLAB_URL_ALIAS = buildMcpServerEnvAlias("gitlab", "GITLAB_API_URL");
const NOTION_TOKEN_ALIAS = buildMcpServerEnvAlias("notion", "NOTION_TOKEN");
const STRIPE_TOKEN_ALIAS = buildMcpServerEnvAlias("stripe", "STRIPE_SECRET_KEY");
const SUPABASE_TOKEN_ALIAS = buildMcpServerEnvAlias("supabase", "SUPABASE_ACCESS_TOKEN");
const ALL_MANAGED_MCP_ALIASES = [
  GITLAB_TOKEN_ALIAS,
  GITLAB_URL_ALIAS,
  NOTION_TOKEN_ALIAS,
  STRIPE_TOKEN_ALIAS,
  SUPABASE_TOKEN_ALIAS,
].sort();

// A trimmed catalog covering supported + unsupported + not-yet-available cases.
const CATALOG = [
  {
    id: "gitlab",
    name: "GitLab",
    mcp: {
      available: true,
      transport: "stdio",
      npmPackage: "@modelcontextprotocol/server-gitlab",
      docsUrl: "https://example.com/gitlab",
    },
  },
  {
    id: "notion",
    name: "Notion",
    mcp: { available: true, transport: "stdio", npmPackage: "@notionhq/notion-mcp-server" },
  },
  {
    id: "stripe",
    name: "Stripe",
    mcp: { available: true, transport: "stdio", npmPackage: "@stripe/mcp" },
  },
  {
    id: "supabase",
    name: "Supabase",
    mcp: { available: true, transport: "stdio", npmPackage: "@supabase/mcp-server-supabase" },
  },
  // Supported provider id, but the catalog has not declared it available.
  { id: "github", name: "GitHub", mcp: { available: false } },
  // Available, but not in the supported set (deferred — file/connection creds).
  {
    id: "kubernetes",
    name: "Kubernetes",
    mcp: { available: true, transport: "stdio", npmPackage: "@kubernetes/mcp-server" },
  },
];

describe("loadMcpCatalog", () => {
  it("returns only supported providers that declare a usable stdio server", () => {
    const ids = mcpServers.loadMcpCatalog(CATALOG).map((e) => e.provider);
    expect(ids.sort()).toEqual(["gitlab", "notion", "stripe", "supabase"]);
  });
});

describe("normalizeEnabledIds", () => {
  it("keeps supported ids, dedupes, and accepts {provider} objects", () => {
    expect(
      mcpServers.normalizeEnabledIds([
        "gitlab",
        "gitlab",
        { provider: "stripe" },
        "nope",
        "kubernetes",
      ]),
    ).toEqual(["gitlab", "stripe"]);
    expect(mcpServers.normalizeEnabledIds("not-an-array")).toEqual([]);
  });

  it("derives the complete managed alias removal universe independent of enablement", () => {
    expect(mcpServers.getManagedMcpEnvNames(["gitlab", "notion", "gitlab"], CATALOG)).toEqual(
      ALL_MANAGED_MCP_ALIASES,
    );
  });
});

describe("resolveMcpEntries", () => {
  it("injects each provider's credential under its server's expected env var", () => {
    const entries = mcpServers.resolveMcpEntries({
      enabledIds: ["gitlab", "notion"],
      integrationsByProvider: {
        gitlab: { token: "glpat-1", config: { api_url: "https://gl.example.com/api/v4" } },
        notion: { token: "secret_n" },
      },
      catalog: CATALOG,
    });
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.gitlab.npmPackage).toBe("@modelcontextprotocol/server-gitlab");
    expect(byName.gitlab.env).toEqual({
      GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-1",
      GITLAB_API_URL: "https://gl.example.com/api/v4",
    });
    expect(byName.notion.env).toEqual({ NOTION_TOKEN: "secret_n" });
  });

  it("skips an enabled provider whose integration is missing or has no token", () => {
    const entries = mcpServers.resolveMcpEntries({
      enabledIds: ["gitlab", "stripe"],
      integrationsByProvider: { gitlab: { token: "" }, stripe: undefined },
      catalog: CATALOG,
    });
    expect(entries).toEqual([]);
  });
});

describe("getEnabledMcpRuntimeState", () => {
  it("returns current alias values plus the full removal universe", async () => {
    const dbClient = {
      query: jest.fn(async (sql) => {
        if (/SELECT mcp_servers FROM agents/.test(sql)) {
          return { rows: [{ mcp_servers: ["gitlab", "notion"] }] };
        }
        if (/FROM integrations/.test(sql)) {
          return {
            rows: [
              { id: "int-gitlab", provider: "gitlab" },
              { id: "int-disabled", provider: "stripe" },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const integrationsModule = {
      getDecryptedIntegration: jest.fn(async (integrationId) =>
        integrationId === "int-gitlab"
          ? {
              access_token: "glpat-runtime",
              config: { api_url: "https://gitlab.example/api/v4" },
            }
          : null,
      ),
    };

    await expect(
      mcpServers.getEnabledMcpRuntimeState("agent-1", {
        dbClient,
        integrationsModule,
        catalog: CATALOG,
      }),
    ).resolves.toEqual({
      enabledIds: ["gitlab", "notion"],
      entries: [
        {
          name: "gitlab",
          npmPackage: "@modelcontextprotocol/server-gitlab",
          env: {
            GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-runtime",
            GITLAB_API_URL: "https://gitlab.example/api/v4",
          },
        },
      ],
      desiredServers: buildMcpServersConfig([
        {
          name: "gitlab",
          npmPackage: "@modelcontextprotocol/server-gitlab",
          env: {
            GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-runtime",
            GITLAB_API_URL: "https://gitlab.example/api/v4",
          },
        },
      ]),
      env: {
        [GITLAB_TOKEN_ALIAS]: "glpat-runtime",
        [GITLAB_URL_ALIAS]: "https://gitlab.example/api/v4",
      },
      managedEnvNames: ALL_MANAGED_MCP_ALIASES,
    });
    expect(integrationsModule.getDecryptedIntegration).toHaveBeenCalledTimes(1);
  });

  it("keeps alias names available for exact deletion after the integration is gone", async () => {
    const dbClient = {
      query: jest.fn(async (sql) =>
        /SELECT mcp_servers FROM agents/.test(sql)
          ? { rows: [{ mcp_servers: ["gitlab"] }] }
          : { rows: [] },
      ),
    };

    await expect(
      mcpServers.getEnabledMcpRuntimeState("agent-1", {
        dbClient,
        integrationsModule: { getDecryptedIntegration: jest.fn() },
        catalog: CATALOG,
      }),
    ).resolves.toEqual({
      enabledIds: ["gitlab"],
      entries: [],
      desiredServers: {},
      env: {},
      managedEnvNames: ALL_MANAGED_MCP_ALIASES,
    });
  });

  it("retains the complete alias removal universe after every MCP server is disabled", async () => {
    const dbClient = {
      query: jest.fn(async (sql) =>
        /SELECT mcp_servers FROM agents/.test(sql) ? { rows: [{ mcp_servers: [] }] } : { rows: [] },
      ),
    };

    await expect(
      mcpServers.getEnabledMcpRuntimeState("agent-1", { dbClient, catalog: CATALOG }),
    ).resolves.toEqual({
      enabledIds: [],
      entries: [],
      desiredServers: {},
      env: {},
      managedEnvNames: ALL_MANAGED_MCP_ALIASES,
    });
  });
});

describe("getAvailableMcpServers", () => {
  function fakeDb({ mcpRows = [], connectedProviders = [] } = {}) {
    return {
      query: jest.fn(async (sql) => {
        if (/SELECT mcp_servers FROM agents/.test(sql)) return { rows: [{ mcp_servers: mcpRows }] };
        if (/FROM integrations/.test(sql))
          return { rows: connectedProviders.map((p) => ({ provider: p })) };
        return { rows: [] };
      }),
    };
  }

  it("annotates each supported server with connected + enabled", async () => {
    const dbClient = fakeDb({ mcpRows: ["gitlab"], connectedProviders: ["gitlab", "stripe"] });
    const servers = await mcpServers.getAvailableMcpServers("a-1", { dbClient, catalog: CATALOG });
    const byProvider = Object.fromEntries(servers.map((s) => [s.provider, s]));
    expect(byProvider.gitlab).toMatchObject({ connected: true, enabled: true });
    expect(byProvider.stripe).toMatchObject({ connected: true, enabled: false });
    expect(byProvider.notion).toMatchObject({ connected: false, enabled: false });
  });
});

describe("setAgentMcpServerIds", () => {
  it("validates against the supported set and writes JSON", async () => {
    const calls = [];
    const dbClient = {
      query: jest.fn(async (sql, params) => (calls.push({ sql, params }), { rows: [] })),
    };
    const result = await mcpServers.setAgentMcpServerIds("a-1", ["gitlab", "bogus", "gitlab"], {
      dbClient,
    });
    expect(result).toEqual(["gitlab"]);
    expect(calls[0].params[0]).toBe(JSON.stringify(["gitlab"]));
    expect(calls[0].params[1]).toBe("a-1");
  });
});
