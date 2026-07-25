// @ts-nocheck
// BYOC C3: workspace-shared remote hosts. Verifies userCanUseRemoteHost (the
// positive grant check that widens the owner-only deploy/reach gates) and the
// share/unshare helpers.
const mockDb = { query: jest.fn() };
const mockLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockLockClient);
jest.mock("../db", () => mockDb);
jest.mock("pg", () => ({ Client: mockPgClient }));
jest.mock("../lib/connectionConfig", () => ({
  buildPostgresConfig: jest.fn().mockReturnValue({}),
}));
jest.mock("../crypto", () => ({
  encrypt: (v) => v,
  decrypt: (v) => v,
  ensureEncryptionConfigured: jest.fn(),
}));

const {
  assertRemoteHostAgentUse,
  isRemoteDockerAgent,
  userCanUseRemoteHost,
  shareRemoteHost,
  unshareRemoteHost,
} = require("../remoteHosts");

const hostRow = (owner = "host-owner") => ({
  id: "host-1",
  owner_user_id: owner,
  label: "Build host",
  enabled: true,
  is_default: false,
  ssh_host: "100.64.0.5",
  ssh_port: 22,
  ssh_user: "operator",
  ssh_auth_mode: "key",
  ssh_private_key_encrypted: "encrypted-key",
  ssh_password_encrypted: null,
  ssh_passphrase_encrypted: null,
  gateway_host: "100.64.0.5",
  docker_host: "",
  ssh_host_key: "pinned-key",
  last_test_status: "ok",
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockPgClient.mockClear();
  mockLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockLockClient.query.mockReset().mockImplementation(async (sql) => {
    if (String(sql).includes("pg_try_advisory_lock")) {
      return { rows: [{ locked: true }] };
    }
    return { rows: [] };
  });
  mockLockClient.end.mockReset().mockResolvedValue(undefined);
});

// Return the authoritative row snapshot produced by the combined grant query.
function fakeAccess({ owned = false, sharedEditorPlus = false, grantsTableMissing = false } = {}) {
  let platformQueryAttempted = false;
  mockDb.query.mockImplementation(async (sql) => {
    const text = String(sql);
    if (/SELECT rh\.\*/.test(text)) {
      if (grantsTableMissing && !platformQueryAttempted && /management_scope/.test(text)) {
        platformQueryAttempted = true;
        const err = new Error('relation "workspace_remote_hosts" does not exist');
        err.code = "42P01";
        throw err;
      }
      return { rows: owned || sharedEditorPlus ? [hostRow(owned ? "user-1" : "host-owner")] : [] };
    }
    return { rows: [] };
  });
}

describe("userCanUseRemoteHost", () => {
  it("allows the host owner", async () => {
    fakeAccess({ owned: true });
    expect(await userCanUseRemoteHost("user-1", "host-1")).toBe(true);
    // Authorization and row loading are deliberately one query.
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("allows an editor+ member of a workspace the host is shared into", async () => {
    fakeAccess({ owned: false, sharedEditorPlus: true });
    expect(await userCanUseRemoteHost("user-2", "host-1")).toBe(true);
    const grantCall = mockDb.query.mock.calls.find((c) => /workspace_remote_hosts/.test(c[0]));
    expect(grantCall[0]).toMatch(/wm\.role = ANY/);
    expect(grantCall[1]).toEqual(["host-1", "user-2", ["editor", "admin", "owner"]]);
  });

  it("denies a user with no ownership and no qualifying grant (e.g. viewer-only)", async () => {
    fakeAccess({ owned: false, sharedEditorPlus: false });
    expect(await userCanUseRemoteHost("user-3", "host-1")).toBe(false);
  });

  it("denies when the grants table has not been migrated yet", async () => {
    fakeAccess({ owned: false, grantsTableMissing: true });
    expect(await userCanUseRemoteHost("user-4", "host-1")).toBe(false);
  });

  it("denies without a userId or hostId (no query)", async () => {
    fakeAccess();
    expect(await userCanUseRemoteHost("", "host-1")).toBe(false);
    expect(await userCanUseRemoteHost("user-1", "")).toBe(false);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("assertRemoteHostAgentUse", () => {
  const remoteAgent = (userId = "user-2") => ({
    user_id: userId,
    deploy_target: "remote-docker",
    execution_target_id: "remote:host-1",
  });

  it("allows the host owner and returns the decrypted runtime profile", async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT rh\.\*/.test(sql)) return { rows: [hostRow("user-1")] };
      return { rows: [] };
    });

    const profile = await assertRemoteHostAgentUse(remoteAgent("user-1"));

    expect(profile).toEqual(
      expect.objectContaining({ id: "host-1", ownerUserId: "user-1", configured: true }),
    );
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("allows an editor+ workspace grant", async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT rh\.\*/.test(sql)) return { rows: [hostRow()] };
      return { rows: [] };
    });

    await expect(assertRemoteHostAgentUse(remoteAgent())).resolves.toEqual(
      expect.objectContaining({ id: "host-1" }),
    );
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[0][0]).toMatch(/OR EXISTS/);
  });

  it("fails before decrypting a profile when the current grant was revoked", async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT rh\.\*/.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    await expect(assertRemoteHostAgentUse(remoteAgent())).rejects.toMatchObject({
      statusCode: 403,
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["global", "rh.available_to_all = true"],
    ["direct user", "remote_host_user_grants"],
    ["user group", "remote_host_group_grants"],
    ["current platform admin", "actor.role = 'admin'"],
  ])(
    "authorizes a platform host through the %s grant in the authoritative query",
    async (_kind, sqlFragment) => {
      mockDb.query.mockImplementation(async (sql) => {
        expect(String(sql)).toContain(sqlFragment);
        return {
          rows: [hostRow(null)].map((row) => ({
            ...row,
            management_scope: "platform",
            owner_user_id: null,
            available_to_all: sqlFragment.includes("available_to_all"),
          })),
        };
      });

      await expect(assertRemoteHostAgentUse(remoteAgent("user-2"))).resolves.toEqual(
        expect.objectContaining({
          id: "host-1",
          managementScope: "platform",
          ownerUserId: null,
        }),
      );
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    },
  );

  it("uses one authorized row snapshot instead of reloading a recreated host id", async () => {
    const releaseAuthorizedRow = deferred();
    const authorizedQueryStarted = deferred();
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT rh\.\*/.test(sql)) {
        authorizedQueryStarted.resolve();
        await releaseAuthorizedRow.promise;
        return {
          rows: [
            {
              ...hostRow("user-1"),
              ssh_private_key_encrypted: "former-owner-key",
            },
          ],
        };
      }
      return {
        rows: [
          {
            ...hostRow("user-2"),
            ssh_private_key_encrypted: "replacement-owner-key",
          },
        ],
      };
    });

    const authorization = assertRemoteHostAgentUse(remoteAgent("user-1"));
    await authorizedQueryStarted.promise;
    releaseAuthorizedRow.resolve();

    await expect(authorization).resolves.toMatchObject({
      ownerUserId: "user-1",
      sshPrivateKey: "former-owner-key",
    });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for non-Remote-Docker agents", async () => {
    await expect(
      assertRemoteHostAgentUse({
        user_id: "user-1",
        deploy_target: "docker",
        execution_target_id: "docker",
      }),
    ).resolves.toBeNull();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("recognizes legacy or partially normalized Remote Docker placement fields", () => {
    expect(
      isRemoteDockerAgent({
        deploy_target: "",
        backend_type: "remote-docker",
        execution_target_id: "remote:host-1",
      }),
    ).toBe(true);
    expect(isRemoteDockerAgent({ execution_target_id: "remote:host-1" })).toBe(true);
    expect(isRemoteDockerAgent({ deploy_target: "docker", backend_type: "docker" })).toBe(false);
  });
});

