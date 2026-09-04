// @ts-nocheck
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Readable } = require("stream");
const { spawnSync } = require("child_process");
const tar = require("tar-stream");

const RemoteDockerBackend = require("../../workers/provisioner/backends/remote-docker");
const RemoteNemoClawBackend = require("../../workers/provisioner/backends/remote-nemoclaw");
const DockerBackend = require("../../workers/provisioner/backends/docker");
const NemoClawBackend = require("../../workers/provisioner/backends/nemoclaw");
const { buildRemoteDockerOptions } = RemoteDockerBackend;
const { buildManagedEnvApplyScript, ensureOpenClawManagedStartupHooks } = DockerBackend;

async function packFile(name, content) {
  const pack = tar.pack();
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
  pack.entry({ name, mode: 0o600 }, content, (error) => {
    if (error) throw error;
    pack.finalize();
  });
  return result;
}

async function unpackFiles(archive) {
  const extract = tar.extract();
  const files = new Map();
  const done = new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        if (header.type !== "directory") {
          files.set(`/${header.name.replace(/^\/+/, "")}`, Buffer.concat(chunks).toString("utf8"));
        }
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  Readable.from(archive).pipe(extract);
  await done;
  return files;
}

function managedEnvContainer({ startup, env = [] }) {
  const files = new Map([["/opt/openclaw-runtime/start.sh", startup]]);
  const container = {
    inspect: jest.fn().mockResolvedValue({ Config: { Env: env } }),
    getArchive: jest.fn(async ({ path: filePath }) => {
      if (!files.has(filePath)) {
        const error = new Error(`No such file: ${filePath}`);
        error.statusCode = 404;
        throw error;
      }
      return Readable.from(await packFile(path.posix.basename(filePath), files.get(filePath)));
    }),
    putArchive: jest.fn(async (archive) => {
      for (const [filePath, content] of await unpackFiles(archive)) files.set(filePath, content);
    }),
  };
  return { container, files };
}

function dockerCreateHarness() {
  const captured = [];
  const container = {
    id: "created-container-id",
    start: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    inspect: jest.fn().mockResolvedValue({
      NetworkSettings: {
        IPAddress: "172.18.0.10",
        Networks: {},
        Ports: {
          "18789/tcp": [{ HostPort: "19042" }],
          "9090/tcp": [{ HostPort: "19043" }],
        },
      },
    }),
  };
  const docker = {
    getImage: jest.fn(() => ({ inspect: jest.fn().mockResolvedValue({}) })),
    getContainer: jest.fn(() => ({
      inspect: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 })),
    })),
    createVolume: jest.fn().mockResolvedValue(undefined),
    createContainer: jest.fn(async (options) => {
      captured.push(options);
      return container;
    }),
    getNetwork: jest.fn(() => ({ connect: jest.fn().mockResolvedValue(undefined) })),
  };
  return { captured, container, docker };
}

