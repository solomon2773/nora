// @ts-nocheck
const RemoteHermesBackend = require("../../workers/provisioner/backends/remote-hermes");
const HermesBackend = require("../../workers/provisioner/backends/hermes");
const { HERMES_RUNTIME_PORT, HERMES_DASHBOARD_PORT } = require("../../agent-runtime/lib/contracts");
const {
  HERMES_EMPTY_STATE_SENTINEL,
  HERMES_MANAGED_ENV_ENV,
  HERMES_MODEL_CONFIG_ENV,
  buildHermesRuntimeBootstrapEnv,
  buildHermesRuntimeConfigBootstrapCommand,
} = require("../../agent-runtime/lib/hermesRuntimeBootstrap");

function hermesCreateHarness() {
  const captured = [];
  const container = {
    id: "created-hermes-id",
    start: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    inspect: jest.fn().mockResolvedValue({
      NetworkSettings: { IPAddress: "172.18.0.11", Networks: {} },
    }),
  };
  const docker = {
    getContainer: jest.fn(() => ({
      inspect: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 })),
    })),
    createContainer: jest.fn(async (options) => {
      captured.push(options);
      return container;
    }),
    getNetwork: jest.fn(() => ({ connect: jest.fn().mockResolvedValue(undefined) })),
  };
  return { captured, container, docker };
}

function immutableEnv(options = {}) {
  return Object.fromEntries(
    (options.Env || []).map((entry) => {
      const separator = String(entry).indexOf("=");
      return separator < 0
        ? [String(entry), ""]
        : [String(entry).slice(0, separator), String(entry).slice(separator + 1)];
    }),
  );
}

function hermesProfile(overrides = {}) {
  return {
    id: "my-laptop",
    executionTargetId: "remote:my-laptop",
    label: "My Laptop",
    sshHost: "100.64.0.5",
    sshPort: 2222,
    sshUser: "operator",
    sshAuthMode: "key",
    sshPrivateKey: "PRIVATE-KEY-PEM",
    sshHostKey: Buffer.from("GOOD-KEY").toString("base64"),
    gatewayHost: "laptop.tail-scale.ts.net",
    ...overrides,
  };
}

describe("RemoteHermesBackend construction", () => {
  it("rejects a profile without a remote: execution target", () => {
    expect(() => new RemoteHermesBackend(hermesProfile({ executionTargetId: "docker" }))).toThrow(
      /registered remote host profile/i,
    );
  });

  it("rejects a profile missing SSH connection details or credential", () => {
    expect(() => new RemoteHermesBackend(hermesProfile({ sshHost: "" }))).toThrow(
      /missing SSH connection details/i,
    );
    expect(() => new RemoteHermesBackend(hermesProfile({ sshPrivateKey: null }))).toThrow(
      /missing its SSH private key/i,
    );
  });

  it("rejects a profile without a pinned SSH host key", () => {
    expect(() => new RemoteHermesBackend(hermesProfile({ sshHostKey: null }))).toThrow(
      expect.objectContaining({ code: "REMOTE_HOST_PIN_REQUIRED", statusCode: 409 }),
    );
  });

  it("points the dockerode client at the remote daemon over SSH", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend.docker.modem.protocol).toBe("ssh");
    expect(backend.docker.modem.host).toBe("100.64.0.5");
  });

  it("never discovers a compose network", async () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._composeNetwork).toBeNull();
    await expect(backend._findComposeNetwork()).resolves.toBeNull();
  });
});

