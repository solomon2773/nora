// @ts-nocheck
const { EventEmitter } = require("events");

const mockDb = { query: jest.fn() };
const mockEnsureEncryptionConfigured = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: (value) => (value ? `enc(${value})` : value),
  decrypt: (value) =>
    typeof value === "string" && value.startsWith("enc(") ? value.slice(4, -1) : value,
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
      process.nextTick(() => {
        if (scenario.stdout) stream.emit("data", Buffer.from(scenario.stdout));
        if (scenario.stderr) stream.stderr.emit("data", Buffer.from(scenario.stderr));
        stream.emit("close", scenario.code ?? 0);
      });
    });
    return this;
  }
  end() {}
}

jest.mock("ssh2", () => ({ Client: FakeSshClient }));

const remoteHosts = require("../remoteHosts");

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
    last_test_status: "ok",
    last_test_message: "Docker 24.0.7 is reachable over SSH at operator@100.64.0.5.",
    last_tested_at: "2026-06-15T00:00:00.000Z",
    created_at: "2026-06-15T00:00:00.000Z",
    updated_at: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockEnsureEncryptionConfigured.mockReset();
  sshScenario = null;
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
      remoteHosts.createRemoteHost({ id: "h1", sshHost: "h", sshUser: "u", sshPassword: "pw" }),
    ).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("updateRemoteHost", () => {
  it("clears the prior test result when connection inputs change", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host: "10.0.0.9" })] }); // UPDATE

    await remoteHosts.updateRemoteHost("my-laptop", { sshHost: "10.0.0.9" });

    const update = mockDb.query.mock.calls[1];
    expect(update[0]).toMatch(/UPDATE remote_hosts/);
    expect(update[1][14]).toBe(true); // resetTest flag → wipes last_test_*
    // The host-key pin is also cleared on a connection-input change so the next
    // test re-pins the (now different) host instead of failing as a false MITM.
    expect(update[0]).toMatch(/ssh_host_key = CASE WHEN \$15 THEN NULL ELSE ssh_host_key END/);
  });

  it("keeps the prior test result when only the label changes", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ label: "Renamed" })] });

    await remoteHosts.updateRemoteHost("my-laptop", { label: "Renamed" });

    expect(mockDb.query.mock.calls[1][1][14]).toBe(false);
  });
});

describe("deleteRemoteHost", () => {
  it("refuses to delete a host that agents still reference", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: 2 }] });
    await expect(remoteHosts.deleteRemoteHost("my-laptop")).rejects.toThrow(
      /agents still reference it/,
    );
    expect(mockDb.query).toHaveBeenCalledTimes(1); // never reached the DELETE
  });

  it("deletes a host with no referencing agents", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] });
    const deleted = await remoteHosts.deleteRemoteHost("my-laptop");
    expect(deleted.id).toBe("my-laptop");
    expect(mockDb.query.mock.calls[1][0]).toMatch(/DELETE FROM remote_hosts/);
  });
});

describe("testRemoteHost", () => {
  it("records a success with the reported Docker version", async () => {
    sshScenario = { type: "ready", stdout: "24.0.7\n", code: 0 };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ last_test_status: "ok" })],
    }); // UPDATE

    const host = await remoteHosts.testRemoteHost("my-laptop");

    expect(host.lastTestStatus).toBe("ok");
    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("ok");
    expect(update[1][2]).toMatch(/Docker 24\.0\.7 is reachable over SSH at operator@100\.64\.0\.5/);
  });

  it("records a failure when SSH cannot connect", async () => {
    sshScenario = { type: "connect-error", message: "Timed out while waiting for handshake" };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop");

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/Timed out while waiting for handshake/);
  });

  it("records a failure when Docker is missing on the host", async () => {
    sshScenario = { type: "ready", stderr: "bash: docker: command not found\n", code: 127 };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: null })] });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop");

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/command not found/);
  });

  it("fails fast without SSH when the host is unconfigured", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [remoteHostRow({ ssh_private_key_encrypted: null, last_test_status: null })],
    });
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ last_test_status: "failed" })] });

    await remoteHosts.testRemoteHost("my-laptop");

    expect(mockDb.query.mock.calls[1][1][1]).toBe("failed");
    expect(mockDb.query.mock.calls[1][1][2]).toMatch(/private key/i);
  });

  it("pins the SSH host key on first successful test (trust-on-first-use)", async () => {
    sshScenario = { type: "ready", stdout: "24.0.7\n", code: 0, hostKey: "HOSTKEY-BYTES" };
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow({ ssh_host_key: null })] }); // getHostRow
    mockDb.query.mockResolvedValueOnce({ rows: [remoteHostRow()] }); // UPDATE

    await remoteHosts.testRemoteHost("my-laptop");

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

    await remoteHosts.testRemoteHost("my-laptop");

    const update = mockDb.query.mock.calls[1];
    expect(update[1][1]).toBe("failed");
    expect(update[1][2]).toMatch(/host key does not match|man-in-the-middle/i);
    // The pin is NOT overwritten on mismatch.
    expect(update[1][3]).toBeNull();
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
    mockDb.query
      .mockResolvedValueOnce({ rows: [remoteHostRow()] }) // getRemoteHostProfile: owner = user-1
      .mockResolvedValue({ rows: [] }); // userCanUseRemoteHost probes: not owner, no grant
    await expect(
      remoteHosts.assertRemoteHostExecutionTargetAvailable(
        { deploy_target: "remote-docker", execution_target_id: "remote:my-laptop" },
        { ownerUserId: "user-2" },
      ),
    ).rejects.toThrow(/Unknown remote host/i);
  });

  it("allows a non-owner who has an editor+ grant via a shared workspace (C3)", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [remoteHostRow()] }) // getRemoteHostProfile: owner = user-1
      .mockResolvedValueOnce({ rows: [] }) // userCanUseRemoteHost: ownership probe (not owner)
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // shared editor+ grant
    const profile = await remoteHosts.assertRemoteHostExecutionTargetAvailable(
      { deploy_target: "remote-docker", execution_target_id: "remote:my-laptop" },
      { ownerUserId: "user-2" },
    );
    expect(profile.id).toBe("my-laptop");
  });

  it("fails closed on a null-owner (orphaned) host — requires a grant, never short-circuits", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [remoteHostRow({ owner_user_id: null })] }) // null owner
      .mockResolvedValue({ rows: [] }); // userCanUseRemoteHost probes: no ownership, no grant
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
});

describe("listRemoteHostExecutionTargets", () => {
  it("returns only available hosts and scopes the query by owner", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        remoteHostRow({ id: "ready-host" }),
        remoteHostRow({ id: "broken-host", last_test_status: "failed" }),
      ],
    });
    const targets = await remoteHosts.listRemoteHostExecutionTargets({ ownerUserId: "user-1" });
    expect(targets.map((t) => t.id)).toEqual(["ready-host"]);
    const select = mockDb.query.mock.calls[0];
    expect(select[0]).toMatch(/WHERE enabled = true AND owner_user_id = \$1/);
    expect(select[1]).toEqual(["user-1"]);
  });

  it("returns an empty list when the table has not been migrated yet", async () => {
    const undefinedTable = new Error('relation "remote_hosts" does not exist');
    undefinedTable.code = "42P01";
    mockDb.query.mockRejectedValueOnce(undefinedTable);
    expect(await remoteHosts.listRemoteHostExecutionTargets()).toEqual([]);
  });
});
