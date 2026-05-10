// @ts-nocheck
const { emailProvider } = require("../../integrations/providers/email");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

const goodConfig = {
  smtp_host: "smtp.gmail.com",
  smtp_port: 587,
  smtp_user: "alice@example.com",
  from_address: "alice@example.com",
};

describe("emailProvider", () => {
  it("identifies as email / credentials", () => {
    expect(emailProvider.id).toBe("email");
    expect(emailProvider.authType).toBe("credentials");
  });

  it("accepts a complete config without making any network calls", async () => {
    const result = await emailProvider.test({ row: {}, token: "secret", config: goodConfig }, deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("smtp.gmail.com:587");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["smtp_host", { ...goodConfig, smtp_host: "" }, "host"],
    ["smtp_port", { ...goodConfig, smtp_port: 0 }, "port"],
    ["smtp_user", { ...goodConfig, smtp_user: "" }, "username"],
    ["from_address", { ...goodConfig, from_address: "" }, "From address"],
  ])("rejects when %s is empty", async (_, cfg, expected) => {
    const result = await emailProvider.test({ row: {}, token: "secret", config: cfg }, deps);
    expect(result.success).toBe(false);
    expect(result.error.toLowerCase()).toContain(expected.toLowerCase());
  });

  it("rejects RFC1918 / loopback hosts", async () => {
    const cfg = { ...goodConfig, smtp_host: "127.0.0.1" };
    const result = await emailProvider.test({ row: {}, token: "s", config: cfg }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("RFC1918");
  });

  it("rejects malformed from_address", async () => {
    const cfg = { ...goodConfig, from_address: "not-an-email" };
    const result = await emailProvider.test({ row: {}, token: "s", config: cfg }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a valid email");
  });

  it("emits SMTP_PASS as primary and the host/port/user/from envs", () => {
    const env = emailProvider.mapToEnv({ row: {}, token: null, config: goodConfig });
    expect(env.primary).toBe("SMTP_PASS");
    expect(env.config).toEqual({
      smtp_host: "SMTP_HOST",
      smtp_port: "SMTP_PORT",
      smtp_user: "SMTP_USER",
      from_address: "SMTP_FROM_ADDRESS",
    });
  });
});
