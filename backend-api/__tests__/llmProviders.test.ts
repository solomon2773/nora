// @ts-nocheck
const mockDbClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockDb = { query: jest.fn() };
const mockPgClient = jest.fn(() => mockDbClient);
const mockEncrypt = jest.fn((value) => `enc(${value})`);

jest.mock("../db", () => mockDb);
jest.mock("pg", () => ({ Client: mockPgClient }));
jest.mock("../crypto", () => ({
  encrypt: mockEncrypt,
  decrypt: jest.fn(),
  ensureEncryptionConfigured: jest.fn(),
}));

const {
  addProvider,
  buildAuthProfiles,
  deleteProvider,
  ensureDemoProvider,
  getDeploymentProvider,
  getManagedProviderEnvNames,
  updateProvider,
} = require("../llmProviders");

beforeEach(() => {
  mockDb.query.mockReset();
  mockPgClient.mockClear();
  mockDbClient.connect.mockReset().mockResolvedValue(undefined);
  mockDbClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockDbClient.end.mockReset().mockResolvedValue(undefined);
  mockEncrypt.mockClear();
});

describe("llmProviders demo/default transitions", () => {
  it("reuses one demo provider across repeated activation attempts", async () => {
    let persisted = null;
    mockDbClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes("FROM llm_providers") && sql.includes("provider = $2")) {
        return { rows: persisted ? [persisted] : [] };
      }
      if (sql.includes("COUNT(*)::int AS provider_count")) {
        return { rows: [{ provider_count: persisted ? 1 : 0 }] };
      }
      if (sql.includes("INSERT INTO llm_providers")) {
        persisted = {
          id: "provider-demo",
          provider: "demo",
          model: "nora-demo-1",
          is_default: true,
          created_at: "2026-07-12T00:00:00.000Z",
        };
        return { rows: [persisted] };
      }
      if (sql.includes("UPDATE llm_providers")) {
        return { rows: [persisted] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const first = await ensureDemoProvider("user-1", mockDbClient);
    const second = await ensureDemoProvider("user-1", mockDbClient);

    expect(first.id).toBe("provider-demo");
    expect(second.id).toBe("provider-demo");
    expect(
      mockDbClient.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO llm_providers")),
    ).toHaveLength(1);
  });

  it("reconciles legacy duplicate demo providers to one canonical row", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-demo-default",
            provider: "demo",
            model: "nora-demo-1",
            is_default: true,
          },
          {
            id: "provider-demo-duplicate",
            provider: "demo",
            model: "nora-demo-1",
            is_default: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-demo-default",
            provider: "demo",
            model: "nora-demo-1",
            is_default: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await ensureDemoProvider("user-1", mockDbClient);

    expect(result.id).toBe("provider-demo-default");
    expect(mockDbClient.query).toHaveBeenCalledWith(
      "DELETE FROM llm_providers WHERE user_id = $1 AND provider = $2 AND id <> $3",
      ["user-1", "demo", "provider-demo-default"],
    );
  });

  it("promotes the first real provider when demo is the current default", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // session advisory lock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ provider_count: 1, demo_is_default: true }] })
      .mockResolvedValueOnce({ rows: [] }) // clear demo default
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-openai",
            provider: "openai",
            model: "gpt-5.5",
            is_default: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await addProvider("user-1", "openai", "sk-live", "gpt-5.5");

    expect(result).toEqual(expect.objectContaining({ id: "provider-openai", is_default: true }));
    expect(mockDbClient.query).toHaveBeenCalledWith(
      "UPDATE llm_providers SET is_default = false WHERE user_id = $1",
      ["user-1"],
    );
    expect(mockDbClient.end).toHaveBeenCalledTimes(1);
  });

  it("does not replace an existing real default when ensuring demo", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ provider_count: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "provider-demo",
            provider: "demo",
            model: "nora-demo-1",
            is_default: false,
          },
        ],
      });

    const result = await ensureDemoProvider("user-1", mockDbClient);

    expect(result.is_default).toBe(false);
    const insertCall = mockDbClient.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO llm_providers"),
    );
    expect(insertCall[1][5]).toBe(false);
  });

  it("keeps a new real provider non-default when a real default already exists", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ provider_count: 2, has_default: true, demo_is_default: false }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "provider-groq", provider: "groq", model: null, is_default: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await addProvider("user-1", "groq", "gsk-live");

    const insertCall = mockDbClient.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO llm_providers"),
    );
    expect(insertCall[1][5]).toBe(false);
    expect(mockDbClient.query).not.toHaveBeenCalledWith(
      "UPDATE llm_providers SET is_default = false WHERE user_id = $1",
      expect.anything(),
    );
  });

  it("serializes default changes and the provider update in one mutation-lock transaction", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // session advisory lock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // clear previous default
      .mockResolvedValueOnce({
        rows: [{ id: "provider-openai", provider: "openai", model: "gpt-5.5", is_default: true }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await updateProvider("provider-openai", "user-1", {
      model: "gpt-5.5",
      is_default: true,
    });

    expect(result).toEqual(expect.objectContaining({ id: "provider-openai", is_default: true }));
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(
      mockDbClient.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(" ")),
    ).toEqual([
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      "BEGIN",
      "UPDATE llm_providers SET",
      "UPDATE llm_providers SET",
      "COMMIT",
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
    ]);
    expect(mockDbClient.end).toHaveBeenCalledTimes(1);
  });

  it("repairs a historical missing default when adding another provider", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ provider_count: 1, has_default: false, demo_is_default: false }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "provider-groq", provider: "groq", model: null, is_default: true }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(addProvider("user-1", "groq", "gsk-live")).resolves.toEqual(
      expect.objectContaining({ id: "provider-groq", is_default: true }),
    );
  });

  it("serializes provider deletion with deployment finalization", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "provider-openai" }] })
      .mockResolvedValueOnce({ rows: [{ id: "provider-google" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(deleteProvider("provider-openai", "user-1")).resolves.toEqual({ success: true });

    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDbClient.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      ["nora:llm-providers:user-1"],
    );
    expect(mockDbClient.query).toHaveBeenNthCalledWith(
      3,
      "DELETE FROM llm_providers WHERE id = $1 AND user_id = $2 RETURNING id",
      ["provider-openai", "user-1"],
    );
    expect(mockDbClient.query.mock.calls[3][0]).toContain("NOT EXISTS");
    expect(mockDbClient.end).toHaveBeenCalledTimes(1);
  });

  it("runs afterCommit after commit while the session advisory lock is still held", async () => {
    const order = [];
    mockDb.query.mockImplementation(async () => {
      order.push("main-pool-sync");
      return { rows: [] };
    });
    mockDbClient.query.mockImplementation(async (sql) => {
      if (sql.includes("pg_advisory_lock")) order.push("lock");
      else if (sql === "BEGIN") order.push("begin");
      else if (sql.startsWith("UPDATE llm_providers SET model")) {
        order.push("update");
        return {
          rows: [
            {
              id: "provider-openai",
              provider: "openai",
              model: "gpt-5.5-pro",
              is_default: true,
            },
          ],
        };
      } else if (sql.includes("WITH candidate")) order.push("repair-default");
      else if (sql === "COMMIT") order.push("commit");
      else if (sql.includes("pg_advisory_unlock")) order.push("unlock");
      return { rows: [] };
    });

    await updateProvider(
      "provider-openai",
      "user-1",
      { model: "gpt-5.5-pro" },
      {
        afterCommit: async (result) => {
          order.push(`sync:${result.model}`);
          await mockDb.query("SELECT provider sync state");
        },
      },
    );

    expect(order).toEqual([
      "lock",
      "begin",
      "update",
      "repair-default",
      "commit",
      "sync:gpt-5.5-pro",
      "main-pool-sync",
      "unlock",
    ]);
    expect(mockPgClient).toHaveBeenCalledWith(
      expect.objectContaining({
        application_name: "nora-backend-provider-mutation",
      }),
    );
    expect(mockPgClient.mock.calls[0][0]).not.toHaveProperty("max");
    expect(mockPgClient.mock.calls[0][0]).not.toHaveProperty("idleTimeoutMillis");
  });

  it("does not run afterCommit when the mutation rolls back", async () => {
    const afterCommit = jest.fn();
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // clear defaults
      .mockResolvedValueOnce({ rows: [] }) // missing provider
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });

    await expect(
      updateProvider("missing-provider", "user-1", { is_default: true }, { afterCommit }),
    ).rejects.toThrow("Provider not found");

    expect(afterCommit).not.toHaveBeenCalled();
    expect(mockDbClient.query).toHaveBeenLastCalledWith(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      ["nora:llm-providers:user-1"],
    );
  });

  it("keeps a sole provider as the default when a client tries to unset it", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "provider-openai", provider: "openai", model: "gpt-5.5", is_default: false }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "provider-openai" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      updateProvider("provider-openai", "user-1", { is_default: false }),
    ).resolves.toEqual(expect.objectContaining({ id: "provider-openai", is_default: true }));
  });

  it("rolls back a default switch when the target provider does not exist", async () => {
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      updateProvider("missing-provider", "user-1", { is_default: true }),
    ).rejects.toThrow("Provider not found");

    expect(mockDbClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mockDbClient.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mockDbClient.query).toHaveBeenLastCalledWith(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      ["nora:llm-providers:user-1"],
    );
    expect(mockDbClient.end).toHaveBeenCalledTimes(1);
  });

  it("rejects non-boolean default flags before opening a transaction", async () => {
    await expect(
      updateProvider("provider-openai", "user-1", { is_default: "false" }),
    ).rejects.toThrow("is_default must be a boolean");
    expect(mockPgClient).not.toHaveBeenCalled();
  });

  it("enumerates the runtime-owned provider env set for replacement updates", () => {
    expect(getManagedProviderEnvNames({ runtimeFamily: "openclaw" })).toEqual(
      expect.arrayContaining([
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_VERSION",
        "MICROSOFT_FOUNDRY_DEPLOYMENT",
        "NORA_DEFAULT_OPENCLAW_MODEL",
      ]),
    );
    expect(getManagedProviderEnvNames({ runtimeFamily: "hermes" })).toEqual(
      expect.arrayContaining(["NORA_HERMES_MANAGED_ENV_B64", "NORA_HERMES_MODEL_CONFIG_B64"]),
    );
  });

  it("selects an explicit owned provider instead of the global default", async () => {
    const queryable = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: "provider-demo",
            provider: "demo",
            model: "nora-demo-1",
            config: { baseUrl: "http://backend-api:4000/demo-llm/v1" },
          },
        ],
      }),
    };

    const result = await getDeploymentProvider("user-1", "provider-demo", queryable);

    expect(result.provider).toBe("demo");
    expect(queryable.query).toHaveBeenCalledWith(expect.stringContaining("id = $2"), [
      "user-1",
      "provider-demo",
    ]);
    expect(queryable.query).toHaveBeenCalledTimes(1);
  });
});

