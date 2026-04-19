// @ts-nocheck
jest.mock("../db", () => ({ query: jest.fn() }));
jest.mock("../crypto", () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  ensureEncryptionConfigured: jest.fn(),
}));

const { buildAuthProfiles } = require("../llmProviders");

describe("llmProviders.buildAuthProfiles", () => {
  it("builds a persisted OpenClaw auth profile store", () => {
    expect(
      buildAuthProfiles({
        OPENAI_API_KEY: "sk-live-test",
        GEMINI_API_KEY: "gm-live-test",
      })
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
});
