// @ts-nocheck
const { EventEmitter } = require("events");

const mockDb = { query: jest.fn() };
const mockLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockLockClient);
const mockEnsureEncryptionConfigured = jest.fn();
const mockDecrypt = jest.fn((value) =>
  typeof value === "string" && value.startsWith("enc(") ? value.slice(4, -1) : value,
);

jest.mock("../db", () => mockDb);
jest.mock("pg", () => ({ Client: mockPgClient }));
jest.mock("../lib/connectionConfig", () => ({
  buildPostgresConfig: jest.fn().mockReturnValue({}),
}));
jest.mock("../crypto", () => ({
  encrypt: (value) => (value ? `enc(${value})` : value),
  decrypt: (...args) => mockDecrypt(...args),
  ensureEncryptionConfigured: (...args) => mockEnsureEncryptionConfigured(...args),
}));

// Configurable ssh2 fake. Each test sets `sshScenario` before calling testRemoteHost.
let sshScenario = null;

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }
}

class FakeSshClient extends EventEmitter {
  connect(config) {
    const scenario = sshScenario || { type: "connect-error", message: "no scenario configured" };
    process.nextTick(() => {
      // Mimic ssh2: run hostVerifier with the presented key; reject on false.
      if (config && typeof config.hostVerifier === "function" && scenario.hostKey !== undefined) {
        const accepted = config.hostVerifier(Buffer.from(scenario.hostKey));
        if (!accepted) {
          this.emit("error", new Error("host key verification failed"));
          return;
        }
      }
      if (scenario.type === "connect-error") {
        this.emit("error", new Error(scenario.message || "connection refused"));
        return;
      }
      this.emit("ready");
    });
    return this;
  }
  exec(command, cb) {
    const scenario = sshScenario || {};
    this.lastCommand = command;
    if (scenario.execError) {
      process.nextTick(() => cb(new Error(scenario.execError)));
      return this;
    }
    const stream = new FakeStream();
    process.nextTick(() => {
      cb(null, stream);
      if (scenario.hangExecStream) return;
      const emitResult = () => {
        if (scenario.stdout) stream.emit("data", Buffer.from(scenario.stdout));
        if (scenario.stderr) stream.stderr.emit("data", Buffer.from(scenario.stderr));
        stream.emit("close", scenario.code ?? 0);
      };
      if (scenario.probeGate) {
        Promise.resolve(scenario.probeGate).then(() => process.nextTick(emitResult));
      } else {
        process.nextTick(emitResult);
      }
    });
    return this;
  }
  end() {}
}

jest.mock("ssh2", () => ({ Client: FakeSshClient }));

const remoteHosts = require("../remoteHosts");
const originalPlatformMode = process.env.PLATFORM_MODE;
const EXPECTED_OWNER = Object.freeze({ expectedOwnerUserId: "user-1" });

function remoteHostRow(overrides = {}) {
  return {
    id: "my-laptop",
    owner_user_id: "user-1",
    label: "My Laptop",
    enabled: true,
    is_default: true,
    ssh_host: "100.64.0.5",
    ssh_port: 22,
    ssh_user: "operator",
    ssh_auth_mode: "key",
    ssh_private_key_encrypted: "enc(PRIVATE-KEY)",
    ssh_password_encrypted: null,
    ssh_passphrase_encrypted: null,
    gateway_host: "",
    docker_host: "",
    ssh_host_key: Buffer.from("HOSTKEY-BYTES").toString("base64"),
    last_test_status: "ok",
    last_test_message: "Docker 24.0.7 is reachable over SSH at operator@100.64.0.5.",
    last_tested_at: "2026-06-15T00:00:00.000Z",
    created_at: "2026-06-15T00:00:00.000Z",
    updated_at: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function installTwoOperationLock({ beforeSecondAcquire = null } = {}) {
  const allowSecondAcquire = deferred();
  const events = [];
  const firstClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes("pg_try_advisory_lock")) {
        events.push("first-lock");
        return { rows: [{ locked: true }] };
      }
      if (text.includes("pg_advisory_unlock")) {
        events.push("first-unlock");
        beforeSecondAcquire?.();
        allowSecondAcquire.resolve();
      }
      return { rows: [] };
    }),
    end: jest.fn().mockResolvedValue(undefined),
  };
  const secondClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes("pg_try_advisory_lock")) {
        events.push("second-lock-wait");
        await allowSecondAcquire.promise;
        events.push("second-lock");
        return { rows: [{ locked: true }] };
      }
      if (text.includes("pg_advisory_unlock")) events.push("second-unlock");
      return { rows: [] };
    }),
    end: jest.fn().mockResolvedValue(undefined),
  };
  mockPgClient.mockImplementationOnce(() => firstClient).mockImplementationOnce(() => secondClient);
  return { events };
}