describe("shareRemoteHost / unshareRemoteHost", () => {
  it("inserts a workspace share idempotently", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hostRow("user-1")] });
    mockDb.query.mockResolvedValueOnce({
      rows: [{ workspaceId: "ws-1", workspaceName: "Team", inserted: true }],
    });
    await expect(shareRemoteHost("host-1", "ws-1", "user-1")).resolves.toMatchObject({
      workspaceId: "ws-1",
      workspaceName: "Team",
    });
    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO workspace_remote_hosts/);
    expect(sql).toMatch(/rh\.owner_user_id = \$3/);
    expect(sql).toMatch(/JOIN workspace_members wm/);
    expect(sql).toMatch(/wm\.user_id = \$3/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, remote_host_id\) DO NOTHING/);
    expect(params).toEqual(["ws-1", "host-1", "user-1"]);
  });

  it("rejects sharing when workspace membership is revoked while waiting for the host lock", async () => {
    const lockAttempted = deferred();
    const allowLock = deferred();
    let membershipActive = true;
    mockLockClient.query.mockImplementation(async (sql) => {
      if (String(sql).includes("pg_try_advisory_lock")) {
        lockAttempted.resolve();
        await allowLock.promise;
        return { rows: [{ locked: true }] };
      }
      return { rows: [] };
    });
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text === "SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2") {
        return { rows: [hostRow("user-1")] };
      }
      if (text.includes("INSERT INTO workspace_remote_hosts")) {
        return {
          rows: membershipActive
            ? [{ workspaceId: "ws-1", workspaceName: "Team", inserted: true }]
            : [],
        };
      }
      return { rows: [] };
    });

    const sharing = shareRemoteHost("host-1", "ws-1", "user-1");
    await lockAttempted.promise;
    membershipActive = false;
    allowLock.resolve();

    await expect(sharing).rejects.toMatchObject({ statusCode: 404 });
    const shareSql = mockDb.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO workspace_remote_hosts"),
    )?.[0];
    expect(shareSql).toMatch(/JOIN workspace_members wm/);
    expect(shareSql).toMatch(/wm\.user_id = \$3/);
  });

  it("deletes a workspace share", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hostRow("user-1")] });
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await unshareRemoteHost("host-1", "ws-1", "user-1");
    const [sql, params] = mockDb.query.mock.calls[1];
    expect(sql).toMatch(/DELETE FROM workspace_remote_hosts/);
    expect(sql).toMatch(/rh\.owner_user_id = \$3/);
    expect(params).toEqual(["host-1", "ws-1", "user-1"]);
  });

  it.each([
    ["share", () => shareRemoteHost("host-1", "ws-1", "former-owner")],
    ["unshare", () => unshareRemoteHost("host-1", "ws-1", "former-owner")],
  ])("rejects a stale %s request after the host id changes owner", async (_operation, run) => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    await expect(run()).rejects.toMatchObject({ statusCode: 404 });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2",
      ["host-1", "former-owner"],
    );
  });
});