describe("RemoteHermesBackend port publishing", () => {
  it("publishes BOTH the runtime port (readiness) and the dashboard port (UI) on their host ports", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    const bindings = backend._hermesPortBindings({
      gatewayHostPort: 19500,
      dashboardHostPort: 19044,
    });
    expect(bindings).toEqual({
      [`${HERMES_RUNTIME_PORT}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: "19500" }],
      [`${HERMES_DASHBOARD_PORT}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: "19044" }],
    });
  });

  it("publishes only the runtime port when no dashboard port is allocated", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._hermesPortBindings({ gatewayHostPort: 19500 })).toEqual({
      [`${HERMES_RUNTIME_PORT}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: "19500" }],
    });
  });

  it("publishes only the dashboard port when no runtime port is allocated", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._hermesPortBindings({ dashboardHostPort: 19044 })).toEqual({
      [`${HERMES_DASHBOARD_PORT}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: "19044" }],
    });
  });

  it("publishes nothing when no host port is allocated", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._hermesPortBindings({})).toBeUndefined();
    expect(backend._hermesPortBindings({ gatewayHostPort: 0 })).toBeUndefined();
  });

  it("base HermesBackend publishes runtime + dashboard on the configured host IP", () => {
    // Local Hermes now publishes to the DOCKER_AGENT_BIND_IP interface (default
    // loopback) so external desktop clients can reach the runtime API.
    const bindings = HermesBackend.prototype._hermesPortBindings.call(
      { _publishedPortHostIp: () => "127.0.0.1" },
      { gatewayHostPort: 19500, dashboardHostPort: 19044 },
    );
    expect(bindings).toEqual({
      "8642/tcp": [{ HostIp: "127.0.0.1", HostPort: "19500" }],
      "9119/tcp": [{ HostIp: "127.0.0.1", HostPort: "19044" }],
    });
  });

  it("base HermesBackend honors a routable DOCKER_AGENT_BIND_IP", () => {
    const bindings = HermesBackend.prototype._hermesPortBindings.call(
      { _publishedPortHostIp: () => "100.71.115.105" },
      { gatewayHostPort: 19500 },
    );
    expect(bindings).toEqual({
      "8642/tcp": [{ HostIp: "100.71.115.105", HostPort: "19500" }],
    });
  });

  it("base HermesBackend publishes nothing when no host port is allocated", () => {
    expect(
      HermesBackend.prototype._hermesPortBindings.call(
        { _publishedPortHostIp: () => "127.0.0.1" },
        {},
      ),
    ).toBeUndefined();
    expect(HermesBackend.prototype._hermesPortBindings()).toBeUndefined();
  });
});

describe("RemoteHermesBackend.create", () => {
  afterEach(() => jest.restoreAllMocks());

  it("advertises the remote host address + published runtime and dashboard ports", async () => {
    jest.spyOn(HermesBackend.prototype, "create").mockResolvedValue({
      containerId: "nora-hermes-x",
      containerName: "nora-hermes-x",
      gatewayToken: "tok",
      host: "172.18.0.9",
      runtimeHost: "172.18.0.9",
      runtimePort: 8642,
    });
    const backend = new RemoteHermesBackend(hermesProfile());

    const result = await backend.create({
      id: "x",
      name: "Hermes QA",
      gatewayHostPort: 19500,
      dashboardHostPort: 19044,
    });

    expect(result.host).toBe("laptop.tail-scale.ts.net");
    expect(result.runtimeHost).toBe("laptop.tail-scale.ts.net");
    // runtime_port is the published host port so readiness reaches /health
    expect(result.runtimePort).toBe(19500);
    // dashboard_port is the published host port so the embed proxy resolves the UI
    expect(result.dashboardPort).toBe(19044);
    expect(result.containerId).toBe("nora-hermes-x");
  });

  it("reports a null dashboard port when none was allocated", async () => {
    jest.spyOn(HermesBackend.prototype, "create").mockResolvedValue({
      containerId: "c",
      containerName: "c",
      host: "172.18.0.9",
      runtimeHost: "172.18.0.9",
      runtimePort: 8642,
    });
    const backend = new RemoteHermesBackend(hermesProfile());
    const result = await backend.create({ id: "x", gatewayHostPort: 19500 });
    expect(result.dashboardPort).toBeNull();
  });

  it("falls back to the SSH host when no advertised gateway host is set", async () => {
    jest.spyOn(HermesBackend.prototype, "create").mockResolvedValue({
      containerId: "c",
      containerName: "c",
      host: "172.18.0.9",
      runtimeHost: "172.18.0.9",
      runtimePort: 8642,
    });
    const backend = new RemoteHermesBackend(hermesProfile({ gatewayHost: "" }));
    const result = await backend.create({ id: "x", gatewayHostPort: 19500 });
    expect(result.runtimeHost).toBe("100.64.0.5");
  });

  it("keeps provider and integration credentials out of immutable Remote Hermes Config.Env", async () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    const harness = hermesCreateHarness();
    backend.docker = harness.docker;
    backend._ensureImage = jest.fn().mockResolvedValue(undefined);
    backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    backend.updateEnv = jest.fn().mockResolvedValue(undefined);
    const staged = {
      OPENAI_API_KEY: "hermes-provider-secret-sentinel",
      SLACK_TOKEN: "hermes-integration-secret-sentinel",
    };

    await backend.create({
      id: "hermes-secret-test",
      name: "Hermes secret test",
      gatewayHostPort: 19500,
      dashboardHostPort: 19044,
      env: staged,
    });

    const configEnv = immutableEnv(harness.captured[0]);
    expect(configEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(configEnv).not.toHaveProperty("SLACK_TOKEN");
    expect(Object.values(configEnv)).not.toContain(staged.OPENAI_API_KEY);
    expect(Object.values(configEnv)).not.toContain(staged.SLACK_TOKEN);
    expect(backend.updateEnv).toHaveBeenCalledWith(
      "created-hermes-id",
      expect.objectContaining(staged),
      expect.objectContaining({ replaceManagedState: true, runtimeFamily: "hermes" }),
    );
    expect(backend.updateEnv.mock.invocationCallOrder[0]).toBeLessThan(
      harness.container.start.mock.invocationCallOrder[0],
    );
  });
});

