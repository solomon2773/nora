// @ts-nocheck
const fs = require("fs");
const path = require("path");

const mockDb = { query: jest.fn(), connect: jest.fn() };
const mockLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockLockClient);

jest.mock("../db", () => mockDb);
jest.mock("pg", () => ({ Client: mockPgClient }));
jest.mock("../lib/connectionConfig", () => ({ buildPostgresConfig: jest.fn(() => ({})) }));
jest.mock("../crypto", () => ({
  encrypt: (value) => `enc(${value})`,
  decrypt: (value) => String(value).replace(/^enc\(|\)$/g, ""),
  ensureEncryptionConfigured: jest.fn(),
}));

const remoteHosts = require("../remoteHosts");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const originalMode = process.env.PLATFORM_MODE;

function hostRow(overrides = {}) {
  return {
    id: "shared-vps",
    management_scope: "platform",
    owner_user_id: null,
    created_by_user_id: ADMIN_ID,
    available_to_all: false,
    label: "Shared VPS",
    enabled: true,
    is_default: false,
    ssh_host: "10.0.0.10",
    ssh_port: 22,
    ssh_user: "nora",
    ssh_auth_mode: "key",
    ssh_private_key_encrypted: "enc(PRIVATE)",
    ssh_password_encrypted: null,
    ssh_passphrase_encrypted: null,
    gateway_host: "10.0.0.10",
    docker_host: "",
    ssh_host_key: "pinned-key",
    last_test_status: "ok",
    last_test_message: "ok",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.PLATFORM_MODE = "selfhosted";
  mockDb.query.mockReset();
  mockDb.connect.mockReset();
  mockPgClient.mockClear();
  mockLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockLockClient.query.mockReset().mockImplementation(async (sql) => {
    if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    return { rows: [] };
  });
  mockLockClient.end.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  if (originalMode === undefined) delete process.env.PLATFORM_MODE;
  else process.env.PLATFORM_MODE = originalMode;
});