describe("llmProviders.buildAuthProfiles", () => {
  it("builds a persisted OpenClaw auth profile store", () => {
    expect(
      buildAuthProfiles({
        OPENAI_API_KEY: "sk-live-test",
        GEMINI_API_KEY: "gm-live-test",
      }),
    ).toEqual({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-live-test",
        },
        "google:default": {
          type: "api_key",
          provider: "google",
          key: "gm-live-test",
          endpoint: "https://generativelanguage.googleapis.com/v1beta",
        },
      },
      order: {
        openai: ["openai:default"],
        google: ["google:default"],
      },
      lastGood: {
        openai: "openai:default",
        google: "google:default",
      },
    });
  });

  it("maps MICROSOFT_FOUNDRY_API_KEY to a microsoft-foundry profile (no shared default endpoint)", () => {
    // Foundry endpoints are per-resource — without a saved override the profile
    // ships no endpoint and the runtime must rely on the per-user base_url.
    expect(
      buildAuthProfiles({
        MICROSOFT_FOUNDRY_API_KEY: "msft-live-test",
      }),
    ).toEqual({
      version: 1,
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          key: "msft-live-test",
        },
      },
      order: {
        "microsoft-foundry": ["microsoft-foundry:default"],
      },
      lastGood: {
        "microsoft-foundry": "microsoft-foundry:default",
      },
    });
  });

  it("applies a per-user endpoint override for microsoft-foundry", () => {
    const result = buildAuthProfiles(
      { MICROSOFT_FOUNDRY_API_KEY: "msft-live-test" },
      { "microsoft-foundry": "https://my-foundry.openai.azure.com/openai/v1/" },
    );
    expect(result.profiles["microsoft-foundry:default"]).toEqual({
      type: "api_key",
      provider: "microsoft-foundry",
      key: "msft-live-test",
      endpoint: "https://my-foundry.openai.azure.com/openai/v1/",
    });
  });

  it("writes api_version when a per-user override is supplied", () => {
    const result = buildAuthProfiles(
      { MICROSOFT_FOUNDRY_API_KEY: "msft-live-test" },
      { "microsoft-foundry": "https://my-foundry.openai.azure.com/openai/deployments/my-gpt/" },
      { "microsoft-foundry": "2024-10-21" },
    );
    expect(result.profiles["microsoft-foundry:default"]).toEqual({
      type: "api_key",
      provider: "microsoft-foundry",
      key: "msft-live-test",
      endpoint: "https://my-foundry.openai.azure.com/openai/deployments/my-gpt/",
      api_version: "2024-10-21",
    });
  });

  it("per-user override wins over the catalog endpoint", () => {
    // google has a catalog default (https://generativelanguage.googleapis.com/v1beta)
    // but a user-saved override should win.
    const result = buildAuthProfiles(
      { GEMINI_API_KEY: "gm-live-test" },
      { google: "https://custom-gemini.example.com/v1" },
    );
    expect(result.profiles["google:default"].endpoint).toBe("https://custom-gemini.example.com/v1");
  });
});