describe("Hermes exact bootstrap replacement", () => {
  afterEach(() => jest.restoreAllMocks());

  it("emits explicit sentinels that clear persisted managed env and model state", () => {
    expect(buildHermesRuntimeBootstrapEnv({ envVars: {}, modelConfig: null })).toEqual({
      [HERMES_MANAGED_ENV_ENV]: HERMES_EMPTY_STATE_SENTINEL,
      [HERMES_MODEL_CONFIG_ENV]: HERMES_EMPTY_STATE_SENTINEL,
    });
  });

  it("preserves model state for channel-only updates with modelConfig undefined", () => {
    const encoded = buildHermesRuntimeBootstrapEnv({
      envVars: { DISCORD_BOT_TOKEN: "channel-token" },
      modelConfig: undefined,
    });
    expect(encoded[HERMES_MODEL_CONFIG_ENV]).toBeUndefined();
    expect(Buffer.from(encoded[HERMES_MANAGED_ENV_ENV], "base64").toString("utf8")).toContain(
      'DISCORD_BOT_TOKEN="channel-token"',
    );
  });

  it("does not replace managed env during a model-only update", () => {
    const encoded = buildHermesRuntimeBootstrapEnv({
      modelConfig: { defaultModel: "openai/gpt-5.5", provider: "openai" },
    });
    expect(encoded[HERMES_MANAGED_ENV_ENV]).toBeUndefined();
    expect(
      JSON.parse(Buffer.from(encoded[HERMES_MODEL_CONFIG_ENV], "base64").toString("utf8")),
    ).toEqual({ defaultModel: "openai/gpt-5.5", provider: "openai" });
  });

  it("makes the bootstrap clear sentinels actionable instead of treating them as absent", () => {
    const command = buildHermesRuntimeConfigBootstrapCommand();
    expect(command).toContain(`\${${HERMES_MANAGED_ENV_ENV}+x}`);
    expect(command).toContain(`\${${HERMES_MODEL_CONFIG_ENV}+x}`);
    expect(command).toContain(HERMES_EMPTY_STATE_SENTINEL);
    expect(command).toContain('config.pop("model", None)');
  });

  // Executed rather than string-matched: #340 was a shell-semantics bug, and an
  // assertion on the command text would have passed against the broken version.
  describe("gateway key reconciliation (#340)", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { execFileSync } = require("node:child_process");

    function runBootstrap(existingEnvFile, apiServerKey) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nora-hermes-key-"));
      if (existingEnvFile !== null) {
        fs.writeFileSync(path.join(home, ".env"), existingEnvFile);
      }
      const script = path.join(home, "bootstrap.sh");
      fs.writeFileSync(script, buildHermesRuntimeConfigBootstrapCommand());
      // Both managed-state vars stay unset so their blocks are skipped and only
      // the key reconciliation runs.
      const env = { PATH: process.env.PATH, HERMES_HOME: home, API_SERVER_KEY: apiServerKey };
      execFileSync("sh", ["-eu", script], { env, stdio: "pipe" });
      const contents = fs.readFileSync(path.join(home, ".env"), "utf8");
      fs.rmSync(home, { recursive: true, force: true });
      return contents;
    }

    it("replaces a key the Hermes image generated behind Nora's back", () => {
      const result = runBootstrap(
        "OTHER=keepme\nAPI_SERVER_KEY=hook-generated-competitor\nTRAILING=alsokeep\n",
        "nora-issued-key",
      );
      expect(result).toContain("API_SERVER_KEY=nora-issued-key");
      expect(result).not.toContain("hook-generated-competitor");
      // Unrelated runtime settings must survive the rewrite.
      expect(result).toContain("OTHER=keepme");
      expect(result).toContain("TRAILING=alsokeep");
    });

    it("seeds the key on a fresh volume so the image never generates one", () => {
      expect(runBootstrap(null, "nora-issued-key")).toContain("API_SERVER_KEY=nora-issued-key");
    });

    it("preserves the Nora-managed block while reconciling", () => {
      const result = runBootstrap(
        'API_SERVER_KEY=stale\n# >>> NORA MANAGED ENV >>>\nFOO="bar"\n# <<< NORA MANAGED ENV <<<\n',
        "nora-issued-key",
      );
      expect(result).toContain("# >>> NORA MANAGED ENV >>>");
      expect(result).toContain('FOO="bar"');
      expect(result).toContain("API_SERVER_KEY=nora-issued-key");
      expect(result).not.toContain("API_SERVER_KEY=stale");
    });

    it("handles an .env whose final line has no trailing newline", () => {
      const result = runBootstrap("OTHER=keepme\nAPI_SERVER_KEY=stale", "nora-issued-key");
      expect(result).toContain("OTHER=keepme");
      expect(result).toMatch(/API_SERVER_KEY=nora-issued-key\n?$/);
      expect(result).not.toContain("stale");
    });
  });

  it("installs a durable login prelude for existing Hermes containers", async () => {
    const backend = Object.create(HermesBackend.prototype);
    const container = {};
    backend.docker = { getContainer: jest.fn(() => container) };
    backend._readManagedEnvState = jest.fn().mockResolvedValue({
      version: 1,
      managedNames: [],
      values: {},
    });
    backend._readContainerFile = jest
      .fn()
      .mockResolvedValue("hermes:x:10000:10000:Hermes:/opt/data:/bin/bash\n");
    const putFiles = jest.spyOn(backend, "_putBootstrapFiles").mockResolvedValue(undefined);
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    await backend.updateEnv(
      "existing-hermes",
      {
        OPENAI_API_KEY: "rotated-hermes-secret",
        [HERMES_MANAGED_ENV_ENV]: HERMES_EMPTY_STATE_SENTINEL,
        [HERMES_MODEL_CONFIG_ENV]: HERMES_EMPTY_STATE_SENTINEL,
      },
      {
        runtimeFamily: "hermes",
        managedEnvNames: ["OPENAI_API_KEY", HERMES_MANAGED_ENV_ENV, HERMES_MODEL_CONFIG_ENV],
      },
    );

    const files = putFiles.mock.calls[0][1];
    const stateFile = files.find((file) => file.name === "opt/nora-managed-env/state.json");
    const applyFile = files.find((file) => file.name === "opt/nora-managed-env/apply.sh");
    const profileFile = files.find((file) => file.name === "etc/profile.d/nora-managed-env.sh");
    expect(stateFile.mode).toBe(0o600);
    expect(stateFile).toMatchObject({ uid: 10000, gid: 10000 });
    expect(JSON.parse(stateFile.content).values.OPENAI_API_KEY).toBe("rotated-hermes-secret");
    expect(applyFile.mode).toBe(0o700);
    expect(applyFile).toMatchObject({ uid: 10000, gid: 10000 });
    expect(applyFile.content).not.toContain("rotated-hermes-secret");
    expect(profileFile.mode).toBe(0o644);
    expect(profileFile.content).toContain("/opt/nora-managed-env/apply.sh");
    expect(log.mock.calls.flat().join(" ")).not.toContain("rotated-hermes-secret");
  });
});
