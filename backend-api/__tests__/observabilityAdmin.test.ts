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
// Defaults to success so every existing test — none of which are actually
// testing destination validation — keeps behaving as if the destination
// checked out fine. The dedicated "pre-flight probe" describe block below
// overrides this per-test to exercise the reject path.
const mockProbeStorageDestination = jest.fn().mockResolvedValue({ ok: true });

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
jest.mock("../../agent-runtime/lib/objectStorage.ts", () => ({
  probeStorageDestination: mockProbeStorageDestination,
}));
const mockApplyTracingConfig = jest.fn().mockResolvedValue({ applied: true });
jest.mock("../agentTracing.ts", () => ({
  applyTracingConfig: (...args) => mockApplyTracingConfig(...args),
  PLATFORM_LOG_SETTINGS_DEFAULTS: {
    gateway_logs_enabled: true,
    traces_enabled: false,
    trace_sample_rate: 1.0,
  },
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
  mockProbeStorageDestination.mockReset().mockResolvedValue({ ok: true });
  mockApplyTracingConfig.mockReset().mockResolvedValue({ applied: true });
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

describe("PUT /admin/log-storage — pre-flight destination probe", () => {
  // Regression coverage for the mechanism the credential-decryption bug and
  // the migration-retry gap both exposed: a bad/untested credential must
  // never get persisted as the active destination in the first place —
  // catching it only when the (async, easy-to-miss) migration job fails is
  // too late, since live log writes flip to the new destination immediately
  // on save, before the migration even runs.

  it("rejects the save and writes nothing when the destination fails verification", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockProbeStorageDestination.mockRejectedValueOnce(new Error("S3 storage is not fully configured"));
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] }) // current row read
      .mockResolvedValueOnce({ rows: [] }); // no active migration job
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "s3", s3Bucket: "b", s3AccessKeyId: "bad", s3SecretAccessKey: "bad" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("log_storage_probe_failed");
    expect(res.body.error).toContain("S3 storage is not fully configured");
    // Exactly the two reads above — no upsert attempted, no cache flip, no
    // migration ever started.
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockStartStorageMigration).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("maps a known S3 error code onto a short, plain-language message instead of AWS's raw wording", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    const rejection = new Error(
      "The request signature we calculated does not match the signature you provided. " +
        "Check your key and signing method. (SignatureDoesNotMatch)",
    );
    rejection.remoteCode = "SignatureDoesNotMatch";
    mockProbeStorageDestination.mockRejectedValueOnce(rejection);
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "s3", s3Bucket: "b", s3AccessKeyId: "bad", s3SecretAccessKey: "bad" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Destination check failed: Invalid access key ID or secret access key.");
  });

  it("skips the probe entirely for a local destination (no remote credentials to verify)", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ bytes: "0" }] })
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] });
    const res = await asAdmin(
      request(app).put("/admin/log-storage").send({ storageBackend: "local" }),
    );
    expect(res.status).toBe(200);
    expect(mockProbeStorageDestination).not.toHaveBeenCalled();
  });

  it("saves normally when the destination verifies successfully", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "local" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ log_storage_backend: "s3", log_storage_s3_bucket: "b" }] });
    const res = await asAdmin(
      request(app)
        .put("/admin/log-storage")
        .send({ storageBackend: "s3", s3Bucket: "b", s3AccessKeyId: "good", s3SecretAccessKey: "good" }),
    );
    expect(res.status).toBe(200);
    expect(mockProbeStorageDestination).toHaveBeenCalledWith(
      expect.objectContaining({ storageBackend: "s3", bucket: "b", accessKeyId: "good", secretAccessKey: "good" }),
    );
    expect(mockStartStorageMigration).toHaveBeenCalled();
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