function expectNoImmutableUserSecrets(createOptions, env = {}) {
  const immutable = Object.fromEntries(
    (createOptions.Env || []).map((entry) => {
      const separator = String(entry).indexOf("=");
      return separator < 0
        ? [String(entry), ""]
        : [String(entry).slice(0, separator), String(entry).slice(separator + 1)];
    }),
  );
  for (const [name, value] of Object.entries(env)) {
    expect(immutable).not.toHaveProperty(name);
    expect(Object.values(immutable)).not.toContain(value);
  }
}

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
    sshHostKey: Buffer.from("GOOD-KEY").toString("base64"),
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
    it("refuses to build operational SSH options when no pin exists", () => {
      expect(() => buildRemoteDockerOptions(keyProfile({ sshHostKey: null }))).toThrow(
        expect.objectContaining({
          code: "REMOTE_HOST_PIN_REQUIRED",
          statusCode: 409,
          message: expect.stringMatching(/Run Test.*trusted network/i),
        }),
      );
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

// #408: create() overrode gatewayHost, gatewayPort, runtimeHost and runtimePort
// for the remote host but left `host` as whatever the parent derived from the
// container's networks — which describes the REMOTE daemon's view and is
// unreachable from the control plane. The worker's localhost-recovery path then
// inspected the local Docker socket, failed, and fell back to the container
// name, which only the remote daemon's DNS resolves, so OpenClaw agents sat in
// `deploying` until their attempts ran out.
describe("RemoteDockerBackend.create endpoint overrides (#408)", () => {
  // super.create resolves through RemoteDockerBackend.prototype's prototype, so
  // stubbing DockerBackend.prototype.create is enough — no real daemon, and no
  // need to satisfy the constructor's SSH validation.
  function callCreate(parentResult, profileOverrides = {}) {
    const spy = jest.spyOn(DockerBackend.prototype, "create").mockResolvedValue(parentResult);
    const self = { profile: keyProfile(profileOverrides) };
    return RemoteDockerBackend.prototype.create.call(self, {}).finally(() => spy.mockRestore());
  }

  const PARENT = {
    containerId: "nora-agent-1",
    containerName: "nora-agent-1",
    host: "localhost",
    gatewayToken: "token",
    gatewayHostPort: "31890",
    gatewayHost: "localhost",
    gatewayPort: 18789,
    runtimeHostPort: "31891",
  };

  it("points host at the registered remote host rather than the daemon's view", async () => {
    const result = await callCreate(PARENT);
    expect(result.host).toBe("laptop.tail-scale.ts.net");
    // The parent's value must not survive: "localhost" is what triggers the
    // worker's local-socket recovery path on the wrong machine.
    expect(result.host).not.toBe("localhost");
  });

  it("keeps host consistent with the other overridden endpoint fields", async () => {
    const result = await callCreate(PARENT);
    expect(result.host).toBe(result.gatewayHost);
    expect(result.host).toBe(result.runtimeHost);
  });

  it("falls back to the SSH host when no gateway host is configured", async () => {
    const result = await callCreate(PARENT, { gatewayHost: "" });
    expect(result.host).toBe("100.64.0.5");
  });

  it("keeps the parent host rather than emptying it when the profile has neither", async () => {
    // Replacing a wrong address with an empty one would be a regression, not a
    // fix — downstream code treats a falsy host very differently.
    const result = await callCreate(PARENT, { gatewayHost: "", sshHost: "" });
    expect(result.host).toBe("localhost");
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

  it("refuses to construct an operational backend without a pinned host key", () => {
    expect(() => new RemoteDockerBackend(keyProfile({ sshHostKey: null }))).toThrow(
      expect.objectContaining({ code: "REMOTE_HOST_PIN_REQUIRED", statusCode: 409 }),
    );
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

  it("explicitly publishes remote-host ports on all interfaces", () => {
    const backend = new RemoteDockerBackend(keyProfile());
    expect(backend._publishedPortHostIp()).toBe("0.0.0.0");
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

  it("keeps provider and integration credentials out of immutable Remote Docker Config.Env", async () => {
    const backend = new RemoteDockerBackend(keyProfile());
    const harness = dockerCreateHarness();
    backend.docker = harness.docker;
    backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    backend._putBootstrapFiles = jest.fn().mockResolvedValue(undefined);
    backend.updateEnv = jest.fn().mockResolvedValue(undefined);
    const staged = {
      OPENAI_API_KEY: "remote-provider-secret-sentinel",
      GITHUB_TOKEN: "remote-integration-secret-sentinel",
    };

    await backend.create({
      id: "remote-secret-test",
      name: "Remote secret test",
      image: "example.invalid/openclaw:test",
      gatewayHostPort: 19042,
      runtimeHostPort: 19043,
      env: staged,
    });

    expectNoImmutableUserSecrets(harness.captured[0], staged);
    expect(backend.updateEnv).toHaveBeenCalledWith(
      "created-container-id",
      expect.objectContaining(staged),
      expect.objectContaining({ replaceManagedState: true, runtimeFamily: "openclaw" }),
    );
    expect(backend.updateEnv.mock.invocationCallOrder[0]).toBeLessThan(
      harness.container.start.mock.invocationCallOrder[0],
    );
  });
});

describe("DockerBackend.create secret staging", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps provider and integration credentials out of immutable local Docker Config.Env", async () => {
    const backend = new DockerBackend();
    const harness = dockerCreateHarness();
    backend.docker = harness.docker;
    backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    backend._putBootstrapFiles = jest.fn().mockResolvedValue(undefined);
    backend.updateEnv = jest.fn().mockResolvedValue(undefined);
    const staged = {
      OPENAI_API_KEY: "local-provider-secret-sentinel",
      SLACK_TOKEN: "local-integration-secret-sentinel",
    };

    await backend.create({
      id: "local-secret-test",
      name: "Local secret test",
      image: "example.invalid/openclaw:test",
      gatewayHostPort: 19042,
      env: staged,
    });

    expectNoImmutableUserSecrets(harness.captured[0], staged);
    expect(backend.updateEnv.mock.invocationCallOrder[0]).toBeLessThan(
      harness.container.start.mock.invocationCallOrder[0],
    );
  });
});

describe("RemoteNemoClawBackend", () => {
  afterEach(() => jest.restoreAllMocks());

  it("rejects a profile without a pinned SSH host key", () => {
    expect(() => new RemoteNemoClawBackend(keyProfile({ sshHostKey: null }))).toThrow(
      expect.objectContaining({ code: "REMOTE_HOST_PIN_REQUIRED", statusCode: 409 }),
    );
  });

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

describe("NemoClawBackend.create secret staging", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps provider and integration credentials out of immutable NemoClaw Config.Env", async () => {
    const backend = new NemoClawBackend();
    const harness = dockerCreateHarness();
    backend.docker = harness.docker;
    backend._ensureSandboxImage = jest.fn().mockResolvedValue(undefined);
    backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    backend._putBootstrapFiles = jest.fn().mockResolvedValue(undefined);
    backend.updateEnv = jest.fn().mockResolvedValue(undefined);
    const staged = {
      NVIDIA_API_KEY: "nemo-provider-secret-sentinel",
      GITHUB_TOKEN: "nemo-integration-secret-sentinel",
    };

    await backend.create({
      id: "nemo-secret-test",
      name: "Nemo secret test",
      gatewayHostPort: 19042,
      runtimeHostPort: 19043,
      env: staged,
    });

    expectNoImmutableUserSecrets(harness.captured[0], staged);
    expect(backend.updateEnv).toHaveBeenCalledWith(
      "created-container-id",
      expect.objectContaining(staged),
      expect.objectContaining({ replaceManagedState: true, runtimeFamily: "openclaw" }),
    );
    expect(backend.updateEnv.mock.invocationCallOrder[0]).toBeLessThan(
      harness.container.start.mock.invocationCallOrder[0],
    );
  });
});

describe("Docker managed environment replacement", () => {
  afterEach(() => jest.restoreAllMocks());

  it("unsets the complete managed set, exports exact values, and preserves unrelated env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-managed-env-"));
    const statePath = path.join(tempDir, "state.json");
    const applyPath = path.join(tempDir, "apply.sh");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        managedNames: ["OPENAI_API_KEY", "GEMINI_API_KEY", "EMPTY_VALUE"],
        values: { OPENAI_API_KEY: "new-'secret", EMPTY_VALUE: "" },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      applyPath,
      buildManagedEnvApplyScript().replace("/opt/nora-managed-env/state.json", statePath),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync(
        "sh",
        [
          "-c",
          '. "$1"; printf "%s\\0%s\\0%s\\0%s" "${OPENAI_API_KEY-unset}" "${GEMINI_API_KEY-unset}" "${EMPTY_VALUE-unset}" "$UNRELATED"',
          "sh",
          applyPath,
        ],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: "old-secret",
            GEMINI_API_KEY: "old-gemini",
            EMPTY_VALUE: "old-empty",
            UNRELATED: "keep-me",
          },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.toString().split("\0")).toEqual(["new-'secret", "unset", "", "keep-me"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("patches existing OpenClaw startup scripts once and reconciles after baked config", () => {
    const original = [
      "#!/bin/sh",
      "set -eu",
      "printf baked-config",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts &',
      'exec "$OPENCLAW_BIN" gateway',
      "",
    ].join("\n");
    const patched = ensureOpenClawManagedStartupHooks(original);
    expect(patched.indexOf("NORA MANAGED ENV APPLY")).toBeLessThan(
      patched.indexOf("printf baked-config"),
    );
    expect(patched.indexOf("NORA MANAGED RUNTIME RECONCILE")).toBeGreaterThan(
      patched.indexOf("printf baked-config"),
    );
    expect(patched.indexOf("NORA MANAGED RUNTIME RECONCILE")).toBeLessThan(
      patched.indexOf("agent.ts"),
    );
    expect(ensureOpenClawManagedStartupHooks(patched)).toBe(patched);
  });

  it("durably replaces and clears managed env for an existing container without logging secrets", async () => {
    const startup = [
      "#!/bin/sh",
      "set -eu",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts &',
      'exec "$OPENCLAW_BIN" gateway',
      "",
    ].join("\n");
    const { container, files } = managedEnvContainer({
      startup,
      env: ["OPENAI_API_KEY=immutable-old", "GEMINI_API_KEY=immutable-gemini", "KEEP=value"],
    });
    const backend = Object.create(DockerBackend.prototype);
    backend.docker = { getContainer: jest.fn(() => container) };
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    await backend.updateEnv(
      "existing-agent",
      { OPENAI_API_KEY: "rotated-super-secret" },
      {
        runtimeFamily: "openclaw",
        managedEnvNames: ["OPENAI_API_KEY", "GEMINI_API_KEY"],
        replaceManagedState: true,
      },
    );
    let state = JSON.parse(files.get("/opt/nora-managed-env/state.json"));
    expect(state).toMatchObject({
      managedNames: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
      values: { OPENAI_API_KEY: "rotated-super-secret" },
    });
    await expect(
      backend.inspectEnv("existing-agent", {
        envNames: ["OPENAI_API_KEY", "GEMINI_API_KEY", "KEEP"],
      }),
    ).resolves.toEqual({
      OPENAI_API_KEY: "rotated-super-secret",
      GEMINI_API_KEY: "",
      KEEP: "value",
    });
    expect(files.get("/opt/openclaw-runtime/start.sh")).toContain("NORA MANAGED RUNTIME RECONCILE");

    await backend.updateEnv(
      "existing-agent",
      {},
      {
        runtimeFamily: "openclaw",
        managedEnvNames: ["OPENAI_API_KEY", "GEMINI_API_KEY"],
        replaceManagedState: true,
      },
    );
    state = JSON.parse(files.get("/opt/nora-managed-env/state.json"));
    expect(state.values).toEqual({});
    expect(
      files.get("/opt/openclaw-runtime/start.sh").match(/NORA MANAGED ENV APPLY/g) || [],
    ).toHaveLength(2);
    expect(log.mock.calls.flat().join(" ")).not.toContain("rotated-super-secret");
  });

  it("revokes stale provider and integration credentials without clearing invariant startup state", async () => {
    const startup = [
      "#!/bin/sh",
      "set -eu",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts &',
      'exec "$OPENCLAW_BIN" gateway',
      "",
    ].join("\n");
    const { container, files } = managedEnvContainer({ startup });
    const backend = Object.create(DockerBackend.prototype);
    backend.docker = { getContainer: jest.fn(() => container) };
    jest.spyOn(console, "log").mockImplementation(() => {});

    const invariantState = {
      AGENT_ID: "agent-1",
      AGENT_NAME: "Promo Agent",
      NORA_INTEGRATIONS_CONFIG: "/mnt/nora-agent-state/integrations.json",
      NORA_INTEGRATIONS_DIR: "/mnt/nora-agent-state/integrations",
      IMPORTED_AGENT_SECRET: "preserve-imported-override",
    };
    await backend.updateEnv(
      "existing-agent",
      {
        ...invariantState,
        OPENAI_API_KEY: "old-provider-secret",
        GITHUB_TOKEN: "old-integration-secret",
      },
      {
        runtimeFamily: "openclaw",
        managedEnvNames: [...Object.keys(invariantState), "OPENAI_API_KEY", "GITHUB_TOKEN"],
        replaceManagedState: true,
      },
    );

    await backend.updateEnv(
      "existing-agent",
      { OPENAI_API_KEY: "rotated-provider-secret" },
      {
        runtimeFamily: "openclaw",
        managedEnvNames: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
        replaceManagedState: true,
      },
    );

    const state = JSON.parse(files.get("/opt/nora-managed-env/state.json"));
    expect(state.values).toEqual({
      ...invariantState,
      OPENAI_API_KEY: "rotated-provider-secret",
    });
    expect(state.values).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("gives NemoClaw and Remote NemoClaw the same inherited replacement path", async () => {
    expect(NemoClawBackend.prototype).toBeInstanceOf(DockerBackend);
    expect(typeof NemoClawBackend.prototype.updateEnv).toBe("function");
    const backend = Object.create(NemoClawBackend.prototype);
    backend._readContainerFile = jest
      .fn()
      .mockResolvedValue("sandbox:x:998:998:OpenShell Sandbox:/sandbox:/bin/sh\n");
    expect(backend._managedOpenClawConfigPaths()).toEqual({
      configPath: "/sandbox/.openclaw/openclaw.json",
      markerPath: "/sandbox/.openclaw/.nora-managed-default-model",
    });
    await expect(backend._managedEnvFileOwnership({})).resolves.toEqual({ uid: 998, gid: 998 });
  });
});