function installMutableRemoteHostRow(initialRow) {
  let row = { ...initialRow };
  const operations = [];
  mockDb.query.mockImplementation(async (sql, params = []) => {
    const text = String(sql);
    if (text === "SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2") {
      operations.push("select");
      return {
        rows: row && row.owner_user_id === params[1] ? [{ ...row }] : [],
      };
    }
    if (text.includes("ssh_host_key = COALESCE(ssh_host_key, $4)")) {
      operations.push("test-update");
      if (!row || row.owner_user_id !== params[4]) return { rows: [] };
      row.last_test_status = params[1];
      row.last_test_message = params[2];
      if (!row.ssh_host_key && params[3]) row.ssh_host_key = params[3];
      return { rows: [{ ...row }] };
    }
    if (text.includes("SET ssh_host_key = NULL")) {
      operations.push("reset-update");
      if (!row || row.owner_user_id !== params[1]) return { rows: [] };
      row.ssh_host_key = null;
      row.last_test_status = null;
      row.last_test_message = null;
      row.last_tested_at = null;
      return { rows: [{ ...row }] };
    }
    if (text.includes("SET label = $2")) {
      operations.push("edit-update");
      if (!row || row.owner_user_id !== params[16]) return { rows: [] };
      row = {
        ...row,
        label: params[1],
        owner_user_id: params[2],
        enabled: params[3],
        is_default: params[4],
        ssh_host: params[5],
        ssh_port: params[6],
        ssh_user: params[7],
        ssh_auth_mode: params[8],
        ssh_private_key_encrypted: params[9],
        ssh_password_encrypted: params[10],
        ssh_passphrase_encrypted: params[11],
        gateway_host: params[12],
        docker_host: params[13],
      };
      if (params[14]) {
        row.last_test_status = null;
        row.last_test_message = null;
        row.last_tested_at = null;
      }
      if (params[15]) row.ssh_host_key = null;
      return { rows: [{ ...row }] };
    }
    if (text.includes("SELECT COUNT(*)::int AS count FROM agents")) {
      operations.push("delete-usage");
      return { rows: [{ count: 0 }] };
    }
    if (
      text.includes("INSERT INTO remote_host_id_tombstones") &&
      text.includes("DELETE FROM remote_hosts")
    ) {
      operations.push("delete");
      if (!row || row.owner_user_id !== params[1]) return { rows: [] };
      const deleted = row;
      row = null;
      return { rows: deleted ? [{ ...deleted }] : [] };
    }
    throw new Error(`Unexpected remote host query in concurrency test: ${text}`);
  });
  return {
    operations,
    current: () => (row ? { ...row } : null),
  };
}

beforeEach(() => {
  process.env.PLATFORM_MODE = "selfhosted";
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
  mockEnsureEncryptionConfigured.mockReset();
  mockDecrypt.mockClear();
  sshScenario = null;
});

afterAll(() => {
  if (originalPlatformMode === undefined) delete process.env.PLATFORM_MODE;
  else process.env.PLATFORM_MODE = originalPlatformMode;
});

describe("rowToProfile", () => {
  it("masks SSH secrets by default and reports presence flags", () => {
    const masked = remoteHosts.rowToProfile(remoteHostRow());
    expect(masked.sshPrivateKey).toBeNull();
    expect(masked.executionTargetId).toBe("remote:my-laptop");
    expect(masked.available).toBe(true);
    expect(masked.gatewayHost).toBe("100.64.0.5"); // falls back to ssh_host
  });

  it("decrypts SSH secrets only when includeSecret is set", () => {
    const profile = remoteHosts.rowToProfile(remoteHostRow(), { includeSecret: true });
    expect(profile.sshPrivateKey).toBe("PRIVATE-KEY");
  });

  it("surfaces a configuration issue when the credential is missing", () => {
    const profile = remoteHosts.rowToProfile(
      remoteHostRow({ ssh_private_key_encrypted: null, last_test_status: null }),
    );
    expect(profile.configured).toBe(false);
    expect(profile.available).toBe(false);
    expect(profile.issue).toMatch(/private key/i);
  });

  it("fails closed for a legacy successful Test row without a captured host-key pin", () => {
    const profile = remoteHosts.rowToProfile(
      remoteHostRow({ ssh_host_key: null, last_test_status: "ok" }),
    );

    expect(profile.configured).toBe(true);
    expect(profile.connected).toBe(false);
    expect(profile.available).toBe(false);
    expect(profile.issue).toMatch(/Test again.*pin/i);
  });
});