describe("GET/PUT /workspaces/:id/log-settings (Phase 12 item 6)", () => {
  const WORKSPACE_ID = "33333333-3333-3333-3333-333333333333";
  const adminMembershipRow = {
    rows: [{ id: WORKSPACE_ID, user_id: "someone-else", role: "admin" }],
  };
  const viewerMembershipRow = {
    rows: [{ id: WORKSPACE_ID, user_id: "someone-else", role: "viewer" }],
  };

  it("rejects a caller without at least admin workspace role", async () => {
    mockDb.query.mockResolvedValueOnce(viewerMembershipRow);
    const res = await asUser(request(app).get(`/workspaces/${WORKSPACE_ID}/log-settings`));
    expect(res.status).toBe(403);
  });

  it("returns platform defaults when the workspace has no settings row yet", async () => {
    mockDb.query
      .mockResolvedValueOnce(adminMembershipRow) // requireWorkspaceRole
      .mockResolvedValueOnce({ rows: [] }); // no workspace_log_settings row

    const res = await asAdmin(request(app).get(`/workspaces/${WORKSPACE_ID}/log-settings`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runtimeRetentionDays: 30,
      traceRetentionDays: 30,
      gatewayLogsEnabled: true,
      tracesEnabled: false,
      traceSampleRate: 1.0,
    });
  });

  it("returns the workspace's own row when one exists", async () => {
    mockDb.query.mockResolvedValueOnce(adminMembershipRow).mockResolvedValueOnce({
      rows: [
        {
          runtime_retention_days: 14,
          trace_retention_days: 7,
          gateway_logs_enabled: false,
          traces_enabled: true,
          trace_sample_rate: 1.0,
        },
      ],
    });

    const res = await asAdmin(request(app).get(`/workspaces/${WORKSPACE_ID}/log-settings`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runtimeRetentionDays: 14,
      traceRetentionDays: 7,
      gatewayLogsEnabled: false,
      tracesEnabled: true,
      traceSampleRate: 1.0,
    });
  });

  it("rejects a PUT from a caller without admin workspace role", async () => {
    mockDb.query.mockResolvedValueOnce(viewerMembershipRow);
    const res = await asUser(
      request(app).put(`/workspaces/${WORKSPACE_ID}/log-settings`).send({ tracesEnabled: true }),
    );
    expect(res.status).toBe(403);
    expect(mockApplyTracingConfig).not.toHaveBeenCalled();
  });

  it("rejects non-integer/invalid retention values", async () => {
    mockDb.query
      .mockResolvedValueOnce(adminMembershipRow)
      .mockResolvedValueOnce({ rows: [] }); // current-settings read inside the PUT handler

    const res = await asAdmin(
      request(app)
        .put(`/workspaces/${WORKSPACE_ID}/log-settings`)
        .send({ runtimeRetentionDays: -1 }),
    );
    expect(res.status).toBe(400);
  });

  it("does not accept traceSampleRate as a settable field (item 3a)", async () => {
    mockDb.query
      .mockResolvedValueOnce(adminMembershipRow)
      .mockResolvedValueOnce({ rows: [] }) // current settings read
      .mockResolvedValueOnce({
        rows: [
          {
            runtime_retention_days: 30,
            trace_retention_days: 30,
            gateway_logs_enabled: true,
            traces_enabled: false,
            trace_sample_rate: 1.0,
          },
        ],
      }); // upsert RETURNING

    const res = await asAdmin(
      request(app)
        .put(`/workspaces/${WORKSPACE_ID}/log-settings`)
        .send({ traceSampleRate: 0.1 }),
    );
    expect(res.status).toBe(200);
    // Column default (1.0) survives untouched — the request body's
    // traceSampleRate is simply ignored, not applied.
    expect(res.body.traceSampleRate).toBe(1.0);
    const upsertCall = mockDb.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO workspace_log_settings"),
    );
    const insertColumnsAndSetClause = upsertCall[0].split("RETURNING")[0];
    expect(insertColumnsAndSetClause).not.toMatch(/trace_sample_rate/);
  });

  it("upserts retention/enablement and logs an audit event", async () => {
    mockDb.query
      .mockResolvedValueOnce(adminMembershipRow)
      .mockResolvedValueOnce({ rows: [] }) // current settings read (defaults)
      .mockResolvedValueOnce({
        rows: [
          {
            runtime_retention_days: 14,
            trace_retention_days: 14,
            gateway_logs_enabled: false,
            traces_enabled: false,
            trace_sample_rate: 1.0,
          },
        ],
      }); // upsert RETURNING

    const res = await asAdmin(
      request(app).put(`/workspaces/${WORKSPACE_ID}/log-settings`).send({
        runtimeRetentionDays: 14,
        traceRetentionDays: 14,
        gatewayLogsEnabled: false,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runtimeRetentionDays: 14,
      traceRetentionDays: 14,
      gatewayLogsEnabled: false,
      tracesEnabled: false,
      traceSampleRate: 1.0,
    });
    expect(mockLogEvent).toHaveBeenCalledWith(
      "workspace_log_settings_updated",
      expect.any(String),
      expect.objectContaining({ workspace: { id: WORKSPACE_ID } }),
    );
    // tracesEnabled did not change (stayed false) — no immediate tracing apply.
    expect(mockApplyTracingConfig).not.toHaveBeenCalled();
  });

  it("immediately applies tracing config to the workspace's running agents when tracesEnabled toggles on", async () => {
    mockDb.query
      .mockResolvedValueOnce(adminMembershipRow)
      .mockResolvedValueOnce({ rows: [] }) // current settings read: traces_enabled defaults false
      .mockResolvedValueOnce({
        rows: [
          {
            runtime_retention_days: 30,
            trace_retention_days: 30,
            gateway_logs_enabled: true,
            traces_enabled: true,
            trace_sample_rate: 1.0,
          },
        ],
      }) // upsert RETURNING
      .mockResolvedValueOnce({
        rows: [
          { id: "agent-1", runtime_family: "openclaw", status: "running", container_id: "c-1" },
        ],
      }); // workspace's running agents

    const res = await asAdmin(
      request(app).put(`/workspaces/${WORKSPACE_ID}/log-settings`).send({ tracesEnabled: true }),
    );

    expect(res.status).toBe(200);
    expect(res.body.tracesEnabled).toBe(true);
    expect(mockApplyTracingConfig).toHaveBeenCalledTimes(1);
    expect(mockApplyTracingConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.anything(),
      { forceCapabilityCheck: true },
    );
  });

  it("does not fail the settings update when applying tracing config to an agent throws", async () => {
    mockDb.query
      .mockResolvedValueOnce(adminMembershipRow)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            runtime_retention_days: 30,
            trace_retention_days: 30,
            gateway_logs_enabled: true,
            traces_enabled: true,
            trace_sample_rate: 1.0,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "agent-1", runtime_family: "openclaw", status: "running", container_id: "c-1" },
        ],
      });
    mockApplyTracingConfig.mockRejectedValueOnce(new Error("agent unreachable"));

    const res = await asAdmin(
      request(app).put(`/workspaces/${WORKSPACE_ID}/log-settings`).send({ tracesEnabled: true }),
    );

    expect(res.status).toBe(200);
  });
});