describe("llmProviders.buildBaseUrlEnvVars", () => {
  const { buildBaseUrlEnvVars } = require("../llmProviders");

  it("derives <PROVIDER>_BASE_URL env vars from <PROVIDER>_API_KEY-keyed overrides", () => {
    expect(
      buildBaseUrlEnvVars({
        MICROSOFT_FOUNDRY_API_KEY: "https://my-foundry.openai.azure.com/openai/v1/",
      }),
    ).toEqual({
      MICROSOFT_FOUNDRY_BASE_URL: "https://my-foundry.openai.azure.com/openai/v1/",
    });
  });

  it("skips entries without a base URL", () => {
    expect(buildBaseUrlEnvVars({ MICROSOFT_FOUNDRY_API_KEY: "" })).toEqual({});
  });
});

describe("llmProviders.buildApiVersionEnvVars", () => {
  const { buildApiVersionEnvVars } = require("../llmProviders");

  it("derives <PROVIDER>_API_VERSION env vars", () => {
    expect(buildApiVersionEnvVars({ MICROSOFT_FOUNDRY_API_KEY: "2024-10-21" })).toEqual({
      MICROSOFT_FOUNDRY_API_VERSION: "2024-10-21",
    });
  });

  it("skips entries without an api-version", () => {
    expect(buildApiVersionEnvVars({ MICROSOFT_FOUNDRY_API_KEY: "" })).toEqual({});
  });
});