describe("getRemoteHostCleanupProfile", () => {
  it("keeps ordinary profile/use blocked in PaaS while resolving exact-target cleanup", async () => {
    process.env.PLATFORM_MODE = "paas";
    const agent = {
      id: "agent-cleanup",
      user_id: "user-1",
      deploy_target: "remote-docker",
      execution_target_id: "remote:my-laptop",
      backend_type: "remote-docker",
    };

    expect(await remoteHosts.getRemoteHostProfile(agent.execution_target_id)).toBeNull();
    await expect(remoteHosts.assertRemoteHostAgentUse(agent)).rejects.toMatchObject({
      statusCode: 403,
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();

    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    const profile = await remoteHosts.getRemoteHostCleanupProfile(agent);

    expect(profile.executionTargetId).toBe("remote:my-laptop");
    expect(profile.sshHost).toBe("100.64.0.5");
    expect(profile.sshPrivateKey).toBe("PRIVATE-KEY");
    expect(mockDb.query).toHaveBeenCalledWith("SELECT * FROM remote_hosts WHERE id = $1", [
      "my-laptop",
    ]);
  });

  it("rejects cleanup without an explicit exact remote execution target", async () => {
    await expect(
      remoteHosts.getRemoteHostCleanupProfile({
        deploy_target: "remote-docker",
        backend_type: "remote-docker",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_HOST_CLEANUP_TARGET_INVALID", statusCode: 409 });
    await expect(
      remoteHosts.getRemoteHostCleanupProfile({
        deploy_target: "remote-docker",
        execution_target_id: "remote:my-laptop/../other",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_HOST_CLEANUP_TARGET_INVALID", statusCode: 409 });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("fails closed before decrypting if the registry row identity does not match", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ id: "different-host" })] });

    await expect(
      remoteHosts.getRemoteHostCleanupProfile({
        execution_target_id: "remote:my-laptop",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_HOST_CLEANUP_TARGET_INVALID", statusCode: 409 });
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("preserves the pinned SSH host key on cleanup profiles", async () => {
    const pinned = Buffer.from("ORIGINAL-KEY").toString("base64");
    mockDb.query.mockResolvedValueOnce({
      rows: [
        remoteHostRow({
          ssh_host_key: pinned,
          last_test_status: "failed",
          last_test_message: "Remote host key does not match the pinned key",
        }),
      ],
    });

    const profile = await remoteHosts.getRemoteHostCleanupProfile({
      execution_target_id: "remote:my-laptop",
    });

    expect(profile.sshHostKey).toBe(pinned);
  });

  it.each([
    ["a legacy successful Test row", { ssh_host_key: null, last_test_status: "ok" }],
    [
      "the explicit pin-reset state",
      {
        ssh_host_key: null,
        last_test_status: null,
        last_test_message: null,
        last_tested_at: null,
      },
    ],
  ])("refuses pinless cleanup for %s and surfaces orphan risk", async (_case, overrides) => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow(overrides)] });

    await expect(
      remoteHosts.getRemoteHostCleanupProfile({
        execution_target_id: "remote:my-laptop",
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_HOST_CLEANUP_PIN_REQUIRED",
      statusCode: 409,
      orphanRisk: true,
      message: expect.stringMatching(/runtime may still be running/i),
    });
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});

describe("createRemoteHost", () => {
  it("encrypts the SSH private key and enforces encryption config", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] }); // INSERT ... RETURNING
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // clear other defaults

    await remoteHosts.createRemoteHost({
      id: "My Laptop",
      ownerUserId: "user-1",
      sshHost: "100.64.0.5",
      sshUser: "operator",
      sshPrivateKey: "PRIVATE-KEY",
      isDefault: true,
    });

    expect(mockEnsureEncryptionConfigured).toHaveBeenCalled();
    const insert = mockDb.query.mock.calls[0];
    expect(insert[0]).toMatch(/INSERT INTO remote_hosts/);
    expect(insert[1][0]).toBe("my-laptop"); // slugified id
    expect(insert[1][9]).toBe("enc(PRIVATE-KEY)"); // ssh_private_key_encrypted
  });

  it("refuses to store a new secret when encryption is not configured", async () => {
    mockEnsureEncryptionConfigured.mockImplementation(() => {
      const err = new Error("ENCRYPTION_KEY required");
      err.statusCode = 503;
      throw err;
    });
    await expect(
      remoteHosts.createRemoteHost({
        id: "h1",
        ownerUserId: "user-1",
        sshHost: "h",
        sshUser: "u",
        sshPassword: "pw",
      }),
    ).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("disables Remote Docker registration in hosted mode", async () => {
    process.env.PLATFORM_MODE = "paas";

    await expect(
      remoteHosts.createRemoteHost({
        id: "internal-pivot",
        ownerUserId: "user-1",
        sshHost: "127.0.0.1",
        sshUser: "operator",
        sshPrivateKey: "PRIVATE-KEY",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_HOSTS_DISABLED_IN_PAAS", statusCode: 403 });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockPgClient).not.toHaveBeenCalled();
  });
});

describe("updateRemoteHost", () => {
  it("clears the prior test result when connection inputs change", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host: "10.0.0.9" })] }); // UPDATE

    await remoteHosts.updateRemoteHost("my-laptop", { sshHost: "10.0.0.9" }, EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[0]).toMatch(/UPDATE remote_hosts/);
    expect(update[1][14]).toBe(true); // resetTest flag → wipes last_test_*
    expect(update[1][15]).toBe(true); // SSH host identity changed → clear pin
    expect(update[0]).toMatch(/ssh_host_key = CASE WHEN \$16 THEN NULL ELSE ssh_host_key END/);
    expect(update[0]).toMatch(/owner_user_id = \$17/);
    expect(update[1][16]).toBe("user-1");
  });

  it("keeps the prior test result when only the label changes", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ label: "Renamed" })] });

    await remoteHosts.updateRemoteHost("my-laptop", { label: "Renamed" }, EXPECTED_OWNER);

    expect(mockDb.query.mock.calls[1][1][14]).toBe(false);
  });

  it("requires a retest after credential rotation but preserves the SSH host-key pin", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host_key: "pinned-key" })] });
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_private_key_encrypted: "enc(NEW-KEY)", last_test_status: null })],
    });

    await remoteHosts.updateRemoteHost("my-laptop", { sshPrivateKey: "NEW-KEY" }, EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[1][14]).toBe(true);
    expect(update[1][15]).toBe(false);
  });

  it("requires a retest when the advertised gateway address changes", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ gateway_host: "gateway.example.com", last_test_status: null })],
    });

    await remoteHosts.updateRemoteHost(
      "my-laptop",
      { gatewayHost: "gateway.example.com" },
      EXPECTED_OWNER,
    );

    expect(mockDb.query.mock.calls[1][1][14]).toBe(true);
    expect(mockDb.query.mock.calls[1][1][15]).toBe(false);
  });
});

