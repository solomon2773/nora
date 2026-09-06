// @ts-nocheck
/**
 * __tests__/observabilityAdmin.test.ts — Phase 5 of the logging control
 * plane: the backend-api HTTP surface in routes/observability.ts.
 *   - DELETE /logs                  (manual deletion, item 7b)
 *   - GET/PUT /admin/log-storage    (platform storage destination, item 7a-ii)
 *
 * Mocks db, monitoring, and the worker's retentionSweeper module (the
 * business logic itself is covered directly by
 * workers/provisioner/retentionSweeper.test.js) so this file focuses on the
 * HTTP contract: auth/role guards, request validation, and the Kubernetes
 * validation rule.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;
process.env.ENCRYPTION_KEY = "a".repeat(64);

const mockDb = { query: jest.fn() };
const mockLogEvent = jest.fn().mockResolvedValue(undefined);
const mockDeleteLogsByAgentAndRange = jest.fn();
const mockGetCapacityStatus = jest.fn().mockResolvedValue({
  usedBytes: 0,
  limitBytes: Infinity,
  state: "ok",
});
const mockLocalStorageUsage = jest.fn().mockResolvedValue(0);
const mockBackendsRequiringRetainedCredentials = jest.fn().mockResolvedValue(new Set());
const mockStartStorageMigration = jest.fn().mockResolvedValue({
  jobId: "job-1",
  segmentsTotal: 0,
  bytesToMigrate: 0,
});
const mockGetMigrationStatus = jest.fn().mockResolvedValue({ status: "none" });

jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  cancelDeploymentJobsForAgent: jest.fn(),
  addKubernetesPolicyReconcileJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../monitoring", () => ({
  logEvent: mockLogEvent,
  getMetrics: jest.fn().mockResolvedValue({}),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  enforceLimits: jest.fn().mockResolvedValue({ allowed: true }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
}));
jest.mock("../../workers/provisioner/logs/retentionSweeper.ts", () => ({
  deleteLogsByAgentAndRange: mockDeleteLogsByAgentAndRange,
  getCapacityStatus: mockGetCapacityStatus,
  localStorageUsage: mockLocalStorageUsage,
}));
jest.mock("../../workers/provisioner/logs/storageMigration.ts", () => ({
  backendsRequiringRetainedCredentials: mockBackendsRequiringRetainedCredentials,
  startStorageMigration: mockStartStorageMigration,
  getMigrationStatus: mockGetMigrationStatus,
}));

const app = require("../server");
const adminToken = jwt.sign({ id: "admin-1", role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const asAdmin = (req) => req.set("Authorization", `Bearer ${adminToken}`);
const asUser = (req) => req.set("Authorization", `Bearer ${userToken}`);

beforeEach(() => {
  mockDb.query.mockReset();
  mockLogEvent.mockClear();
  mockDeleteLogsByAgentAndRange.mockReset();
  mockGetCapacityStatus.mockClear();
  mockLocalStorageUsage.mockReset().mockResolvedValue(0);
  mockBackendsRequiringRetainedCredentials.mockReset().mockResolvedValue(new Set());
  mockStartStorageMigration.mockReset().mockResolvedValue({
    jobId: "job-1",
    segmentsTotal: 0,
    bytesToMigrate: 0,
  });
  mockGetMigrationStatus.mockReset().mockResolvedValue({ status: "none" });
  delete process.env.ENABLED_BACKENDS;
  delete process.env.NORA_LOG_LOCAL_MAX_BYTES;
});

describe("DELETE /logs (manual deletion, item 7b)", () => {
  it("requires agentId, from, and to", async () => {
    const res = await asUser(request(app).delete("/logs").send({}));
    expect(res.status).toBe(400);
    expect(mockDeleteLogsByAgentAndRange).not.toHaveBeenCalled();
  });

  it("removes the requested agent/time-range segments for an authorized actor", async () => {
    mockDeleteLogsByAgentAndRange.mockResolvedValueOnce({
      deletedSegments: 3,
      deletedObjects: 3,
      deletedLegacyCopies: 0,
    });
    const res = await asUser(
      request(app).delete("/logs").send({
        agentId: "agent-1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deletedSegments: 3, deletedObjects: 3 });
    expect(mockDeleteLogsByAgentAndRange).toHaveBeenCalledWith(
      "agent-1",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      expect.objectContaining({ id: "user-1" }),
    );
  });

  it("rejects a range the actor lacks access to (workspace role check surfaced as 404)", async () => {
    const error = new Error("Agent not found, or you do not have editor access to it");
    error.statusCode = 404;
    mockDeleteLogsByAgentAndRange.mockRejectedValueOnce(error);
    const res = await asUser(
      request(app).delete("/logs").send({
        agentId: "agent-not-mine",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/editor access/);
  });
});

describe("GET /admin/log-storage (item 7a-ii)", () => {
  it("rejects non-admin", async () => {
    const res = await asUser(request(app).get("/admin/log-storage"));
    expect(res.status).toBe(403);
  });

  it("returns the current destination plus capacity status for an admin", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] });
    const res = await asAdmin(request(app).get("/admin/log-storage"));
    expect(res.status).toBe(200);
    expect(res.body.storageBackend).toBe("local");
    expect(res.body.capacity).toMatchObject({ state: "ok" });
  });
});

describe("PUT /admin/log-storage (item 7a-ii)", () => {
  it("rejects non-admin", async () => {
    const res = await asUser(request(app).put("/admin/log-storage").send({ storageBackend: "s3" }));
    expect(res.status).toBe(403);
  });

  it("rejects an unknown storageBackend value", async () => {
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "dropbox" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects selecting local while k8s is an enabled deploy target", async () => {
    process.env.ENABLED_BACKENDS = "docker,k8s";
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "local" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("local_unsupported_with_k8s");
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("allows selecting local when k8s is not an enabled deploy target", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{}] }) // current row read
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] }); // upsert RETURNING
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "local" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.storageBackend).toBe("local");
  });

  it("writes a distinct events row on every successful change", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{}] }) // current row read
      .mockResolvedValueOnce({ rows: [] }) // no active migration job (backend is changing: local -> s3)
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3", log_storage_s3_bucket: "b" }] }); // upsert RETURNING
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "s3", s3Bucket: "b" }),
    );
    expect(res.status).toBe(200);
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent.mock.calls[0][0]).toBe("admin_log_storage_settings_updated");
    // Destination actually changed (local -> s3), so Phase 5b's migration
    // kicks off automatically.
    expect(mockStartStorageMigration).toHaveBeenCalledWith(
      { storageBackend: "local" },
      { storageBackend: "s3" },
      false,
    );
    expect(res.body.migration).toMatchObject({ jobId: "job-1" });
  });

  it("selecting s3 while k8s is enabled is allowed (only local+k8s is rejected)", async () => {
    process.env.ENABLED_BACKENDS = "docker,k8s";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] }) // no active migration job
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3" }] });
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "s3", s3Bucket: "b" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("PUT /admin/log-storage — Phase 5b storage migration integration", () => {
  it("rejects an overlapping migration with no side effects", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{}] }) // current row read (backend: local)
      .mockResolvedValueOnce({ rows: [{ id: "job-existing" }] }); // an active migration job
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "s3", s3Bucket: "b" }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("log_storage_migration_in_progress");
    expect(mockDb.query).toHaveBeenCalledTimes(2); // no upsert attempted
    expect(mockStartStorageMigration).not.toHaveBeenCalled();
  });

  it("rejects switching to local with no side effects when capacity would be exceeded", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.NORA_LOG_LOCAL_MAX_BYTES = "1000";
    mockLocalStorageUsage.mockResolvedValueOnce(400);
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3" }] }) // current row read
      .mockResolvedValueOnce({ rows: [] }) // no active migration job
      .mockResolvedValueOnce({ rows: [{ bytes: "800" }] }); // segments to migrate under s3
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "local" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("log_storage_capacity_exceeded");
    expect(mockDb.query).toHaveBeenCalledTimes(3); // no upsert attempted
    expect(mockStartStorageMigration).not.toHaveBeenCalled();
  });

  it("allows switching to local when there is enough headroom", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.NORA_LOG_LOCAL_MAX_BYTES = "10000";
    mockLocalStorageUsage.mockResolvedValueOnce(100);
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3" }] }) // current row read
      .mockResolvedValueOnce({ rows: [] }) // no active migration job
      .mockResolvedValueOnce({ rows: [{ bytes: "200" }] }) // segments to migrate under s3
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] }); // upsert RETURNING
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "local" }),
    );
    expect(res.status).toBe(200);
    expect(mockStartStorageMigration).toHaveBeenCalledWith(
      { storageBackend: "s3" },
      { storageBackend: "local" },
      false,
    );
  });

  it("passes keepSourceCopies through to startStorageMigration", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3" }] });
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "s3", s3Bucket: "b", keepSourceCopies: true }),
    );
    expect(res.status).toBe(200);
    expect(mockStartStorageMigration).toHaveBeenCalledWith(
      { storageBackend: "local" },
      { storageBackend: "s3" },
      true,
    );
  });

  it("rejects clearing S3 credentials while a migration or legacy copy still references that backend", async () => {
    mockBackendsRequiringRetainedCredentials.mockResolvedValueOnce(new Set(["s3"]));
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "local", clearS3AccessKey: true }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("log_storage_credentials_in_use");
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects clearing SSH credentials while a migration or legacy copy still references that backend", async () => {
    mockBackendsRequiringRetainedCredentials.mockResolvedValueOnce(new Set(["ssh"]));
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "local", clearSshPassword: true }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("log_storage_credentials_in_use");
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("allows clearing S3 credentials once no migration or legacy copy references it", async () => {
    mockBackendsRequiringRetainedCredentials.mockResolvedValueOnce(new Set());
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] })
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] });
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "local", clearS3AccessKey: true }),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/log-storage/migration (item 6)", () => {
  it("rejects non-admin", async () => {
    const res = await asUser(request(app).get("/admin/log-storage/migration"));
    expect(res.status).toBe(403);
  });

  it("returns 'none' when no migration has ever run", async () => {
    const res = await asAdmin(request(app).get("/admin/log-storage/migration"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "none" });
  });

  it("returns real progress from a running job", async () => {
    mockGetMigrationStatus.mockResolvedValueOnce({
      jobId: "job-1",
      status: "running",
      segmentsTotal: 10,
      segmentsMigrated: 4,
    });
    const res = await asAdmin(request(app).get("/admin/log-storage/migration"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "running", segmentsTotal: 10, segmentsMigrated: 4 });
  });
});
