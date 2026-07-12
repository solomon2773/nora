// @ts-nocheck
const request = require("supertest");
const express = require("express");

const mockAddProvider = jest.fn();
const mockUpdateProvider = jest.fn();
const mockDeleteProvider = jest.fn();
const mockSyncAuthToUserAgents = jest.fn();

jest.mock("../llmProviders", () => ({
  addProvider: mockAddProvider,
  listProviders: jest.fn(),
  getAvailableProviders: jest.fn(),
  updateProvider: mockUpdateProvider,
  deleteProvider: mockDeleteProvider,
}));
jest.mock("../authSync", () => ({
  syncAuthToUserAgents: mockSyncAuthToUserAgents,
}));

const router = require("../routes/llmProviders");
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: "user-1" };
  next();
});
app.use("/llm-providers", router);

beforeEach(() => {
  jest.clearAllMocks();
  mockAddProvider.mockImplementation(async (...args) => {
    const result = {
      id: "provider-openai",
      provider: "openai",
      model: "gpt-5.5",
      is_default: true,
    };
    await args[5]?.afterCommit?.(result);
    return result;
  });
  mockUpdateProvider.mockImplementation(async (...args) => {
    const result = {
      id: "provider-openai",
      provider: "openai",
      model: "gpt-5.5-pro",
      is_default: true,
    };
    await args[3]?.afterCommit?.(result);
    return result;
  });
  mockDeleteProvider.mockImplementation(async (...args) => {
    const result = { success: true };
    await args[2]?.afterCommit?.(result);
    return result;
  });
});

describe("PUT/DELETE /llm-providers/:id", () => {
  it("awaits update sync and reports per-agent failures", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      { agentId: "agent-1", status: "failed", error: "runtime unavailable" },
    ]);

    const response = await request(app)
      .put("/llm-providers/provider-openai")
      .send({ model: "gpt-5.5-pro" });

    expect(response.status).toBe(200);
    expect(mockUpdateProvider).toHaveBeenCalledWith(
      "provider-openai",
      "user-1",
      { model: "gpt-5.5-pro" },
      { afterCommit: expect.any(Function) },
    );
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1");
    expect(response.body.sync_warning).toMatch(/1 running agent/i);
    expect(response.body.sync_results[0]).toEqual(
      expect.objectContaining({ agentId: "agent-1", status: "failed" }),
    );
  });

  it("awaits delete sync and returns a warning when synchronization rejects", async () => {
    mockSyncAuthToUserAgents.mockRejectedValue(new Error("runtime sync crashed"));

    const response = await request(app).delete("/llm-providers/provider-openai");

    expect(response.status).toBe(200);
    expect(mockDeleteProvider).toHaveBeenCalledWith("provider-openai", "user-1", {
      afterCommit: expect.any(Function),
    });
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        sync_results: [],
        sync_warning: expect.stringMatching(/provider deleted/i),
      }),
    );
  });
});

describe("POST /llm-providers", () => {
  it("awaits runtime sync after saving a real provider and returns per-agent warnings", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      { agentId: "agent-1", status: "synced" },
      { agentId: "agent-2", status: "failed", error: "runtime unavailable" },
    ]);

    const response = await request(app).post("/llm-providers").send({
      provider: "openai",
      apiKey: "sk-live",
      model: "gpt-5.5",
    });

    expect(response.status).toBe(200);
    expect(mockAddProvider).toHaveBeenCalledWith(
      "user-1",
      "openai",
      "sk-live",
      "gpt-5.5",
      undefined,
      { afterCommit: expect.any(Function) },
    );
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1");
    expect(response.body).toEqual(
      expect.objectContaining({
        id: "provider-openai",
        sync_results: expect.arrayContaining([
          expect.objectContaining({ agentId: "agent-2", status: "failed" }),
        ]),
        sync_warning: expect.stringMatching(/1 running agent/i),
      }),
    );
  });

  it("keeps the successful save response when runtime sync rejects", async () => {
    mockSyncAuthToUserAgents.mockRejectedValue(new Error("runtime sync crashed"));

    const response = await request(app).post("/llm-providers").send({
      provider: "openai",
      apiKey: "sk-live",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: "provider-openai",
        sync_results: [],
        sync_warning: expect.stringMatching(/provider saved/i),
      }),
    );
  });
});