describe("remote host mutation lock", () => {
  it("bounds lock acquisition instead of waiting indefinitely", async () => {
    const previousTimeout = process.env.REMOTE_HOST_MUTATION_LOCK_TIMEOUT_MS;
    process.env.REMOTE_HOST_MUTATION_LOCK_TIMEOUT_MS = "1";
    const busyClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [{ locked: false }] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    mockPgClient.mockImplementationOnce(() => busyClient);

    try {
      await expect(
        remoteHosts.updateRemoteHost("my-laptop", { label: "Still waiting" }, EXPECTED_OWNER),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "REMOTE_HOST_MUTATION_LOCK_TIMEOUT",
      });
    } finally {
      if (previousTimeout === undefined) delete process.env.REMOTE_HOST_MUTATION_LOCK_TIMEOUT_MS;
      else process.env.REMOTE_HOST_MUTATION_LOCK_TIMEOUT_MS = previousTimeout;
    }

    expect(mockDb.query).not.toHaveBeenCalled();
    expect(busyClient.end).toHaveBeenCalledTimes(1);
  });

  it("serializes deletion and permanently rejects recreation of the retired host id", async () => {
    const allowDelete = deferred();
    const lock = installTwoOperationLock();
    let row = remoteHostRow({ is_default: false, owner_user_id: "user-1" });
    let retired = false;
    const operations = [];
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = String(sql);
      if (text === "SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2") {
        operations.push(`select:${params[1]}`);
        return { rows: row && row.owner_user_id === params[1] ? [{ ...row }] : [] };
      }
      if (text.includes("SELECT COUNT(*)::int AS count FROM agents")) {
        operations.push("delete-usage");
        await allowDelete.promise;
        return { rows: [{ count: 0 }] };
      }
      if (
        text.includes("INSERT INTO remote_host_id_tombstones") &&
        text.includes("DELETE FROM remote_hosts")
      ) {
        operations.push(`delete:${params[1]}`);
        const deleted = row;
        row = null;
        retired = true;
        return { rows: deleted ? [{ ...deleted }] : [] };
      }
      if (text.includes("INSERT INTO remote_hosts")) {
        operations.push(`create:${params[1]}`);
        if (retired) return { rows: [] };
        row = remoteHostRow({
          id: params[0],
          owner_user_id: params[1],
          label: params[2],
          is_default: params[4],
          ssh_host: params[5],
          ssh_port: params[6],
          ssh_user: params[7],
          ssh_auth_mode: params[8],
          ssh_private_key_encrypted: params[9],
          ssh_password_encrypted: params[10],
          ssh_passphrase_encrypted: params[11],
          gateway_host: params[12],
          docker_host: params[13],
          ssh_host_key: null,
          last_test_status: null,
        });
        return { rows: [{ ...row }] };
      }
      throw new Error(`Unexpected delete/recreate race query: ${text}`);
    });

    const deletion = remoteHosts.deleteRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    const recreation = remoteHosts.createRemoteHost({
      id: "my-laptop",
      ownerUserId: "user-2",
      label: "Replacement host",
      sshHost: "100.64.0.9",
      sshUser: "operator",
      sshPrivateKey: "REPLACEMENT-KEY",
    });
    await flushAsyncWork();

    expect(lock.events).toContain("second-lock-wait");
    expect(operations).toEqual(["select:user-1", "delete-usage"]);

    allowDelete.resolve();
    await expect(deletion).resolves.toMatchObject({ ownerUserId: "user-1" });
    await expect(recreation).rejects.toMatchObject({
      statusCode: 409,
      code: "REMOTE_HOST_ID_RETIRED",
    });

    await expect(
      remoteHosts.updateRemoteHost("my-laptop", { label: "Stale owner edit" }, EXPECTED_OWNER),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      remoteHosts.shareRemoteHost("my-laptop", "workspace-1", "user-1"),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(row).toBeNull();
    expect(operations).toEqual([
      "select:user-1",
      "delete-usage",
      "delete:user-1",
      "create:user-2",
      "select:user-1",
      "select:user-1",
    ]);
  });
});

