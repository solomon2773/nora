// @ts-nocheck
const express = require("express");
const request = require("supertest");

const mockBuildLiveMigrationManifest = jest.fn();
const mockCreateMigrationDraft = jest.fn();
const mockDeleteOwnedMigrationDraft = jest.fn();
const mockGetOwnedMigrationDraft = jest.fn();
const mockParseUploadedMigrationBuffer = jest.fn();

jest.mock("../agentMigrations", () => ({
  buildLiveMigrationManifest: (...args) => mockBuildLiveMigrationManifest(...args),
  createMigrationDraft: (...args) => mockCreateMigrationDraft(...args),
  deleteOwnedMigrationDraft: (...args) => mockDeleteOwnedMigrationDraft(...args),
  getOwnedMigrationDraft: (...args) => mockGetOwnedMigrationDraft(...args),
  parseUploadedMigrationBuffer: (...args) => mockParseUploadedMigrationBuffer(...args),
}));
jest.mock("../auditLog", () => ({
  createMutationFailureAuditMiddleware: () => (_req, _res, next) => next(),
}));

const migrationRouter = require("../routes/agentMigrations");

const ordinaryUser = { id: "user-1", role: "user" };
const adminUser = { id: "admin-1", role: "admin" };
const originalPlatformMode = process.env.PLATFORM_MODE;

function createApp({ user = ordinaryUser, apiKey = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    if (apiKey) req.apiKey = apiKey;
    next();
  });
  app.use("/agent-migrations", migrationRouter);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || error.status || 500).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_MODE = "selfhosted";

  mockBuildLiveMigrationManifest.mockResolvedValue({
    format: "nora-migration-bundle/v1",
    runtimeFamily: "openclaw",
  });
  mockCreateMigrationDraft.mockResolvedValue({
    preview: { id: "draft-1", runtimeFamily: "openclaw" },
  });
  mockGetOwnedMigrationDraft.mockResolvedValue({
    id: "draft-1",
    deployed_agent_id: null,
    preview: { id: "draft-1", runtimeFamily: "openclaw" },
  });
  mockDeleteOwnedMigrationDraft.mockResolvedValue(true);
  mockParseUploadedMigrationBuffer.mockResolvedValue({
    format: "nora-migration-bundle/v1",
    runtimeFamily: "openclaw",
  });
});

afterAll(() => {
  if (originalPlatformMode === undefined) delete process.env.PLATFORM_MODE;
  else process.env.PLATFORM_MODE = originalPlatformMode;
});

it("rejects API-key authentication from every migration route", async () => {
  const app = createApp({ apiKey: { id: "key-1", scopes: ["agents:read", "agents:write"] } });
  const responses = [
    await request(app)
      .post("/agent-migrations/upload")
      .set("Content-Type", "application/octet-stream")
      .set("x-upload-filename", "agent.json")
      .send(Buffer.from("{}")),
    await request(app)
      .post("/agent-migrations/live-inspect")
      .send({ transport: "docker", container_id: "source-agent" }),
    await request(app).get("/agent-migrations/draft-1"),
    await request(app).delete("/agent-migrations/draft-1"),
  ];

  for (const response of responses) {
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "This endpoint requires session authentication",
      code: "session_required",
    });
  }
  expect(mockParseUploadedMigrationBuffer).not.toHaveBeenCalled();
  expect(mockBuildLiveMigrationManifest).not.toHaveBeenCalled();
  expect(mockGetOwnedMigrationDraft).not.toHaveBeenCalled();
  expect(mockDeleteOwnedMigrationDraft).not.toHaveBeenCalled();
});

it("preserves upload, read, and delete for ordinary session users", async () => {
  const app = createApp();

  const upload = await request(app)
    .post("/agent-migrations/upload")
    .set("Content-Type", "application/octet-stream")
    .set("x-upload-filename", "agent.json")
    .send(Buffer.from("{}"));
  const read = await request(app).get("/agent-migrations/draft-1");
  const remove = await request(app).delete("/agent-migrations/draft-1");

  expect(upload.status).toBe(200);
  expect(read.status).toBe(200);
  expect(remove.status).toBe(200);
  expect(mockCreateMigrationDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "user-1",
      sourceKind: "upload",
      sourceTransport: "file",
    }),
  );
  expect(mockGetOwnedMigrationDraft).toHaveBeenCalledWith("draft-1", "user-1");
  expect(mockDeleteOwnedMigrationDraft).toHaveBeenCalledWith("draft-1", "user-1");
});

it("rejects live inspection from an ordinary session", async () => {
  const response = await request(createApp())
    .post("/agent-migrations/live-inspect")
    .send({ transport: "docker", container_id: "source-agent" });

  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: "Admin access required" });
  expect(mockBuildLiveMigrationManifest).not.toHaveBeenCalled();
});

it("rejects live inspection from a PaaS platform admin", async () => {
  process.env.PLATFORM_MODE = "paas";

  const response = await request(createApp({ user: adminUser }))
    .post("/agent-migrations/live-inspect")
    .send({ transport: "docker", container_id: "source-agent" });

  expect(response.status).toBe(403);
  expect(response.body).toEqual({
    error: "Live migration inspection is only available in self-hosted mode",
    code: "live_inspect_selfhosted_only",
  });
  expect(mockBuildLiveMigrationManifest).not.toHaveBeenCalled();
});

it("fails closed for an unknown platform mode", async () => {
  process.env.PLATFORM_MODE = "unknown";

  const response = await request(createApp({ user: adminUser }))
    .post("/agent-migrations/live-inspect")
    .send({ transport: "docker", container_id: "source-agent" });

  expect(response.status).toBe(403);
  expect(response.body).toEqual({
    error: "Live migration inspection is only available in self-hosted mode",
    code: "live_inspect_selfhosted_only",
  });
  expect(mockBuildLiveMigrationManifest).not.toHaveBeenCalled();
});

it("rejects SSH live inspection before any source connection is attempted", async () => {
  const response = await request(createApp({ user: adminUser }))
    .post("/agent-migrations/live-inspect")
    .send({ transport: "ssh", host: "source.example.com", username: "root" });

  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error: "Live migration inspection requires the local Docker transport",
    code: "live_inspect_docker_only",
  });
  expect(mockBuildLiveMigrationManifest).not.toHaveBeenCalled();
});

it("lets a self-hosted platform admin inspect local Docker and create a draft", async () => {
  const response = await request(createApp({ user: adminUser }))
    .post("/agent-migrations/live-inspect")
    .send({ transport: "DOCKER", container_id: "source-agent" });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    draft: { id: "draft-1", runtimeFamily: "openclaw" },
  });
  expect(mockBuildLiveMigrationManifest).toHaveBeenCalledWith({
    transport: "docker",
    container_id: "source-agent",
  });
  expect(mockCreateMigrationDraft).toHaveBeenCalledWith({
    userId: "admin-1",
    manifest: expect.objectContaining({ runtimeFamily: "openclaw" }),
    sourceKind: "live",
    sourceTransport: "docker",
  });
});
