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
  if (req.get("x-test-api-key")) {
    req.apiKey = {
      workspaceId: "workspace-1",
      scopes: [
        "agents:read",
        "agents:write",
        "workspaces:read",
        "monitoring:read",
        "integrations:read",
        "integrations:write",
        "admin:read",
      ],
    };
  }
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

describe("workspace API-key isolation", () => {
  const apiKeyRequest = (method, path) =>
    request(app)[method](path).set("x-test-api-key", "present");

  it.each([
    ["post", "/llm-providers", { provider: "openai", apiKey: "sk-live" }],
    ["put", "/llm-providers/provider-openai", { is_default: true }],
    ["delete", "/llm-providers/provider-openai", undefined],
    ["post", "/llm-providers/sync", { agentId: "remote-docker-agent" }],
  ])(
    "rejects API-key %s %s before provider or reconciliation side effects",
    async (method, path, body) => {
      let pending = apiKeyRequest(method, path);
      if (body) pending = pending.send(body);

      const response = await pending;

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "This endpoint requires session authentication",
        code: "session_required",
      });
      expect(mockAddProvider).not.toHaveBeenCalled();
      expect(mockUpdateProvider).not.toHaveBeenCalled();
      expect(mockDeleteProvider).not.toHaveBeenCalled();
      expect(mockSyncAuthToUserAgents).not.toHaveBeenCalled();
    },
  );

  it.each([["/llm-providers/available"], ["/llm-providers"]])(
    "rejects API-key reads on the user-global provider surface: %s",
    async (path) => {
      const response = await apiKeyRequest("get", path);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("session_required");
    },
  );
});

describe("PUT/DELETE /llm-providers/:id", () => {
  it("awaits update sync and reports per-agent failures", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      {
        agentId: "agent-1",
        status: "failed",
        error: "runtime unavailable",
        runtimeStopped: true,
        quarantinePersisted: true,
      },
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
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", null, {
      providerLockHeld: true,
    });
    expect(response.body.sync_warning).toMatch(/1 running agent/i);
    expect(response.body.sync_results[0]).toEqual(
      expect.objectContaining({ agentId: "agent-1", status: "failed" }),
    );
  });

  it("reports a committed failure when delete synchronization rejects", async () => {
    mockSyncAuthToUserAgents.mockRejectedValue(new Error("runtime sync crashed"));

    const response = await request(app).delete("/llm-providers/provider-openai");

    expect(response.status).toBe(502);
    expect(mockDeleteProvider).toHaveBeenCalledWith("provider-openai", "user-1", {
      afterCommit: expect.any(Function),
    });
    expect(response.body).toEqual(
      expect.objectContaining({
        committed: true,
        sync_results: [],
        error: expect.stringMatching(/provider deleted/i),
      }),
    );
  });

  it("returns a committed 502 when stale runtime credentials could not be contained", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      {
        agentId: "agent-1",
        status: "failed",
        error: "environment update failed",
        runtimeStopped: false,
        quarantinePersisted: true,
        stopError: "remote stop failed",
      },
    ]);

    const response = await request(app).delete("/llm-providers/provider-openai");

    expect(response.status).toBe(502);
    expect(response.body).toEqual(
      expect.objectContaining({
        committed: true,
        error: expect.stringMatching(/could not be stopped and quarantined/i),
        sync_results: [expect.objectContaining({ agentId: "agent-1", status: "failed" })],
      }),
    );
  });
});

describe("POST /llm-providers", () => {
  it("awaits runtime sync after saving a real provider and returns per-agent warnings", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      { agentId: "agent-1", status: "synced" },
      {
        agentId: "agent-2",
        status: "failed",
        error: "runtime unavailable",
        runtimeStopped: true,
        quarantinePersisted: true,
      },
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
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", null, {
      providerLockHeld: true,
    });
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

  it("reports a committed failure when save synchronization rejects", async () => {
    mockSyncAuthToUserAgents.mockRejectedValue(new Error("runtime sync crashed"));

    const response = await request(app).post("/llm-providers").send({
      provider: "openai",
      apiKey: "sk-live",
    });

    expect(response.status).toBe(502);
    expect(response.body).toEqual(
      expect.objectContaining({
        committed: true,
        sync_results: [],
        error: expect.stringMatching(/provider saved/i),
      }),
    );
  });
});
