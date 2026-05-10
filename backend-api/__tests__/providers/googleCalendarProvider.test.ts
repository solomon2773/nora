// @ts-nocheck
const { googleCalendarProvider } = require("../../integrations/providers/googleCalendar");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

const validSa = JSON.stringify({
  client_email: "agent@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  project_id: "p",
});

describe("googleCalendarProvider", () => {
  it("identifies as google-calendar / service_account", () => {
    expect(googleCalendarProvider.id).toBe("google-calendar");
    expect(googleCalendarProvider.authType).toBe("service_account");
  });

  it("validates the SA JSON structurally", async () => {
    const result = await googleCalendarProvider.test(
      { row: {}, token: null, config: { service_account_json: validSa } },
      deps,
    );
    expect(result.success).toBe(true);
  });

  it("emits GOOGLE_APPLICATION_CREDENTIALS_JSON + calendar_id", () => {
    const env = googleCalendarProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_json: validSa, calendar_id: "primary" },
    });
    expect(env.primary).toBeNull();
    expect(env.config.calendar_id).toBe("GOOGLE_CALENDAR_DEFAULT_ID");
  });
});
