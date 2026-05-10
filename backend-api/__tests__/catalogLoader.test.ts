import { hydrateRow } from "../integrations/catalog/catalogLoader";

describe("catalogLoader.hydrateRow", () => {
  it("surfaces credentialsUrl and setupGuide from the schema", () => {
    const row = {
      id: "demo",
      catalog_id: "demo",
      auth_type: "api_key",
      config_schema: JSON.stringify({
        configFields: [{ key: "token", type: "password", required: true }],
        capabilities: ["read"],
        toolSpecs: [],
        api: { type: "rest" },
        mcp: { available: true, npmPackage: "@example/mcp" },
        usageHints: ["hint"],
        credentialsUrl: "https://example.com/dev",
        setupGuide: { steps: ["a", "b"], scopes: ["read"] },
      }),
    };

    const hydrated = hydrateRow(row);
    expect(hydrated.credentialsUrl).toBe("https://example.com/dev");
    expect(hydrated.setupGuide).toEqual({ steps: ["a", "b"], scopes: ["read"] });
    expect(hydrated.mcp).toEqual({ available: true, npmPackage: "@example/mcp" });
  });

  it("returns null/empty defaults when schema fields are missing", () => {
    const row = { id: "bare", config_schema: JSON.stringify({ configFields: [] }) };
    const hydrated = hydrateRow(row);
    expect(hydrated.credentialsUrl).toBeNull();
    expect(hydrated.setupGuide).toBeNull();
    expect(hydrated.mcp).toBeNull();
    expect(hydrated.usageHints).toEqual([]);
  });
});
