// @ts-nocheck
const { sentryProvider } = require("../../integrations/providers/sentry");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("sentryProvider", () => {
  it("calls /api/0/ with Bearer auth token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await sentryProvider.test({ row: {}, token: "tok", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sentry.io/api/0/",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("emits SENTRY_AUTH_TOKEN + organization + project", () => {
    const env = sentryProvider.mapToEnv({
      row: {},
      token: null,
      config: { organization: "acme", project: "web" },
    });
    expect(env).toEqual({
      primary: "SENTRY_AUTH_TOKEN",
      config: { organization: "SENTRY_ORG", project: "SENTRY_PROJECT" },
    });
  });
});
