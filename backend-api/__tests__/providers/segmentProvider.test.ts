// @ts-nocheck
const { segmentProvider } = require("../../integrations/providers/segment");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("segmentProvider", () => {
  it("accepts a non-empty write key without making network calls", async () => {
    const result = await segmentProvider.test({ row: {}, token: "wk_x", config: {} }, deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("validation endpoint");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects empty write key", async () => {
    const result = await segmentProvider.test({ row: {}, token: "", config: {} }, deps);
    expect(result.success).toBe(false);
  });

  it("emits SEGMENT_WRITE_KEY", () => {
    expect(segmentProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "SEGMENT_WRITE_KEY",
      config: {},
    });
  });
});