describe("resetRemoteHostHostKeyPin", () => {
  it("clears only the pin and prior Test state after an exact label confirmation", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_host_key: "pinned-key" })],
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        remoteHostRow({
          ssh_host_key: null,
          last_test_status: null,
          last_test_message: null,
          last_tested_at: null,
        }),
      ],
    });

    const host = await remoteHosts.resetRemoteHostHostKeyPin(
      "my-laptop",
      "My Laptop",
      EXPECTED_OWNER,
    );

    const update = mockDb.query.mock.calls[1];
    expect(update[0]).toMatch(/ssh_host_key = NULL/);
    expect(update[0]).toMatch(/last_test_status = NULL/);
    expect(update[0]).toMatch(/last_test_message = NULL/);
    expect(update[0]).toMatch(/last_tested_at = NULL/);
    expect(update[0]).not.toMatch(/ssh_private_key_encrypted|ssh_password_encrypted/);
    expect(update[0]).toMatch(/owner_user_id = \$2/);
    expect(update[1]).toEqual(["my-laptop", "user-1"]);
    expect(host.connected).toBe(false);
    expect(host.available).toBe(false);
    expect(host.hasSshPrivateKey).toBe(true);
  });

  it("keeps active use blocked until a fresh Test succeeds", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        remoteHostRow({
          ssh_host_key: null,
          last_test_status: null,
          last_test_message: null,
          last_tested_at: null,
        }),
      ],
    });

    await expect(
      remoteHosts.assertRemoteHostAgentUse(
        {
          user_id: "user-1",
          deploy_target: "remote-docker",
          execution_target_id: "remote:my-laptop",
        },
        { includeProfile: false },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "REMOTE_HOST_RETEST_REQUIRED" });
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("also accepts the exact host id as confirmation", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host_key: "pinned-key" })] });
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_host_key: null, last_test_status: null })],
    });

    await expect(
      remoteHosts.resetRemoteHostHostKeyPin("my-laptop", "my-laptop", EXPECTED_OWNER),
    ).resolves.toMatchObject({ id: "my-laptop", connected: false });
  });

  it("rejects a missing or mismatched confirmation without changing the host", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host_key: "pinned-key" })] });

    await expect(
      remoteHosts.resetRemoteHostHostKeyPin("my-laptop", "another-host", EXPECTED_OWNER),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "REMOTE_HOST_PIN_RESET_CONFIRMATION_INVALID",
    });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("keeps host-key pin reset disabled in hosted mode", async () => {
    process.env.PLATFORM_MODE = "paas";

    await expect(
      remoteHosts.resetRemoteHostHostKeyPin("my-laptop", "My Laptop", EXPECTED_OWNER),
    ).rejects.toMatchObject({ code: "REMOTE_HOSTS_DISABLED_IN_PAAS", statusCode: 403 });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("deleteRemoteHost", () => {
  it("refuses to delete a host that agents still reference", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: 2 }] });
    await expect(remoteHosts.deleteRemoteHost("my-laptop", EXPECTED_OWNER)).rejects.toThrow(
      /agents still reference it/,
    );
    expect(mockDb.query).toHaveBeenCalledTimes(2); // never reached the DELETE
  });

  it("deletes a host with no referencing agents", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    const deleted = await remoteHosts.deleteRemoteHost("my-laptop", EXPECTED_OWNER);
    expect(deleted.id).toBe("my-laptop");
    expect(mockDb.query.mock.calls[2][0]).toMatch(/DELETE FROM remote_hosts/);
    expect(mockDb.query.mock.calls[2][0]).toMatch(/owner_user_id = \$2/);
  });
});

