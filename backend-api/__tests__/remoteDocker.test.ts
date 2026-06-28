// @ts-nocheck
const path = require("path");

const RemoteDockerBackend = require("../../workers/provisioner/backends/remote-docker");
const RemoteNemoClawBackend = require("../../workers/provisioner/backends/remote-nemoclaw");
const DockerBackend = require("../../workers/provisioner/backends/docker");
const NemoClawBackend = require("../../workers/provisioner/backends/nemoclaw");
const { buildRemoteDockerOptions } = RemoteDockerBackend;

function keyProfile(overrides = {}) {
  return {
    id: "my-laptop",
    executionTargetId: "remote:my-laptop",
    label: "My Laptop",
    sshHost: "100.64.0.5",
    sshPort: 2222,
    sshUser: "operator",
    sshAuthMode: "key",
    sshPrivateKey: "PRIVATE-KEY-PEM",
    sshPassphrase: "secret-phrase",
    gatewayHost: "laptop.tail-scale.ts.net",
    ...overrides,
  };
}

describe("buildRemoteDockerOptions", () => {
  it("builds key-based SSH options with a Buffer private key and passphrase", () => {
    const opts = buildRemoteDockerOptions(keyProfile());
    expect(opts.protocol).toBe("ssh");
    expect(opts.host).toBe("100.64.0.5");
    expect(opts.port).toBe(2222);
    expect(opts.username).toBe("operator");
    expect(Buffer.isBuffer(opts.sshOptions.privateKey)).toBe(true);
    expect(opts.sshOptions.privateKey.toString()).toBe("PRIVATE-KEY-PEM");
    expect(opts.sshOptions.passphrase).toBe("secret-phrase");
    expect(opts.sshOptions.password).toBeUndefined();
  });

  it("builds password-based SSH options and omits key material", () => {
    const opts = buildRemoteDockerOptions(
      keyProfile({ sshAuthMode: "password", sshPassword: "hunter2", sshPrivateKey: null }),
    );
    expect(opts.sshOptions.password).toBe("hunter2");
    expect(opts.sshOptions.privateKey).toBeUndefined();
  });

  describe("hostVerifier (host-key pinning)", () => {
    it("accepts any key when no pin exists yet (trust-on-first-use)", () => {
      const opts = buildRemoteDockerOptions(keyProfile({ sshHostKey: null }));
      expect(opts.sshOptions.hostVerifier(Buffer.from("anything"))).toBe(true);
    });

    it("accepts a matching pinned key", () => {
      const pin = Buffer.from("GOOD-KEY").toString("base64");
      const opts = buildRemoteDockerOptions(keyProfile({ sshHostKey: pin }));
      expect(opts.sshOptions.hostVerifier(Buffer.from("GOOD-KEY"))).toBe(true);
    });

    it("rejects a key that differs from the pin (MITM)", () => {
      const pin = Buffer.from("GOOD-KEY").toString("base64");
      const opts = buildRemoteDockerOptions(keyProfile({ sshHostKey: pin }));
      expect(opts.sshOptions.hostVerifier(Buffer.from("EVIL-KEY"))).toBe(false);
    });
  });

  it("defaults the SSH port to 22 when unset", () => {
    expect(buildRemoteDockerOptions(keyProfile({ sshPort: null })).port).toBe(22);
  });
});

