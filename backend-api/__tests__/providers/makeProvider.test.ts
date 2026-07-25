// @ts-nocheck
const { makeProvider } = require("../../integrations/providers/make");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (url) => url,
  encrypt: (value) => value,
  decrypt: (value) => value,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("makeProvider", () => {
  beforeEach(() => {
    deps.fetch.mockClear();
  });

  it("identifies as make / webhook", () => {
    expect(makeProvider.id).toBe("make");
    expect(makeProvider.authType).toBe("webhook");
  });

  it("accepts an HTTPS webhook without triggering the scenario", async () => {
    const result = await makeProvider.test(
      {
        row: {},
        token: null,
        config: { webhook_url: "https://hook.us1.make.com/example" },
      },
      deps,
    );
    expect(result).toEqual({
      success: true,
      message: "Webhook URL stored — Make.com webhooks have no validation endpoint",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "not configured"],
    [{ webhook_url: "not-a-url" }, "not a valid URL"],
    [{ webhook_url: "http://hook.us1.make.com/example" }, "must use https://"],
  ])("rejects invalid webhook configuration %#", async (config, error) => {
    const result = await makeProvider.test({ row: {}, token: null, config }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain(error);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("maps only the webhook URL to the runtime environment", () => {
    expect(
      makeProvider.mapToEnv({
        row: {},
        token: null,
        config: { webhook_url: "https://hook.us1.make.com/example" },
      }),
    ).toEqual({
      primary: null,
      config: { webhook_url: "MAKE_WEBHOOK_URL" },
    });
    expect(makeProvider.mapToEnv({ row: {}, token: null, config: {} }).config).toEqual({});
  });
});
