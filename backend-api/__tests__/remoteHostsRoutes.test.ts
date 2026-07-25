// @ts-nocheck
/**
 * __tests__/remoteHostsRoutes.test.ts — operator + admin remote-host routes.
 * Mocks the remoteHosts registry so we assert routing, per-owner scoping, and
 * ownership enforcement without standing up Postgres.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
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
  logEvent: jest.fn().mockResolvedValue(undefined),
  getMetrics: jest.fn().mockResolvedValue({}),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  enforceLimits: jest.fn().mockResolvedValue({ allowed: true }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
}));

const mockRemoteHosts = {
  listRemoteHosts: jest.fn(),
  listAdminRemoteHosts: jest.fn(),
  getAdminRemoteHost: jest.fn(),
  listAccessibleRemoteHosts: jest.fn().mockResolvedValue([]),
  createPlatformRemoteHost: jest.fn(),
  createRemoteHost: jest.fn(),
  updatePlatformRemoteHost: jest.fn(),
  updateRemoteHost: jest.fn(),
  deletePlatformRemoteHost: jest.fn(),
  deleteRemoteHost: jest.fn(),
  testPlatformRemoteHost: jest.fn(),
  testRemoteHost: jest.fn(),
  resetPlatformRemoteHostHostKeyPin: jest.fn(),
  listPlatformRemoteHostAccess: jest.fn(),
  replacePlatformRemoteHostAccess: jest.fn(),
  getRemoteHost: jest.fn(),
  shareRemoteHost: jest.fn().mockResolvedValue(undefined),
  unshareRemoteHost: jest.fn().mockResolvedValue(undefined),
  listRemoteHostShares: jest.fn().mockResolvedValue([]),
  // imported elsewhere (worker/containerManager); stubbed so server boot is happy
  getRemoteHostProfile: jest.fn(),
  isRemoteDockerTarget: jest.fn(),
  listRemoteHostExecutionTargets: jest.fn().mockResolvedValue([]),
};
jest.mock("../remoteHosts", () => mockRemoteHosts);

const mockUserGroups = {
  listUserGroups: jest.fn(),
  createUserGroup: jest.fn(),
  updateUserGroup: jest.fn(),
  deleteUserGroup: jest.fn(),
  listUserGroupMembers: jest.fn(),
  replaceUserGroupMembers: jest.fn(),
};
jest.mock("../userGroups", () => mockUserGroups);

const app = require("../server");
const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const otherToken = jwt.sign({ id: "user-2", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const adminToken = jwt.sign({ id: "admin-1", role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

beforeEach(() => {
  for (const fn of Object.values(mockRemoteHosts)) {
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  for (const fn of Object.values(mockUserGroups)) {
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  mockRemoteHosts.listRemoteHostExecutionTargets.mockResolvedValue([]);
});

describe("operator remote-host routes", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/remote-hosts");
    expect(res.status).toBe(401);
  });

  it("lists hosts the caller can access (owned + shared)", async () => {
    mockRemoteHosts.listAccessibleRemoteHosts.mockResolvedValue([
      { id: "my-laptop", ownerUserId: "user-1", access: "owned", canDeploy: true },
      { id: "team-vps", ownerUserId: "user-2", access: "shared", canDeploy: true },
    ]);
    const res = await auth(request(app).get("/remote-hosts"), userToken);
    expect(res.status).toBe(200);
    expect(mockRemoteHosts.listAccessibleRemoteHosts).toHaveBeenCalledWith("user-1");
    expect(res.body.map((h) => h.id)).toEqual(["my-laptop", "team-vps"]);
  });

  it("creates a host owned by the caller", async () => {
    mockRemoteHosts.createRemoteHost.mockResolvedValue({
      id: "vps-1",
      label: "VPS",
      ownerUserId: "user-1",
    });
    const res = await auth(request(app).post("/remote-hosts"), userToken).send({
      id: "vps-1",
      sshHost: "1.2.3.4",
      sshUser: "root",
      sshPrivateKey: "KEY",
    });
    expect(res.status).toBe(201);
    expect(mockRemoteHosts.createRemoteHost).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user-1", sshHost: "1.2.3.4" }),
    );
  });

  it("updates a host the caller owns", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    mockRemoteHosts.updateRemoteHost.mockResolvedValue({ id: "vps-1", label: "Renamed" });
    const res = await auth(request(app).put("/remote-hosts/vps-1"), userToken).send({
      label: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(mockRemoteHosts.updateRemoteHost).toHaveBeenCalledWith(
      "vps-1",
      expect.objectContaining({ ownerUserId: "user-1", label: "Renamed" }),
      { expectedOwnerUserId: "user-1" },
    );
  });

  it("returns 404 (not 403) when mutating another operator's host", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(request(app).delete("/remote-hosts/vps-1"), userToken);
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.deleteRemoteHost).not.toHaveBeenCalled();
  });

  it("binds deletion to the authenticated owner inside the locked helper", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({
      id: "vps-1",
      ownerUserId: "user-1",
      label: "VPS",
    });
    mockRemoteHosts.deleteRemoteHost.mockResolvedValue({
      id: "vps-1",
      ownerUserId: "user-1",
      label: "VPS",
    });

    const res = await auth(request(app).delete("/remote-hosts/vps-1"), userToken);

    expect(res.status).toBe(200);
    expect(mockRemoteHosts.deleteRemoteHost).toHaveBeenCalledWith("vps-1", {
      expectedOwnerUserId: "user-1",
    });
  });

  it("returns 404 when testing a host that does not exist", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue(null);
    const res = await auth(request(app).post("/remote-hosts/ghost/test"), userToken);
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.testRemoteHost).not.toHaveBeenCalled();
  });

  it("tests a host the caller owns", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({
      id: "vps-1",
      ownerUserId: "user-1",
      label: "VPS",
    });
    mockRemoteHosts.testRemoteHost.mockResolvedValue({ id: "vps-1", lastTestStatus: "ok" });
    const res = await auth(request(app).post("/remote-hosts/vps-1/test"), userToken);
    expect(res.status).toBe(200);
    expect(res.body.lastTestStatus).toBe("ok");
    expect(mockRemoteHosts.testRemoteHost).toHaveBeenCalledWith("vps-1", {
      expectedOwnerUserId: "user-1",
    });
  });

  it("rejects sharing a host the caller does not own (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(
      request(app).post("/remote-hosts/vps-1/shares").send({ workspace_id: "ws-1" }),
      userToken,
    );
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.shareRemoteHost).not.toHaveBeenCalled();
  });

  it("rejects a share with no workspace_id (400)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    const res = await auth(request(app).post("/remote-hosts/vps-1/shares").send({}), userToken);
    expect(res.status).toBe(400);
    expect(mockRemoteHosts.shareRemoteHost).not.toHaveBeenCalled();
  });

  it("lists a host's workspace shares (owner only)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    mockRemoteHosts.listRemoteHostShares.mockResolvedValue([
      { workspaceId: "ws-1", workspaceName: "Team" },
    ]);
    const res = await auth(request(app).get("/remote-hosts/vps-1/shares"), userToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ workspaceId: "ws-1", workspaceName: "Team" }]);
    expect(mockRemoteHosts.listRemoteHostShares).toHaveBeenCalledWith("vps-1", {
      expectedOwnerUserId: "user-1",
    });
  });

  it("rejects listing shares for a host the caller does not own (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(request(app).get("/remote-hosts/vps-1/shares"), userToken);
    expect(res.status).toBe(404);
  });

  it("rejects unsharing for a host the caller does not own (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(request(app).delete("/remote-hosts/vps-1/shares/ws-1"), userToken);
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.unshareRemoteHost).not.toHaveBeenCalled();
  });

  it("binds unshare and the resulting share list to the authenticated owner", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    mockRemoteHosts.unshareRemoteHost.mockResolvedValue(undefined);
    mockRemoteHosts.listRemoteHostShares.mockResolvedValue([]);

    const res = await auth(request(app).delete("/remote-hosts/vps-1/shares/ws-1"), userToken);

    expect(res.status).toBe(200);
    expect(mockRemoteHosts.unshareRemoteHost).toHaveBeenCalledWith("vps-1", "ws-1", "user-1");
    expect(mockRemoteHosts.listRemoteHostShares).toHaveBeenCalledWith("vps-1", {
      expectedOwnerUserId: "user-1",
    });
  });

  it("rejects sharing into a workspace the owner is not a member of (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    mockRemoteHosts.shareRemoteHost.mockRejectedValue(
      Object.assign(new Error("Workspace not found"), { statusCode: 404 }),
    );
    const res = await auth(
      request(app).post("/remote-hosts/vps-1/shares").send({ workspace_id: "ws-x" }),
      userToken,
    );
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.shareRemoteHost).toHaveBeenCalledWith("vps-1", "ws-x", "user-1");
  });

  it("shares through the owner-bound helper and returns the refreshed share list", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({
      id: "vps-1",
      ownerUserId: "user-1",
      label: "VPS",
    });
    mockRemoteHosts.shareRemoteHost.mockResolvedValue({
      workspaceId: "ws-1",
      workspaceName: "Team",
      inserted: true,
    });
    mockRemoteHosts.listRemoteHostShares.mockResolvedValue([
      { workspaceId: "ws-1", workspaceName: "Team" },
    ]);

    const res = await auth(
      request(app).post("/remote-hosts/vps-1/shares").send({ workspace_id: "ws-1" }),
      userToken,
    );

    expect(res.status).toBe(201);
    expect(mockRemoteHosts.shareRemoteHost).toHaveBeenCalledWith("vps-1", "ws-1", "user-1");
    expect(mockRemoteHosts.listRemoteHostShares).toHaveBeenCalledWith("vps-1", {
      expectedOwnerUserId: "user-1",
    });
    expect(res.body).toEqual([{ workspaceId: "ws-1", workspaceName: "Team" }]);
  });
});

describe("admin remote-host fleet view", () => {
  it("lists every operator's hosts for an admin", async () => {
    mockRemoteHosts.listAdminRemoteHosts.mockResolvedValue([
      { id: "a", ownerUserId: "user-1" },
      { id: "b", ownerUserId: "user-2" },
    ]);
    const res = await auth(request(app).get("/admin/remote-hosts"), adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockRemoteHosts.listAdminRemoteHosts).toHaveBeenCalledWith();
  });

  it("forbids a non-admin from the fleet view", async () => {
    const res = await auth(request(app).get("/admin/remote-hosts"), otherToken);
    expect(res.status).toBe(403);
  });

  it("creates platform hosts with the authenticated admin as creator", async () => {
    mockRemoteHosts.createPlatformRemoteHost.mockResolvedValue({
      id: "shared-vps",
      label: "Shared VPS",
      managementScope: "platform",
      ownerUserId: null,
      createdByUserId: "admin-1",
    });
    const res = await auth(request(app).post("/admin/remote-hosts"), adminToken).send({
      id: "shared-vps",
      label: "Shared VPS",
      sshHost: "10.0.0.10",
      sshUser: "nora",
      sshPrivateKey: "PRIVATE",
    });
    expect(res.status).toBe(201);
    expect(mockRemoteHosts.createPlatformRemoteHost).toHaveBeenCalledWith(
      expect.objectContaining({ id: "shared-vps", sshPrivateKey: "PRIVATE" }),
      "admin-1",
    );
    expect(res.body).toEqual(
      expect.objectContaining({ managementScope: "platform", ownerUserId: null }),
    );
  });

  it("returns a masked personal host detail but does not route it through a platform mutation", async () => {
    mockRemoteHosts.getAdminRemoteHost.mockResolvedValue({
      id: "personal-vps",
      managementScope: "user",
      ownerUserId: "user-1",
      hasSshPrivateKey: true,
    });
    const detail = await auth(request(app).get("/admin/remote-hosts/personal-vps"), adminToken);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(
      expect.objectContaining({ managementScope: "user", ownerUserId: "user-1" }),
    );
    expect(detail.body).not.toHaveProperty("sshHost");
    expect(detail.body).not.toHaveProperty("lastTestMessage");

    mockRemoteHosts.updatePlatformRemoteHost.mockRejectedValue(
      Object.assign(new Error("Remote host not found"), { statusCode: 404 }),
    );
    const update = await auth(
      request(app).put("/admin/remote-hosts/personal-vps").send({ label: "Nope" }),
      adminToken,
    );
    expect(update.status).toBe(404);
    expect(mockRemoteHosts.updateRemoteHost).not.toHaveBeenCalled();
  });

  it("replaces platform host access with the exact users/groups/workspaces contract", async () => {
    const access = {
      version: 2,
      availableToAll: false,
      users: [{ userId: "11111111-1111-4111-8111-111111111111", email: "u@nora.test", name: "U" }],
      groups: [{ groupId: "22222222-2222-4222-8222-222222222222", name: "Builders" }],
      workspaces: [{ workspaceId: "33333333-3333-4333-8333-333333333333", name: "Core" }],
    };
    mockRemoteHosts.replacePlatformRemoteHostAccess.mockResolvedValue(access);
    const body = {
      expectedVersion: 1,
      availableToAll: false,
      users: ["11111111-1111-4111-8111-111111111111"],
      groups: ["22222222-2222-4222-8222-222222222222"],
      workspaces: ["33333333-3333-4333-8333-333333333333"],
    };
    const res = await auth(
      request(app).put("/admin/remote-hosts/shared-vps/access").send(body),
      adminToken,
    );
    expect(res.status).toBe(200);
    expect(mockRemoteHosts.replacePlatformRemoteHostAccess).toHaveBeenCalledWith(
      "shared-vps",
      body,
      "admin-1",
    );
    expect(res.body).toEqual(access);
  });

  it("returns the optimistic access version on reads", async () => {
    mockRemoteHosts.listPlatformRemoteHostAccess.mockResolvedValue({
      version: 4,
      availableToAll: true,
      users: [],
      groups: [],
      workspaces: [],
    });
    const res = await auth(request(app).get("/admin/remote-hosts/shared-vps/access"), adminToken);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(4);
  });

  it("preserves in-use deletion conflicts", async () => {
    mockRemoteHosts.deletePlatformRemoteHost.mockRejectedValue(
      Object.assign(new Error("Cannot delete a remote host while agents still reference it"), {
        statusCode: 409,
        code: "REMOTE_HOST_IN_USE",
      }),
    );
    const res = await auth(request(app).delete("/admin/remote-hosts/shared-vps"), adminToken);
    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "Cannot delete a remote host while agents still reference it",
        code: "REMOTE_HOST_IN_USE",
      }),
    );
    expect(mockRemoteHosts.deletePlatformRemoteHost).toHaveBeenCalledWith("shared-vps", {
      deletedByUserId: "admin-1",
    });
  });
});

describe("admin user-group routes", () => {
  const groupId = "22222222-2222-4222-8222-222222222222";
  const userId = "11111111-1111-4111-8111-111111111111";

  it("uses the stable list/create/update contracts", async () => {
    mockUserGroups.listUserGroups.mockResolvedValue([
      { id: groupId, name: "Builders", memberCount: 1, membersVersion: 3 },
    ]);
    let res = await auth(request(app).get("/admin/user-groups"), adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: groupId, name: "Builders", memberCount: 1, membersVersion: 3 },
    ]);

    mockUserGroups.createUserGroup.mockResolvedValue({
      id: groupId,
      name: "Builders",
      memberCount: 0,
      membersVersion: 1,
    });
    res = await auth(request(app).post("/admin/user-groups"), adminToken).send({
      name: "Builders",
    });
    expect(res.status).toBe(201);
    expect(mockUserGroups.createUserGroup).toHaveBeenCalledWith({ name: "Builders" }, "admin-1");

    mockUserGroups.updateUserGroup.mockResolvedValue({
      id: groupId,
      name: "Operators",
      memberCount: 0,
      membersVersion: 1,
    });
    res = await auth(request(app).put(`/admin/user-groups/${groupId}`), adminToken).send({
      name: "Operators",
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Operators");
  });

  it("replaces members from a users array and returns enriched users", async () => {
    const members = [{ userId, email: "member@nora.test", name: "Member" }];
    mockUserGroups.replaceUserGroupMembers.mockResolvedValue({ version: 2, members });
    const res = await auth(
      request(app)
        .put(`/admin/user-groups/${groupId}/members`)
        .send({ expectedVersion: 1, users: [userId] }),
      adminToken,
    );
    expect(res.status).toBe(200);
    expect(mockUserGroups.replaceUserGroupMembers).toHaveBeenCalledWith(
      groupId,
      [userId],
      1,
      "admin-1",
    );
    expect(res.body).toEqual({ version: 2, members });
  });

  it("returns the member version on reads", async () => {
    const members = [{ userId, email: "member@nora.test", name: "Member" }];
    mockUserGroups.listUserGroupMembers.mockResolvedValue({ version: 6, members });
    const res = await auth(request(app).get(`/admin/user-groups/${groupId}/members`), adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 6, members });
  });
});
