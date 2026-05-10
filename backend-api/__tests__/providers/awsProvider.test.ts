// @ts-nocheck
const { awsProvider } = require("../../integrations/providers/aws");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

const validKey = "AKIAIOSFODNN7EXAMPLE";

describe("awsProvider", () => {
  it("identifies as aws / credentials", () => {
    expect(awsProvider.id).toBe("aws");
    expect(awsProvider.authType).toBe("credentials");
  });

  it("accepts a complete IAM credential set without making network calls", async () => {
    const result = await awsProvider.test(
      {
        row: {},
        token: "secret",
        config: { access_key_id: validKey, region: "us-east-1" },
      },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("us-east-1");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed access keys", async () => {
    const result = await awsProvider.test(
      {
        row: {},
        token: "secret",
        config: { access_key_id: "not-an-aws-key", region: "us-east-1" },
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("AKIA");
  });

  it("rejects missing region", async () => {
    const result = await awsProvider.test(
      { row: {}, token: "secret", config: { access_key_id: validKey } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("region");
  });

  it("emits AWS_* env vars", () => {
    const env = awsProvider.mapToEnv({
      row: {},
      token: null,
      config: { access_key_id: validKey, region: "us-east-1" },
    });
    expect(env).toEqual({
      primary: "AWS_SECRET_ACCESS_KEY",
      config: { access_key_id: "AWS_ACCESS_KEY_ID", region: "AWS_DEFAULT_REGION" },
    });
  });
});