describe("testRemoteHost", () => {
  it("records a success with the reported Docker version", async () => {
    sshScenario = {
      type: "ready",
      stdout: "24.0.7\n",
      code: 0,
      hostKey: "HOSTKEY-BYTES",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ last_test_status: "ok" })],
    }); // UPDATE

    const host = await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    expect(host.lastTestStatus).toBe("ok");
    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("ok");
    expect(update[1][2]).toMatch(/Docker 24\.0\.7 is reachable over SSH at operator@100\.64\.0\.5/);
    expect(update[0]).toMatch(/owner_user_id = \$5/);
    expect(update[1][4]).toBe("user-1");
  });

  it("refuses to mark the host trusted when the SSH key cannot be captured", async () => {
    sshScenario = { type: "ready", stdout: "24.0.7\n", code: 0 };
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_host_key: null, last_test_status: null })],
    });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/could not verify and pin/i);
    expect(update[1][3]).toBeNull();
  });

  it("records a failure when SSH cannot connect", async () => {
    sshScenario = { type: "connect-error", message: "Timed out while waiting for handshake" };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/Timed out while waiting for handshake/);
  });

  it("records a failure when Docker is missing on the host", async () => {
    sshScenario = { type: "ready", stderr: "bash: docker: command not found\n", code: 127 };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/command not found/);
  });

  it("times out when SSH connects but the Docker probe never completes", async () => {
    sshScenario = {
      type: "ready",
      hostKey: "HOSTKEY-BYTES",
      hangExecStream: true,
    };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    const host = await remoteHosts.testRemoteHost("my-laptop", {
      ...EXPECTED_OWNER,
      timeoutMs: 10,
    });

    expect(host.lastTestStatus).toBe("failed");
    const update = mockDb.query.mock.calls[1];
    expect(update[1][2]).toMatch(/probe timed out after 10ms/i);
  });

  it("fails fast without SSH when the host is unconfigured", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_private_key_encrypted: null, last_test_status: null })],
    });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    expect(mockDb.query.mock.calls[1][1][1]).toBe("failed");
    expect(mockDb.query.mock.calls[1][1][2]).toMatch(/private key/i);
  });

  it("pins the SSH host key on first successful test (trust-on-first-use)", async () => {
    sshScenario = { type: "ready", stdout: "24.0.7\n", code: 0, hostKey: "HOSTKEY-BYTES" };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host_key: null })] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] }); // UPDATE

    await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("ok");
    // 4th param is the captured host key (base64) persisted via COALESCE.
    expect(update[1][3]).toBe(Buffer.from("HOSTKEY-BYTES").toString("base64"));
  });

  it("fails the test when the host key no longer matches the pin (MITM guard)", async () => {
    const pinned = Buffer.from("ORIGINAL-KEY").toString("base64");
    sshScenario = { type: "ready", stdout: "24.0.7\n", code: 0, hostKey: "ATTACKER-KEY" };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host_key: pinned })] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] }); // UPDATE

    await remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/host key does not match|man-in-the-middle/i);
    // The pin is NOT overwritten on mismatch.
    expect(update[1][3]).toBeNull();
  });

  it("serializes an explicit pin reset behind an in-flight Test", async () => {
    const probeGate = deferred();
    sshScenario = {
      type: "ready",
      stdout: "24.0.7\n",
      code: 0,
      hostKey: "FIRST-TRUSTED-KEY",
      probeGate: probeGate.promise,
    };
    const store = installMutableRemoteHostRow(
      remoteHostRow({ is_default: false, ssh_host_key: null, last_test_status: null }),
    );
    const lock = installTwoOperationLock();

    const testPromise = remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    const resetPromise = remoteHosts.resetRemoteHostHostKeyPin(
      "my-laptop",
      "My Laptop",
      EXPECTED_OWNER,
    );
    await flushAsyncWork();

    expect(store.operations).toEqual(["select"]);
    expect(lock.events).toContain("second-lock-wait");

    probeGate.resolve();
    const [tested, reset] = await Promise.all([testPromise, resetPromise]);

    expect(tested.lastTestStatus).toBe("ok");
    expect(reset.lastTestStatus).toBeNull();
    expect(store.operations).toEqual(["select", "test-update", "select", "reset-update"]);
    expect(store.current()).toMatchObject({ ssh_host_key: null, last_test_status: null });
  });

  it("serializes an SSH identity edit behind an in-flight Test", async () => {
    const probeGate = deferred();
    sshScenario = {
      type: "ready",
      stdout: "24.0.7\n",
      code: 0,
      hostKey: "OLD-HOST-KEY",
      probeGate: probeGate.promise,
    };
    const store = installMutableRemoteHostRow(
      remoteHostRow({ is_default: false, ssh_host_key: null, last_test_status: null }),
    );
    installTwoOperationLock();

    const testPromise = remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    const editPromise = remoteHosts.updateRemoteHost(
      "my-laptop",
      {
        ownerUserId: "user-1",
        sshHost: "100.64.0.6",
      },
      EXPECTED_OWNER,
    );
    await flushAsyncWork();
    expect(store.operations).toEqual(["select"]);

    probeGate.resolve();
    const [, edited] = await Promise.all([testPromise, editPromise]);

    expect(edited.sshHost).toBe("100.64.0.6");
    expect(edited.lastTestStatus).toBeNull();
    expect(store.operations).toEqual(["select", "test-update", "select", "edit-update"]);
    expect(store.current()).toMatchObject({
      ssh_host: "100.64.0.6",
      ssh_host_key: null,
      last_test_status: null,
    });
  });

  it("serializes deletion behind an in-flight Test so no status publishes after delete", async () => {
    const probeGate = deferred();
    sshScenario = {
      type: "ready",
      stdout: "24.0.7\n",
      code: 0,
      hostKey: "HOST-BEING-DELETED",
      probeGate: probeGate.promise,
    };
    const store = installMutableRemoteHostRow(
      remoteHostRow({ is_default: false, ssh_host_key: null, last_test_status: null }),
    );
    installTwoOperationLock();

    const testPromise = remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    const deletePromise = remoteHosts.deleteRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    expect(store.operations).toEqual(["select"]);

    probeGate.resolve();
    const [, deleted] = await Promise.all([testPromise, deletePromise]);

    expect(deleted.id).toBe("my-laptop");
    expect(store.operations).toEqual(["select", "test-update", "select", "delete-usage", "delete"]);
    expect(store.current()).toBeNull();
  });

  it("serializes concurrent TOFU probes so a different second key cannot be accepted", async () => {
    const firstProbeGate = deferred();
    sshScenario = {
      type: "ready",
      stdout: "24.0.7\n",
      code: 0,
      hostKey: "FIRST-TRUSTED-KEY",
      probeGate: firstProbeGate.promise,
    };
    const store = installMutableRemoteHostRow(
      remoteHostRow({ is_default: false, ssh_host_key: null, last_test_status: null }),
    );
    installTwoOperationLock({
      beforeSecondAcquire: () => {
        sshScenario = {
          type: "ready",
          stdout: "24.0.8\n",
          code: 0,
          hostKey: "DIFFERENT-SECOND-KEY",
        };
      },
    });

    const firstTest = remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    const secondTest = remoteHosts.testRemoteHost("my-laptop", EXPECTED_OWNER);
    await flushAsyncWork();
    expect(store.operations).toEqual(["select"]);

    firstProbeGate.resolve();
    const [firstResult, secondResult] = await Promise.all([firstTest, secondTest]);

    expect(firstResult.lastTestStatus).toBe("ok");
    expect(secondResult.lastTestStatus).toBe("failed");
    expect(secondResult.lastTestMessage).toMatch(/host key does not match|man-in-the-middle/i);
    expect(store.operations).toEqual(["select", "test-update", "select", "test-update"]);
    expect(store.current().ssh_host_key).toBe(Buffer.from("FIRST-TRUSTED-KEY").toString("base64"));
  });
});