describe("platform Remote Host registry", () => {
  it("creates an ownerless platform row and returns only masked credential metadata", async () => {
    mockDb.query.mockImplementation(async (sql, params) => {
      expect(String(sql)).toMatch(/management_scope, owner_user_id, created_by_user_id/);
      expect(params[1]).toBe(ADMIN_ID);
      return { rows: [hostRow()] };
    });

    const host = await remoteHosts.createPlatformRemoteHost(
      {
        id: "shared-vps",
        label: "Shared VPS",
        availableToAll: true,
        sshHost: "10.0.0.10",
        sshUser: "nora",
        sshPrivateKey: "PRIVATE",
      },
      ADMIN_ID,
    );
    expect(mockDb.query.mock.calls[0][0]).toMatch(/SELECT \$1, 'platform', NULL, \$2, false/);

    expect(host).toEqual(
      expect.objectContaining({
        managementScope: "platform",
        ownerUserId: null,
        createdByUserId: ADMIN_ID,
        hasSshPrivateKey: true,
        availableToAll: false,
      }),
    );
    expect(host.sshPrivateKey).toBeUndefined();
  });

  it("never lets owner/operator helpers mutate a platform row even if corrupt data has an owner", async () => {
    mockDb.query.mockResolvedValue({
      rows: [hostRow({ owner_user_id: USER_ID })],
    });
    await expect(
      remoteHosts.updateRemoteHost(
        "shared-vps",
        { label: "Operator takeover" },
        { expectedOwnerUserId: USER_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("keeps masked admin list/detail readable in PaaS while mutations remain denied", async () => {
    process.env.PLATFORM_MODE = "paas";
    mockDb.query.mockResolvedValue({
      rows: [
        hostRow({
          owner_email: null,
          created_by_email: "admin@nora.test",
          created_by_name: "Admin",
        }),
      ],
    });

    const list = await remoteHosts.listAdminRemoteHosts();
    expect(list[0]).toEqual(
      expect.objectContaining({
        managementScope: "platform",
        createdByEmail: "admin@nora.test",
        hasSshPrivateKey: true,
      }),
    );
    expect(list[0].sshPrivateKey).toBeUndefined();

    await expect(
      remoteHosts.createPlatformRemoteHost({ id: "blocked-host" }, ADMIN_ID),
    ).rejects.toMatchObject({ statusCode: 403, code: "REMOTE_HOSTS_DISABLED_IN_PAAS" });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("server-redacts personal endpoint details while retaining coarse fleet status", async () => {
    mockDb.query.mockResolvedValue({
      rows: [
        hostRow({
          management_scope: "user",
          owner_user_id: USER_ID,
          owner_email: "owner@nora.test",
        }),
      ],
    });
    const [host] = await remoteHosts.listAdminRemoteHosts();
    expect(host).toEqual(
      expect.objectContaining({
        managementScope: "user",
        ownerEmail: "owner@nora.test",
        configured: true,
        connected: true,
        available: true,
        lastTestStatus: "ok",
      }),
    );
    for (const field of [
      "sshHost",
      "sshPort",
      "sshUser",
      "sshAuthMode",
      "gatewayHost",
      "dockerHost",
      "sshHostKey",
      "issue",
      "lastTestMessage",
      "hasSshPrivateKey",
      "hasSshPassword",
      "hasSshPassphrase",
    ]) {
      expect(host).not.toHaveProperty(field);
    }
  });

  it("marks only personal ownership as owned and keeps workspace viewers read-only", async () => {
    mockDb.query.mockResolvedValue({
      rows: [
        hostRow({
          id: "personal",
          management_scope: "user",
          owner_user_id: USER_ID,
          __access: "owned",
          __can_deploy: true,
        }),
        hostRow({ id: "global", __access: "global", __can_deploy: true }),
        hostRow({ id: "workspace-viewer", __access: "shared", __can_deploy: false }),
      ],
    });

    const hosts = await remoteHosts.listAccessibleRemoteHosts(USER_ID);
    expect(
      hosts.map(({ id, access, canDeploy, managementScope }) => ({
        id,
        access,
        canDeploy,
        managementScope,
      })),
    ).toEqual([
      { id: "personal", access: "owned", canDeploy: true, managementScope: "user" },
      { id: "global", access: "global", canDeploy: true, managementScope: "platform" },
      {
        id: "workspace-viewer",
        access: "shared",
        canDeploy: false,
        managementScope: "platform",
      },
    ]);
    expect(hosts.filter((host) => host.managementScope === "platform")).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ access: "owned" })]),
    );
  });

  it("reads access and its version from one repeatable-read snapshot", async () => {
    const client = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(text)) {
          return { rows: [] };
        }
        if (text === "COMMIT") return { rows: [] };
        if (/FROM remote_hosts/.test(text)) return { rows: [hostRow({ access_version: 7 })] };
        if (/remote_host_user_grants grant_row/.test(text)) return { rows: [] };
        if (/remote_host_group_grants grant_row/.test(text)) return { rows: [] };
        if (/workspace_remote_hosts grant_row/.test(text)) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockDb.connect.mockResolvedValue(client);

    await expect(remoteHosts.listPlatformRemoteHostAccess("shared-vps")).resolves.toEqual({
      version: 7,
      availableToAll: false,
      users: [],
      groups: [],
      workspaces: [],
    });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("atomically replaces direct, group, and workspace grants", async () => {
    const transactionClient = {
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql);
        if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
        if (/FROM remote_hosts/.test(text) && /FOR UPDATE/.test(text)) {
          return { rows: [hostRow()] };
        }
        if (/SELECT id FROM users/.test(text)) return { rows: [{ id: USER_ID }] };
        if (/SELECT id FROM user_groups/.test(text)) return { rows: [{ id: GROUP_ID }] };
        if (/SELECT id FROM workspaces/.test(text)) return { rows: [{ id: WORKSPACE_ID }] };
        if (/UPDATE remote_hosts/.test(text)) {
          return { rows: [hostRow({ access_version: 2 })] };
        }
        if (/remote_host_user_grants grant_row/.test(text)) {
          return { rows: [{ userId: USER_ID, email: "user@nora.test", name: "User" }] };
        }
        if (/remote_host_group_grants grant_row/.test(text)) {
          return { rows: [{ groupId: GROUP_ID, name: "Builders" }] };
        }
        if (/workspace_remote_hosts grant_row/.test(text)) {
          return { rows: [{ workspaceId: WORKSPACE_ID, name: "Core" }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockDb.connect.mockResolvedValue(transactionClient);
    const access = await remoteHosts.replacePlatformRemoteHostAccess(
      "shared-vps",
      {
        expectedVersion: 1,
        availableToAll: false,
        users: [USER_ID],
        groups: [GROUP_ID],
        workspaces: [WORKSPACE_ID],
      },
      ADMIN_ID,
    );

    expect(access).toEqual({
      version: 2,
      availableToAll: false,
      users: [{ userId: USER_ID, email: "user@nora.test", name: "User" }],
      groups: [{ groupId: GROUP_ID, name: "Builders" }],
      workspaces: [{ workspaceId: WORKSPACE_ID, name: "Core" }],
    });
    const statements = transactionClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toEqual(
      expect.arrayContaining([
        "BEGIN",
        "DELETE FROM remote_host_user_grants WHERE remote_host_id = $1",
        "DELETE FROM remote_host_group_grants WHERE remote_host_id = $1",
        "DELETE FROM workspace_remote_hosts WHERE remote_host_id = $1",
        expect.stringContaining("INSERT INTO remote_host_user_grants"),
        expect.stringContaining("INSERT INTO remote_host_group_grants"),
        expect.stringContaining("INSERT INTO workspace_remote_hosts"),
        "COMMIT",
      ]),
    );
    expect(transactionClient.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back grant replacement before revoking current access when validation fails", async () => {
    const transactionClient = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (/FROM remote_hosts/.test(text)) return { rows: [hostRow()] };
        if (/SELECT id FROM users/.test(text)) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockDb.connect.mockResolvedValue(transactionClient);

    await expect(
      remoteHosts.replacePlatformRemoteHostAccess(
        "shared-vps",
        { expectedVersion: 1, users: [USER_ID], groups: [], workspaces: [] },
        ADMIN_ID,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "REMOTE_HOST_ACCESS_PRINCIPAL_NOT_FOUND",
    });
    expect(
      transactionClient.query.mock.calls.some(([sql]) =>
        String(sql).startsWith("DELETE FROM remote_host_user_grants"),
      ),
    ).toBe(false);
    expect(transactionClient.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects a stale access replacement before validating or revoking grants", async () => {
    const transactionClient = {
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (/FROM remote_hosts/.test(text)) return { rows: [hostRow({ access_version: 3 })] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockDb.connect.mockResolvedValue(transactionClient);

    await expect(
      remoteHosts.replacePlatformRemoteHostAccess(
        "shared-vps",
        { expectedVersion: 2, availableToAll: true, users: [], groups: [], workspaces: [] },
        ADMIN_ID,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "REMOTE_HOST_ACCESS_VERSION_CONFLICT",
    });
    expect(
      transactionClient.query.mock.calls.some(([sql]) => String(sql).startsWith("DELETE FROM")),
    ).toBe(false);
  });

  it("blocks deleting a platform host while an agent references it", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [hostRow()] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });
    await expect(remoteHosts.deletePlatformRemoteHost("shared-vps")).rejects.toMatchObject({
      statusCode: 409,
      code: "REMOTE_HOST_IN_USE",
    });
    expect(mockDb.query.mock.calls[1][0]).toMatch(/status IS DISTINCT FROM 'deleted'/);
  });

  it("retires a deleted host id so it cannot be recreated with different credentials", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [hostRow()] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [hostRow()] });

    await expect(
      remoteHosts.deletePlatformRemoteHost("shared-vps", { deletedByUserId: ADMIN_ID }),
    ).resolves.toEqual(expect.objectContaining({ id: "shared-vps" }));
    expect(mockDb.query.mock.calls[2][0]).toMatch(/INSERT INTO remote_host_id_tombstones/);
    expect(mockDb.query.mock.calls[2][1]).toEqual(["shared-vps", ADMIN_ID]);

    mockDb.query.mockReset().mockResolvedValue({ rows: [] });
    await expect(
      remoteHosts.createPlatformRemoteHost(
        {
          id: "shared-vps",
          label: "Replacement",
          sshHost: "10.0.0.99",
          sshUser: "nora",
          sshPrivateKey: "NEW",
        },
        ADMIN_ID,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "REMOTE_HOST_ID_RETIRED" });
  });
});

describe("platform Remote Host schema", () => {
  it("keeps creator references non-owning and platform rows ownerless", () => {
    const schema = fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8");
    expect(schema).toMatch(/management_scope TEXT NOT NULL DEFAULT 'user'/);
    expect(schema).toMatch(/owner_user_id UUID REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(schema).toMatch(/created_by_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/);
    expect(schema).toMatch(/management_scope = 'platform' AND owner_user_id IS NULL/);
    expect(schema).toMatch(/access_version BIGINT NOT NULL DEFAULT 1/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS remote_host_id_tombstones/);
    expect(schema).toMatch(/pg_advisory_xact_lock/);
    expect(schema).toMatch(/LOWER\(NEW\.execution_target_id\) LIKE 'remote:%'/);
    expect(schema).toMatch(/BEFORE INSERT OR UPDATE OF execution_target_id, status ON agents/);
    expect(schema).toMatch(/remote_host_id_tombstones WHERE remote_host_id = target_host_id/);
  });

  it("appends the backfill and creator-survival migration at the migration tail", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");
    const smtpTail = server.lastIndexOf("smtp_from_name");
    const platformMigration = server.lastIndexOf("Platform-managed Remote Hosts");
    expect(platformMigration).toBeGreaterThan(smtpTail);
    expect(server.slice(platformMigration)).toMatch(
      /created_by_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/,
    );
    expect(server.slice(platformMigration)).toMatch(
      /created_by_user_id = COALESCE\(created_by_user_id, owner_user_id\)/,
    );
    expect(
      server.match(/CREATE OR REPLACE FUNCTION enforce_remote_host_agent_target\(\)/g) || [],
    ).toHaveLength(1);
    expect(server.slice(platformMigration)).toMatch(/status IS DISTINCT FROM 'deleted'/);
  });
});
