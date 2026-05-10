// @ts-nocheck
const { s3Provider } = require("../../integrations/providers/s3");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("s3Provider", () => {
  it("identifies as s3 / credentials", () => {
    expect(s3Provider.id).toBe("s3");
    expect(s3Provider.authType).toBe("credentials");
  });

  it("accepts access key + secret without making network calls", async () => {
    const result = await s3Provider.test(
      {
        row: {},
        token: "secret",
        config: { access_key_id: "AKIA...", region: "us-west-2", bucket_name: "my-bucket" },
      },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("my-bucket");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects when access key or secret missing", async () => {
    let result = await s3Provider.test({ row: {}, token: "secret", config: {} }, deps);
    expect(result.success).toBe(false);
    result = await s3Provider.test({ row: {}, token: "", config: { access_key_id: "AKIA" } }, deps);
    expect(result.success).toBe(false);
  });

  it("emits AWS_* env vars", () => {
    const env = s3Provider.mapToEnv({
      row: {},
      token: null,
      config: { access_key_id: "AKIA", region: "us-west-2", bucket_name: "b" },
    });
    expect(env.primary).toBe("AWS_SECRET_ACCESS_KEY");
    expect(env.config).toEqual({
      access_key_id: "AWS_ACCESS_KEY_ID",
      region: "AWS_REGION",
      bucket_name: "S3_BUCKET",
    });
  });
});