describe("assertRemoteHostExecutionTargetAvailable", () => {
  it("ignores non-remote deploy targets", async () => {
    expect(
      await remoteHosts.assertRemoteHostExecutionTargetAvailable({ deploy_target: "docker" }),
    ).toBeNull();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects a remote deploy with no registered host target", async () => {
    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable({ deploy_target: "remote-docker" }),
    ).rejects.toThrow(/registered host target/);
  });

  it("rejects an unknown host target", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable({
        deploy_target: "remote-docker",
        execution_target_id: "remote:ghost",
      }),
    ).rejects.toThrow(/Unknown remote host/);
  });

  it("rejects a host that has not passed its connection test", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ last_test_status: null })],
    });
    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable({
        deploy_target: "remote-docker",
        execution_target_id: "remote:my-laptop",
      }),
    ).rejects.toThrow(/connection test/);
  });

  it("returns the profile for an available host", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    const profile = await remoteHosts.assertRemoteHostExecutionTargetAvailable({
      deploy_target: "remote-docker",
      execution_target_id: "remote:my-laptop",
    });
    expect(profile.id).toBe("my-laptop");
    expect(profile.available).toBe(true);
  });

  it("rejects a host registered by a different operator with no grant (owner-scoped)", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable(
        { deploy_target: "remote-docker", execution_target_id: "remote:my-laptop" },
        { ownerUserId: "user-2" },
      ),
    ).rejects.toThrow(/Unknown remote host/i);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("allows a non-owner who has an editor+ grant via a shared workspace (C3)", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    const profile = await remoteHosts.assertRemoteHostExecutionTargetAvailable(
      { deploy_target: "remote-docker", execution_target_id: "remote:my-laptop" },
      { ownerUserId: "user-2" },
    );
    expect(profile.id).toBe("my-laptop");
  });

  it("fails closed on a null-owner (orphaned) host — requires a grant, never short-circuits", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable(
        { deploy_target: "remote-docker", execution_target_id: "remote:my-laptop" },
        { ownerUserId: "user-1" },
      ),
    ).rejects.toThrow(/Unknown remote host/i);
  });

  it("allows a host owned by the requesting operator", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    const profile = await remoteHosts.assertRemoteHostExecutionTargetAvailable(
      { deploy_target: "remote-docker", execution_target_id: "remote:my-laptop" },
      { ownerUserId: "user-1" },
    );
    expect(profile.id).toBe("my-laptop");
  });

  it("rejects a legacy successful Test row that has no host-key pin", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_host_key: null, last_test_status: "ok" })],
    });

    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable({
        deploy_target: "remote-docker",
        execution_target_id: "remote:my-laptop",
      }),
    ).rejects.toThrow(/Test again.*pin/i);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});

describe("listRemoteHostExecutionTargets", () => {
  it("returns only deployable accessible hosts for the requesting user", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        remoteHostRow({ id: "ready-host", __access: "owned", __can_deploy: true }),
        remoteHostRow({
          id: "broken-host",
          last_test_status: "failed",
          __access: "owned",
          __can_deploy: true,
        }),
      ],
    });
    const targets = await remoteHosts.listRemoteHostExecutionTargets({ ownerUserId: "user-1" });
    expect(targets.map((t) => t.id)).toEqual(["ready-host"]);
    const select = mockDb.query.mock.calls[0];
    expect(select[0]).toMatch(/remote_host_user_grants/);
    expect(select[0]).toMatch(/user_group_members/);
    expect(select[1]).toEqual(["user-1", ["editor", "admin", "owner"]]);
  });

  it("returns an empty list when the table has not been migrated yet", async () => {
    const undefinedTable = new Error('relation "remote_hosts" does not exist');
    undefinedTable.code = "42P01";
    mockDb.query.mockRejectedValueOnce(undefinedTable);
    expect(await remoteHosts.listRemoteHostExecutionTargets()).toEqual([]);
  });
});
