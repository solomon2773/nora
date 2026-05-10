// @ts-nocheck
const { notionProvider } = require("../../integrations/providers/notion");

function deps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (u) => u,
    encrypt: (s) => s,
    decrypt: (s) => s,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("notionProvider", () => {
  it("calls /v1/users/me with Bearer token + Notion-Version", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "Alice", id: "abc" }),
    });
    const result = await notionProvider.test(
      { row: {}, token: "secret_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.notion.com/v1/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret_x",
          "Notion-Version": "2022-06-28",
        }),
      }),
    );
    expect(result.message).toBe("Connected as Alice");
  });

  it("emits NOTION_TOKEN", () => {
    expect(notionProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "NOTION_TOKEN",
      config: {},
    });
  });
});