describe("RemoteDockerBackend construction", () => {
  it("rejects a profile without a remote: execution target", () => {
    expect(() => new RemoteDockerBackend(keyProfile({ executionTargetId: "docker" }))).toThrow(
      /registered remote host profile/i,
    );
  });

  it("rejects a profile missing SSH connection details", () => {
    expect(() => new RemoteDockerBackend(keyProfile({ sshHost: "" }))).toThrow(
      /missing SSH connection details/i,
    );
    expect(() => new RemoteDockerBackend(keyProfile({ sshUser: "" }))).toThrow(
      /missing SSH connection details/i,
    );
  });

  it("refuses to build with no credential (would let ssh2 use the worker's own identity)", () => {
    // key mode, no private key
    expect(() => new RemoteDockerBackend(keyProfile({ sshPrivateKey: null }))).toThrow(
      /missing its SSH private key/i,
    );
    // password mode, no password
    expect(
      () =>
        new RemoteDockerBackend(
          keyProfile({ sshAuthMode: "password", sshPrivateKey: null, sshPassword: "" }),
        ),
    ).toThrow(/missing its SSH password/i);
  });

  it("points the dockerode client at the remote daemon over SSH", () => {
    const backend = new RemoteDockerBackend(keyProfile());
    // dockerode exposes the docker-modem; the SSH protocol is what makes calls
    // route to the remote host instead of /var/run/docker.sock.
    expect(backend.docker.modem.protocol).toBe("ssh");
    expect(backend.docker.modem.host).toBe("100.64.0.5");
  });

  it("never discovers a compose network (remote hosts are standalone daemons)", async () => {
    const backend = new RemoteDockerBackend(keyProfile());
    expect(backend._composeNetwork).toBeNull();
    await expect(backend._findComposeNetwork()).resolves.toBeNull();
  });
});

describe("RemoteDockerBackend.create", () => {
  afterEach(() => jest.restoreAllMocks());

  it("advertises the remote host's gateway address and published port", async () => {
    jest.spyOn(DockerBackend.prototype, "create").mockResolvedValue({
      containerId: "oclaw-agent-x",
      host: "172.18.0.4",
      gatewayToken: "tok",
      containerName: "oclaw-agent-x",
      gatewayHostPort: 19042,
      runtimeHostPort: 19043,
    });
    const backend = new RemoteDockerBackend(keyProfile());

    const result = await backend.create({ id: "x", name: "X" });

    expect(result.gatewayHost).toBe("laptop.tail-scale.ts.net");
    expect(result.gatewayPort).toBe(19042);
    expect(result.runtimeHost).toBe("laptop.tail-scale.ts.net");
    expect(result.runtimePort).toBe(19043);
    // base fields preserved
    expect(result.containerId).toBe("oclaw-agent-x");
    expect(result.gatewayHostPort).toBe(19042);
  });

  it("falls back to the SSH host as the advertised gateway host", async () => {
    jest.spyOn(DockerBackend.prototype, "create").mockResolvedValue({
      containerId: "c",
      host: "h",
      gatewayToken: "t",
      containerName: "c",
      gatewayHostPort: 19000,
      runtimeHostPort: 19001,
    });
    const backend = new RemoteDockerBackend(keyProfile({ gatewayHost: "" }));

    const result = await backend.create({ id: "x" });
    expect(result.gatewayHost).toBe("100.64.0.5");
  });
});

describe("RemoteNemoClawBackend", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uses the NemoClaw backend path and advertises the remote gateway endpoint", async () => {
    jest.spyOn(NemoClawBackend.prototype, "create").mockResolvedValue({
      containerId: "nemo-agent-x",
      host: "172.18.0.5",
      gatewayToken: "tok",
      containerName: "nemo-agent-x",
      gatewayHostPort: 19077,
      runtimeHostPort: 19078,
    });
    const backend = new RemoteNemoClawBackend(keyProfile());

    const result = await backend.create({ id: "x", name: "Nemo" });

    expect(result.host).toBe("laptop.tail-scale.ts.net");
    expect(result.gatewayHost).toBe("laptop.tail-scale.ts.net");
    expect(result.gatewayPort).toBe(19077);
    expect(result.runtimeHost).toBe("laptop.tail-scale.ts.net");
    expect(result.runtimePort).toBe(19078);
    expect(result.containerId).toBe("nemo-agent-x");
  });

  it("never discovers a compose network on the remote daemon", async () => {
    const backend = new RemoteNemoClawBackend(keyProfile());
    await expect(backend._findComposeNetwork()).resolves.toBeNull();
  });
});
