// @ts-nocheck
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const ProxmoxBackend = require("../../workers/provisioner/backends/proxmox");

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = [
  "NODE_ENV",
  "PROXMOX_API_URL",
  "PROXMOX_ALLOW_INSECURE_HTTP",
  "PROXMOX_VERIFY_TLS",
  "PROXMOX_CA_CERT",
  "PROXMOX_CA_CERT_PATH",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_TOKEN_SECRET",
  "PROXMOX_NODE",
  "PROXMOX_TEMPLATE",
  "PROXMOX_HERMES_TEMPLATE",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_USER",
  "PROXMOX_SSH_PORT",
  "PROXMOX_SSH_PASSWORD",
  "PROXMOX_SSH_PRIVATE_KEY",
  "PROXMOX_SSH_PRIVATE_KEY_PATH",
  "PROXMOX_SSH_HOST_FINGERPRINT",
  "PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY",
  "PROXMOX_PCT_COMMAND",
  "PROXMOX_SUDO",
  "PROXMOX_OFFLINE_STAGE_COMMAND",
  "PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD",
];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ORIGINAL_ENV, key)) {
      process.env[key] = ORIGINAL_ENV[key];
    } else {
      delete process.env[key];
    }
  }
}

function fingerprintFor(key) {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function ownershipMarkerFor(agentId) {
  const digest = crypto
    .createHash("sha256")
    .update(`nora:proxmox:agent:${String(agentId).trim()}`, "utf8")
    .digest("hex");
  return `nora-agent:v1:${digest}`;
}

function configureProxmox() {
  const hostKey = Buffer.from("test-proxmox-host-key");
  process.env.PROXMOX_API_URL = "https://pve.example.com:8006/api2/json";
  process.env.PROXMOX_TOKEN_ID = "nora@pve!provisioner";
  process.env.PROXMOX_TOKEN_SECRET = "api-secret";
  process.env.PROXMOX_NODE = "pve-a";
  process.env.PROXMOX_TEMPLATE = "local:vztmpl/ubuntu-22.04-standard.tar.zst";
  process.env.PROXMOX_SSH_HOST = "pve.example.com";
  process.env.PROXMOX_SSH_USER = "nora-bootstrap";
  process.env.PROXMOX_SSH_PASSWORD = "ssh-secret";
  process.env.PROXMOX_SSH_HOST_FINGERPRINT = fingerprintFor(hostKey);
  process.env.PROXMOX_OFFLINE_STAGE_COMMAND = "/usr/local/libexec/nora-proxmox-stage";
  return hostKey;
}

function decodeEnvironmentFile(content) {
  return Object.fromEntries(
    String(content)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [
          line.slice(0, separator),
          Buffer.from(line.slice(separator + 1), "base64").toString("utf8"),
        ];
      }),
  );
}

async function extractTarEntries(buffer) {
  const tar = require("tar-stream");
  const extract = tar.extract();
  const entries = new Map();
  const completed = new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        entries.set(header.name, {
          content: Buffer.concat(chunks).toString("utf8"),
          mode: header.mode,
        });
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);
  });
  extract.end(buffer);
  return completed;
}

function createSshHarness() {
  const conn = new EventEmitter();
  const stream = new PassThrough();
  stream.stderr = new PassThrough();
  stream.signal = jest.fn();
  stream.close = jest.fn(() => stream.emit("close", null));
  conn.end = jest.fn();
  conn.connect = jest.fn(() => {
    setImmediate(() => conn.emit("ready"));
    return conn;
  });
  conn.exec = jest.fn((...args) => {
    const callback = args.at(-1);
    callback(null, stream);
  });
  return { conn, stream };
}

async function waitForSshExec(conn) {
  for (let attempt = 0; attempt < 20 && conn.exec.mock.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(conn.exec).toHaveBeenCalledTimes(1);
}

describe("ProxmoxBackend", () => {
  beforeEach(() => {
    restoreEnv();
    configureProxmox();
  });

  afterAll(() => {
    restoreEnv();
  });

  it("verifies TLS and the pinned SSH host key by default", () => {
    const hostKey = configureProxmox();
    const backend = new ProxmoxBackend();

    expect(backend._tlsOptions()).toEqual({ rejectUnauthorized: true });
    const sshConfig = backend._sshConfig();
    expect(sshConfig.hostVerifier(hostKey)).toBe(true);
    expect(sshConfig.hostVerifier(Buffer.from("different-host-key"))).toBe(false);
    expect(() => backend._assertConfigured()).not.toThrow();
  });

  it("builds privileged pct commands from canonical validated tokens", async () => {
    process.env.PROXMOX_PCT_COMMAND = "/usr/sbin/pct";
    process.env.PROXMOX_SUDO = "/usr/bin/sudo -n";
    const backend = new ProxmoxBackend();
    backend._sshExec = jest.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend._pctExec("108", "printf safe; uname", { timeout: 1234 });

    expect(backend._sshExec).toHaveBeenCalledWith(
      "'/usr/bin/sudo' '-n' '/usr/sbin/pct' 'exec' '108' '--' '/bin/sh' '-lc' 'printf safe; uname'",
      { timeout: 1234 },
    );
  });

  it.each(["pct --debug", "pct; touch /tmp/proxmox-command-injection", "pct\nid", "-pct"])(
    "rejects unsafe PROXMOX_PCT_COMMAND value %p before SSH",
    (value) => {
      process.env.PROXMOX_PCT_COMMAND = value;
      const sshFactory = jest.spyOn(ProxmoxBackend.prototype, "_createSshClient");

      expect(() => new ProxmoxBackend()).toThrow(/PROXMOX_PCT_COMMAND.*single command name/i);
      expect(sshFactory).not.toHaveBeenCalled();
      sshFactory.mockRestore();
    },
  );

  it.each(["sudo", "sudo -n -u root", "sudo -n; id", "sudo\t-n", "bash -n"])(
    "rejects unsafe PROXMOX_SUDO value %p before SSH",
    (value) => {
      process.env.PROXMOX_SUDO = value;
      const sshFactory = jest.spyOn(ProxmoxBackend.prototype, "_createSshClient");

      expect(() => new ProxmoxBackend()).toThrow(/PROXMOX_SUDO/);
      expect(sshFactory).not.toHaveBeenCalled();
      sshFactory.mockRestore();
    },
  );

  it("does not translate an SSH channel close without an exit status into success", async () => {
    const backend = new ProxmoxBackend();
    const { conn, stream } = createSshHarness();
    backend._createSshClient = () => conn;

    const command = backend._sshExec("true");
    await waitForSshExec(conn);
    stream.emit("close", null);

    await expect(command).rejects.toMatchObject({
      code: "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED",
    });
  });

  it("uses a confirmed SSH exit event when close omits the status", async () => {
    const backend = new ProxmoxBackend();
    const { conn, stream } = createSshHarness();
    backend._createSshClient = () => conn;

    const command = backend._sshExec("true");
    await waitForSshExec(conn);
    stream.emit("exit", 0);
    stream.emit("close", null);

    await expect(command).resolves.toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("reports an aborted SSH command as unconfirmed when close has no exit status", async () => {
    const backend = new ProxmoxBackend();
    const { conn, stream } = createSshHarness();
    backend._createSshClient = () => conn;
    const controller = new AbortController();

    const command = backend._sshExec("sleep 60", { signal: controller.signal });
    await waitForSshExec(conn);
    controller.abort(new Error("operator cancelled"));
    stream.emit("close", null);

    await expect(command).rejects.toMatchObject({
      code: "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED",
      cause: expect.objectContaining({ message: "operator cancelled" }),
    });
    expect(stream.signal).toHaveBeenCalledWith("TERM");
  });

  it("fails closed when the SSH transport closes before command exit", async () => {
    const backend = new ProxmoxBackend();
    const { conn } = createSshHarness();
    backend._createSshClient = () => conn;

    const command = backend._sshExec("true");
    await waitForSshExec(conn);
    conn.emit("close");

    await expect(command).rejects.toMatchObject({
      code: "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED",
    });
  });

  it("keeps stream exit unconfirmed when the local consumer destroys its SSH attach", async () => {
    const backend = new ProxmoxBackend();
    const { conn, stream } = createSshHarness();
    backend._createSshClient = () => conn;

    const session = backend._openSshStream("sleep 60", { tty: false });
    await waitForSshExec(conn);
    session.stream.destroy();

    await expect(session.inspect()).resolves.toEqual({ Running: false, ExitCode: null });
    expect(stream.signal).toHaveBeenCalledWith("TERM");
  });

  it("ends an attached stream with an unconfirmed exit when SSH transport disappears", async () => {
    const backend = new ProxmoxBackend();
    const { conn } = createSshHarness();
    backend._createSshClient = () => conn;

    const session = backend._openSshStream("sleep 60", { tty: false });
    session.stream.on("error", () => {});
    await waitForSshExec(conn);
    conn.emit("close");

    await expect(session.inspect()).resolves.toEqual({ Running: false, ExitCode: null });
  });

  it.each([
    [null, "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED"],
    [7, undefined],
  ])(
    "surfaces required streaming-command failure for remote exit %s",
    async (remoteExit, expectedCode) => {
      const backend = new ProxmoxBackend();
      const { conn, stream } = createSshHarness();
      backend._createSshClient = () => conn;

      const session = backend._openSshStream("journalctl --no-pager", {
        tty: false,
        requireSuccess: true,
      });
      const streamError = new Promise((resolve) => session.stream.once("error", resolve));
      await waitForSshExec(conn);
      if (Number.isInteger(remoteExit)) stream.emit("exit", remoteExit);
      stream.emit("close", null);

      await expect(streamError).resolves.toMatchObject(
        expectedCode
          ? { code: expectedCode }
          : { message: expect.stringContaining("exited with 7") },
      );
      await expect(session.inspect()).resolves.toEqual({
        Running: false,
        ExitCode: remoteExit,
      });
    },
  );

  it("requires explicit opt-outs for insecure API and SSH transport", () => {
    process.env.PROXMOX_API_URL = "http://pve.test:8006/api2/json";
    delete process.env.PROXMOX_SSH_HOST_FINGERPRINT;
    let backend = new ProxmoxBackend();
    expect(() => backend._assertConfigured()).toThrow(/must use HTTPS/i);

    process.env.PROXMOX_ALLOW_INSECURE_HTTP = "true";
    backend = new ProxmoxBackend();
    expect(() => backend._assertConfigured()).toThrow(/host_fingerprint/i);

    process.env.PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY = "true";
    expect(() => new ProxmoxBackend()._assertConfigured()).not.toThrow();
  });

  it.each([
    ["PROXMOX_ALLOW_INSECURE_HTTP", "true"],
    ["PROXMOX_VERIFY_TLS", "false"],
    ["PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY", "true"],
  ])("rejects %s in production", (name, value) => {
    process.env.NODE_ENV = "production";
    process.env[name] = value;
    if (name === "PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY") {
      delete process.env.PROXMOX_SSH_HOST_FINGERPRINT;
    }

    expect(() => new ProxmoxBackend()._assertConfigured()).toThrow(
      /not allowed when NODE_ENV=production/i,
    );
  });

  it("fails preflight on unreadable credential files, invalid nodes, and invalid SSH ports", () => {
    process.env.PROXMOX_CA_CERT_PATH = "/run/secrets/missing-proxmox-ca.pem";
    expect(() => new ProxmoxBackend()._assertConfigured()).toThrow(
      /CA certificate could not be read/i,
    );

    delete process.env.PROXMOX_CA_CERT_PATH;
    delete process.env.PROXMOX_SSH_PASSWORD;
    process.env.PROXMOX_SSH_PRIVATE_KEY_PATH = "/run/secrets/missing-proxmox-key";
    expect(() => new ProxmoxBackend()._assertConfigured()).toThrow(
      /private key could not be read/i,
    );

    process.env.PROXMOX_SSH_PRIVATE_KEY_PATH = __filename;
    process.env.PROXMOX_NODE = "pve; reboot";
    expect(() => new ProxmoxBackend()._assertConfigured()).toThrow(/unsupported characters/i);

    process.env.PROXMOX_NODE = "pve-a";
    process.env.PROXMOX_SSH_PORT = "70000";
    expect(() => new ProxmoxBackend()._assertConfigured()).toThrow(/between 1 and 65535/i);
  });

  it("sends Proxmox API mutations as form data without putting the token in the URL", async () => {
    const backend = new ProxmoxBackend();
    let capturedUrl;
    let capturedOptions;
    let responseCallback;
    const request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = jest.fn();
      responseCallback(response);
      response.emit("data", '{"data":"UPID:test"}');
      response.emit("end");
    });
    request.destroy = jest.fn((error) => request.emit("error", error));
    const requestSpy = jest.spyOn(https, "request").mockImplementation((url, options, callback) => {
      capturedUrl = url;
      capturedOptions = options;
      responseCallback = callback;
      return request;
    });

    await expect(
      backend._request("POST", "/nodes/pve-a/lxc", { vmid: 108, hostname: "nora-test" }),
    ).resolves.toEqual({ data: "UPID:test" });

    expect(String(capturedUrl)).toBe("https://pve.example.com:8006/api2/json/nodes/pve-a/lxc");
    expect(String(capturedUrl)).not.toContain("api-secret");
    expect(capturedOptions.headers.Authorization).toBe(
      "PVEAPIToken=nora@pve!provisioner=api-secret",
    );
    expect(capturedOptions.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(capturedOptions.rejectUnauthorized).toBe(true);
    expect(request.write).toHaveBeenCalledWith("vmid=108&hostname=nora-test");
    requestSpy.mockRestore();
  });

  it("requires both a task id and a confirmed successful task exit status", async () => {
    const backend = new ProxmoxBackend();

    await expect(backend._waitForTask(null)).rejects.toMatchObject({
      code: "PROXMOX_TASK_COMPLETION_UNCONFIRMED",
    });

    const requestData = jest.spyOn(backend, "_requestData");
    requestData.mockResolvedValueOnce({ status: "stopped" });
    await expect(backend._waitForTask("UPID:missing-exit")).rejects.toMatchObject({
      code: "PROXMOX_TASK_COMPLETION_UNCONFIRMED",
    });

    requestData.mockResolvedValueOnce({ status: "stopped", exitstatus: "OK" });
    await expect(backend._waitForTask("UPID:ok")).resolves.toBeUndefined();

    requestData.mockResolvedValueOnce({ status: "stopped", exitstatus: "TASK ERROR" });
    await expect(backend._waitForTask("UPID:failed")).rejects.toThrow(
      "Proxmox task failed: TASK ERROR",
    );
  });

  it("creates an unprivileged LXC and returns the runtime endpoint", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("101");
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockResolvedValueOnce("UPID:create")
      .mockResolvedValueOnce("UPID:start");
    jest.spyOn(backend, "_waitForTask").mockResolvedValue(undefined);
    jest.spyOn(backend, "_ownsCreatedLxc").mockResolvedValue(true);
    jest.spyOn(backend, "_waitForIp").mockResolvedValue("10.20.30.41");
    jest.spyOn(backend, "_bootstrapOpenClaw").mockResolvedValue({
      gatewayToken: "gateway-token",
      runtimePort: 9090,
      gatewayPort: 18789,
    });
    const onRuntimeIdentity = jest.fn().mockResolvedValue(undefined);
    const mcpServers = [
      {
        name: "gitlab",
        npmPackage: "@modelcontextprotocol/server-gitlab",
        env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-proxmox" },
      },
    ];

    const result = await backend.create({
      id: "agent-1",
      name: "Promo Agent\nnora-agent:v1:attacker\nnora-owner:attacker",
      container_name: "promo-agent",
      image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
      vcpu: 4,
      ram_mb: 4096,
      disk_gb: 32,
      runtimeFamily: "openclaw",
      sandboxProfile: "standard",
      env: { AGENT_ID: "agent-1" },
      mcpServers,
      onRuntimeIdentity,
    });

    expect(requestData.mock.calls[0]).toEqual([
      "POST",
      "/nodes/pve-a/lxc",
      expect.objectContaining({
        vmid: "101",
        hostname: "promo-agent",
        ostemplate: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
        unprivileged: 1,
        start: 0,
        description: expect.stringContaining(ownershipMarkerFor("agent-1")),
      }),
      expect.any(Object),
    ]);
    const description = requestData.mock.calls[0][2].description;
    expect(description).toMatch(/\nnora-owner:[a-f0-9]{32}$/);
    expect(description).not.toContain("\nnora-agent:v1:attacker");
    expect(description).not.toContain("\nnora-owner:attacker");
    expect(description.split("\n").filter((line) => line.startsWith("nora-agent:"))).toHaveLength(
      1,
    );
    expect(description.split("\n").filter((line) => line.startsWith("nora-owner:"))).toHaveLength(
      1,
    );
    expect(backend._ownsCreatedLxc).toHaveBeenCalledWith(
      "101",
      ownershipMarkerFor("agent-1"),
      expect.objectContaining({
        createOwnershipMarker: expect.stringMatching(/^nora-owner:[a-f0-9]{32}$/),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        containerId: "101",
        containerName: "promo-agent",
        host: "10.20.30.41",
        runtimeHost: "10.20.30.41",
        runtimePort: 9090,
      }),
    );
    expect(onRuntimeIdentity).toHaveBeenCalledWith({
      containerId: "101",
      containerName: "promo-agent",
    });
    expect(backend._bootstrapOpenClaw).toHaveBeenCalledWith(
      "101",
      expect.objectContaining({ mcpServers }),
    );
  });

  it("cleans up a partially created LXC and honors an already-aborted create", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("102");
    let description;
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath, payload) => {
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc") {
        description = payload.description;
        return "UPID:create";
      }
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc/102/status/start") {
        return "UPID:start";
      }
      if (method === "GET" && requestPath === "/nodes/pve-a/lxc/102/config") {
        return { description };
      }
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    jest.spyOn(backend, "_waitForTask").mockResolvedValue(undefined);
    jest.spyOn(backend, "_waitForIp").mockResolvedValue("10.20.30.42");
    jest.spyOn(backend, "_bootstrapOpenClaw").mockRejectedValue(new Error("bootstrap failed"));
    const destroy = jest.spyOn(backend, "destroy").mockResolvedValue(undefined);

    await expect(
      backend.create({
        id: "agent-2",
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
      }),
    ).rejects.toThrow("bootstrap failed");
    expect(destroy).toHaveBeenCalledWith(
      "102",
      expect.objectContaining({
        agentId: "agent-2",
        createOwnershipMarker: expect.stringMatching(/^nora-owner:[a-f0-9]{32}$/),
      }),
    );

    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    await expect(
      new ProxmoxBackend().create({
        id: "agent-3",
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("operator cancelled");
  });

  it("does not destroy an unrelated LXC when nextid races and the create POST loses", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("102");
    const collision = Object.assign(new Error("VM 102 already exists"), { statusCode: 400 });
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockImplementation(async (method, requestPath) => {
        if (method === "POST" && requestPath === "/nodes/pve-a/lxc") throw collision;
        if (method === "GET" && requestPath === "/nodes/pve-a/lxc/102/config") {
          return { description: "Unrelated operator-managed LXC" };
        }
        throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
      });
    const destroy = jest.spyOn(backend, "destroy").mockResolvedValue(undefined);
    const onRuntimeIdentity = jest.fn();

    await expect(
      backend.create({
        id: "agent-collision",
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
        onRuntimeIdentity,
      }),
    ).rejects.toThrow("VM 102 already exists");

    expect(requestData).toHaveBeenCalledWith(
      "GET",
      "/nodes/pve-a/lxc/102/config",
      null,
      expect.objectContaining({
        createOwnershipMarker: expect.stringMatching(/^nora-owner:[a-f0-9]{32}$/),
      }),
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(onRuntimeIdentity).not.toHaveBeenCalled();
  });

  it("does not destroy an older LXC for the same agent when nextid collides", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-same-id";
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("102");
    const collision = Object.assign(new Error("VM 102 already exists"), { statusCode: 400 });
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc") throw collision;
      if (method === "GET" && requestPath === "/nodes/pve-a/lxc/102/config") {
        return {
          description: `${ownershipMarkerFor(agentId)}\nnora-owner:${"a".repeat(32)}`,
        };
      }
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const destroy = jest.spyOn(backend, "destroy").mockResolvedValue(undefined);

    await expect(
      backend.create({
        id: agentId,
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
      }),
    ).rejects.toThrow("VM 102 already exists");

    expect(destroy).not.toHaveBeenCalled();
  });

  it("preserves the VMID when a create request has an ambiguous transport failure", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("103");
    const transportError = new Error("socket hang up after request write");
    const missing = Object.assign(new Error("configuration not visible yet"), {
      statusCode: 404,
    });
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc") throw transportError;
      if (method === "GET" && requestPath === "/nodes/pve-a/lxc/103/config") throw missing;
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const destroy = jest.spyOn(backend, "destroy").mockResolvedValue(undefined);

    await expect(
      backend.create({
        id: "agent-ambiguous-create",
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
      }),
    ).rejects.toMatchObject({
      code: "PROXMOX_RUNTIME_OWNERSHIP_UNVERIFIED",
      containerId: "103",
      runtimeIdentity: {
        containerId: "103",
        destroyAllowed: false,
        persistIdentity: true,
      },
    });

    expect(destroy).not.toHaveBeenCalled();
  });

  it("persists an ambiguous VMID when ownership verification also fails", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("103");
    const transportError = new Error("socket hang up after request write");
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc") throw transportError;
      if (method === "GET" && requestPath === "/nodes/pve-a/lxc/103/config") {
        throw new Error("Proxmox API unavailable during ownership verification");
      }
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });

    await expect(
      backend.create({
        id: "agent-ambiguous-unverified",
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
      }),
    ).rejects.toMatchObject({
      code: "PROXMOX_RUNTIME_CLEANUP_FAILED",
      containerId: "103",
      runtimeIdentity: {
        containerId: "103",
        destroyAllowed: false,
        persistIdentity: true,
      },
    });
  });

  it("reports unresolved identity without deleting when cleanup ownership cannot be reverified", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_getNextVmid").mockResolvedValue("103");
    let description;
    let configReads = 0;
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath, payload) => {
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc") {
        description = payload.description;
        return "UPID:create";
      }
      if (method === "POST" && requestPath === "/nodes/pve-a/lxc/103/status/start") {
        return "UPID:start";
      }
      if (method === "GET" && requestPath === "/nodes/pve-a/lxc/103/config") {
        configReads += 1;
        if (configReads === 1) return { description };
        throw new Error("Proxmox API unavailable during cleanup verification");
      }
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    jest.spyOn(backend, "_waitForTask").mockResolvedValue(undefined);
    jest.spyOn(backend, "_waitForIp").mockResolvedValue("10.20.30.43");
    jest.spyOn(backend, "_bootstrapOpenClaw").mockRejectedValue(new Error("bootstrap failed"));
    const destroy = jest.spyOn(backend, "destroy").mockResolvedValue(undefined);

    await expect(
      backend.create({
        id: "agent-cleanup-uncertain",
        image: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
      }),
    ).rejects.toMatchObject({
      code: "PROXMOX_RUNTIME_CLEANUP_FAILED",
      containerId: "103",
      runtimeIdentity: {
        containerId: "103",
        destroyAllowed: false,
        persistIdentity: true,
      },
    });

    expect(destroy).not.toHaveBeenCalled();
  });

  it("requires an agent id before resolving a persisted Proxmox VMID", async () => {
    const backend = new ProxmoxBackend();
    const requestData = jest.spyOn(backend, "_requestData");

    await expect(backend.destroy("104")).rejects.toMatchObject({
      code: "PROXMOX_AGENT_ID_REQUIRED",
      statusCode: 400,
    });
    expect(requestData).not.toHaveBeenCalled();
  });

  it("refuses to destroy an LXC whose Nora ownership marker is missing", async () => {
    const backend = new ProxmoxBackend();
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockResolvedValue({ description: "Operator-managed LXC" });

    await expect(backend.destroy("104", { agentId: "agent-current" })).rejects.toMatchObject({
      code: "PROXMOX_RUNTIME_OWNERSHIP_MISMATCH",
      statusCode: 409,
      containerId: "104",
    });
    expect(requestData).toHaveBeenCalledTimes(1);
    expect(requestData).toHaveBeenCalledWith("GET", "/nodes/pve-a/lxc/104/config", null, {});
  });

  it.each([
    ["start", (backend) => backend.start("104", { agentId: "agent-current" })],
    ["stop", (backend) => backend.stop("104", { agentId: "agent-current" })],
    ["restart", (backend) => backend.restart("104", { agentId: "agent-current" })],
    ["destroy", (backend) => backend.destroy("104", { agentId: "agent-current" })],
    ["status", (backend) => backend.status("104", { agentId: "agent-current" })],
    ["stats", (backend) => backend.stats("104", { agentId: "agent-current" })],
    [
      "updateEnv",
      (backend) =>
        backend.updateEnv("104", { OPENAI_API_KEY: "secret" }, { agentId: "agent-current" }),
    ],
    ["logs", (backend) => backend.logs("104", { agentId: "agent-current" })],
    ["exec", (backend) => backend.exec("104", { cmd: ["true"], agentId: "agent-current" })],
  ])("refuses %s when a reused VMID belongs to a different agent", async (_name, invoke) => {
    const backend = new ProxmoxBackend();
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockResolvedValue({ description: ownershipMarkerFor("agent-previous") });

    await expect(invoke(backend)).rejects.toMatchObject({
      code: "PROXMOX_RUNTIME_OWNERSHIP_MISMATCH",
      containerId: "104",
    });
    expect(requestData).toHaveBeenCalledTimes(1);
    expect(requestData).toHaveBeenCalledWith("GET", "/nodes/pve-a/lxc/104/config", null, {});
  });

  it("re-verifies matching ownership before both stop and delete during destroy", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-owned";
    const marker = ownershipMarkerFor(agentId);
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockImplementation(async (method, requestPath) => {
        if (method === "GET" && requestPath === "/nodes/pve-a/lxc/104/config") {
          return { description: `Nora openclaw agent\n${marker}` };
        }
        if (method === "POST" && requestPath === "/nodes/pve-a/lxc/104/status/stop") {
          return "UPID:stop";
        }
        if (method === "DELETE" && requestPath === "/nodes/pve-a/lxc/104") {
          return "UPID:delete";
        }
        throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
      });
    const waitForTask = jest.spyOn(backend, "_waitForTask").mockResolvedValue(undefined);

    await expect(backend.destroy("104", { agentId })).resolves.toBeUndefined();

    expect(requestData.mock.calls.filter(([, path]) => path.endsWith("/config"))).toHaveLength(2);
    expect(requestData).toHaveBeenCalledWith("POST", "/nodes/pve-a/lxc/104/status/stop");
    expect(requestData).toHaveBeenCalledWith("DELETE", "/nodes/pve-a/lxc/104");
    expect(waitForTask).toHaveBeenNthCalledWith(1, "UPID:stop");
    expect(waitForTask).toHaveBeenNthCalledWith(2, "UPID:delete");
  });

  it("refuses to advertise NemoClaw when no enforced sandbox exists", async () => {
    const backend = new ProxmoxBackend();
    await expect(
      backend.create({
        id: "agent-nemo",
        image: "local:vztmpl/nora-nemoclaw.tar.zst",
        sandboxProfile: "nemoclaw",
      }),
    ).rejects.toThrow(/does not provide the enforced OpenShell sandbox/i);
  });

  it("keeps OpenClaw credentials out of the startup script and wires per-agent MCP", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_prepareOpenClawBase").mockResolvedValue(undefined);
    const writes = [];
    jest.spyOn(backend, "_writeFile").mockImplementation(async (...args) => writes.push(args));
    jest.spyOn(backend, "_pctExec").mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend._bootstrapOpenClaw("103", {
      id: "agent-3",
      env: {
        OPENAI_API_KEY: "sk-live-secret",
        MICROSOFT_FOUNDRY_API_KEY: "foundry-secret",
        MICROSOFT_FOUNDRY_BASE_URL: "https://example.openai.azure.com/openai/v1",
        MICROSOFT_FOUNDRY_DEPLOYMENT: "gpt-5.5-prod",
        AGENT_ID: "agent-3",
      },
      templatePayload: {},
      mcpServers: [
        {
          name: "gitlab",
          npmPackage: "@modelcontextprotocol/server-gitlab",
          env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-proxmox-secret" },
        },
      ],
    });

    const envWrite = writes.find(([, targetPath]) => targetPath === "/etc/nora/openclaw.env.b64");
    const startWrite = writes.find(
      ([, targetPath]) => targetPath === "/opt/openclaw-runtime/start.sh",
    );
    const providerBootstrapWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-provider-bootstrap.sh",
    );
    const prestartWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-prestart.sh",
    );
    const prestartReconcilerWrite = writes.find(
      ([, targetPath]) =>
        targetPath === "/opt/openclaw-runtime/lib/nora-proxmox-prestart-reconcile.js",
    );
    const prestartDropinWrite = writes.find(
      ([, targetPath]) =>
        targetPath === "/etc/systemd/system/nora-openclaw.service.d/10-nora-managed-state.conf",
    );
    const managedNamesWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-managed-env-names",
    );
    const gatewayConfigWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-gateway-config.json",
    );
    const serviceWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/systemd/system/nora-openclaw.service",
    );
    expect(envWrite[2]).not.toContain("sk-live-secret");
    const decodedRuntimeEnv = decodeEnvironmentFile(envWrite[2]);
    expect(decodedRuntimeEnv.OPENAI_API_KEY).toBe("sk-live-secret");
    const mcpAlias = Object.keys(decodedRuntimeEnv).find((name) => name.startsWith("NORA_MCP_"));
    expect(decodedRuntimeEnv[mcpAlias]).toBe("glpat-proxmox-secret");
    expect(decodedRuntimeEnv.OPENCLAW_GATEWAY_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(managedNamesWrite[2]).toBe(`${mcpAlias}\n`);
    expect(envWrite[3]).toBe("0600");
    expect(startWrite[2]).not.toContain("sk-live-secret");
    expect(startWrite[2]).not.toContain("foundry-secret");
    expect(startWrite[2]).not.toContain("glpat-proxmox-secret");
    expect(startWrite[2]).toContain("openclaw.env.b64");
    expect(startWrite[2]).not.toContain(".nora-proxmox-provider-bootstrap");
    expect(startWrite[2]).not.toContain("/etc/nora/openclaw-provider-bootstrap.sh");
    expect(startWrite[2]).toContain('const replaceKeys = new Set(["mcpServers"])');
    expect(startWrite[2]).toContain("delete next[key]");
    expect(startWrite[3]).toBe("0700");
    expect(gatewayConfigWrite[3]).toBe("0600");
    const mcpConfig = JSON.parse(gatewayConfigWrite[2]).mcpServers.gitlab;
    expect(mcpConfig.command).toBe("/usr/local/bin/nora-mcp-server");
    const mcpPayload = JSON.parse(Buffer.from(mcpConfig.args[0], "base64").toString("utf8"));
    expect(mcpPayload.npmPackage).toBe("@modelcontextprotocol/server-gitlab");
    expect(mcpPayload.envAliases.GITLAB_PERSONAL_ACCESS_TOKEN).toBe(mcpAlias);
    expect(JSON.stringify(mcpConfig)).not.toContain("glpat-proxmox-secret");
    expect(JSON.parse(gatewayConfigWrite[2]).gateway.auth).toBeUndefined();
    expect(providerBootstrapWrite[2]).not.toContain("foundry-secret");
    expect(providerBootstrapWrite[2]).toContain("secret-free systemd prestart hook");
    expect(providerBootstrapWrite[3]).toBe("0700");
    expect(prestartWrite[2]).not.toContain("sk-live-secret");
    expect(prestartWrite[2]).not.toContain("foundry-secret");
    expect(prestartWrite[2]).toContain("build-auth.js");
    expect(prestartWrite[2]).toContain("OPENCLAW_AUTH_SQLITE_RECONCILE");
    expect(prestartWrite[2]).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(prestartWrite[2]).toContain("nora-openclaw-operator-token");
    expect(prestartWrite[2]).toContain("paired.json");
    expect(prestartReconcilerWrite[2]).not.toContain("foundry-secret");
    expect(prestartReconcilerWrite[2]).toContain("buildDesiredProviders()");
    expect(spawnSync("node", ["--check", "-"], { input: prestartReconcilerWrite[2] }).status).toBe(
      0,
    );
    const reconcileFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nora-proxmox-reconcile-"));
    try {
      const fixtureConfigPath = path.join(reconcileFixture, "openclaw.json");
      const fixtureMarkerPath = path.join(reconcileFixture, "managed-model");
      const fixtureManagedNamesPath = path.join(reconcileFixture, "managed-env-names");
      fs.writeFileSync(
        fixtureConfigPath,
        JSON.stringify({
          env: {
            GITLAB_PERSONAL_ACCESS_TOKEN: "deleted-stale-secret",
            OPERATOR_MANUAL_VALUE: "preserve-me",
          },
        }),
      );
      fs.writeFileSync(fixtureManagedNamesPath, "GITLAB_PERSONAL_ACCESS_TOKEN\n");
      const fixtureScript = prestartReconcilerWrite[2]
        .replace(
          "const configPath = '/root/.openclaw/openclaw.json';",
          `const configPath = ${JSON.stringify(fixtureConfigPath)};`,
        )
        .replace(
          "const markerPath = '/root/.openclaw/.nora-managed-default-model';",
          `const markerPath = ${JSON.stringify(fixtureMarkerPath)};`,
        )
        .replace(
          'const managedEnvNamesPath = "/etc/nora/openclaw-managed-env-names";',
          `const managedEnvNamesPath = ${JSON.stringify(fixtureManagedNamesPath)};`,
        );
      const reconcile = spawnSync(process.execPath, ["-e", fixtureScript], {
        encoding: "utf8",
        env: {},
      });
      expect(reconcile.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixtureConfigPath, "utf8")).env).toEqual({
        OPERATOR_MANUAL_VALUE: "preserve-me",
      });
    } finally {
      fs.rmSync(reconcileFixture, { recursive: true, force: true });
    }
    expect(prestartDropinWrite[2]).toContain("ExecStartPre=/etc/nora/openclaw-prestart.sh");
    expect(
      writes.find(([, targetPath]) => targetPath === "/usr/local/bin/nora-mcp-server"),
    ).toBeDefined();
    expect(
      writes.find(([, targetPath]) => targetPath === "/root/.openclaw/devices/paired.json"),
    ).toBeUndefined();
    for (const [, targetPath, content] of writes) {
      if (targetPath === "/etc/nora/openclaw.env.b64") continue;
      expect(String(content)).not.toContain("sk-live-secret");
      expect(String(content)).not.toContain("foundry-secret");
      expect(String(content)).not.toContain("glpat-proxmox-secret");
    }
    expect(spawnSync("sh", ["-n"], { input: startWrite[2] }).status).toBe(0);
    expect(spawnSync("sh", ["-n"], { input: prestartWrite[2] }).status).toBe(0);
    expect(serviceWrite[2]).toContain("NoNewPrivileges=true");
    expect(serviceWrite[2]).toContain("UMask=0077");
  });

  it("removes template MCP entries when the agent has no enabled servers", async () => {
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_prepareOpenClawBase").mockResolvedValue(undefined);
    const writes = [];
    jest.spyOn(backend, "_writeFile").mockImplementation(async (...args) => writes.push(args));
    jest.spyOn(backend, "_pctExec").mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend._bootstrapOpenClaw("103", {
      id: "agent-without-mcp",
      env: { AGENT_ID: "agent-without-mcp" },
      templatePayload: {},
      mcpServers: [],
    });

    const gatewayConfigWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-gateway-config.json",
    );
    const startWrite = writes.find(
      ([, targetPath]) => targetPath === "/opt/openclaw-runtime/start.sh",
    );
    expect(JSON.parse(gatewayConfigWrite[2]).mcpServers).toEqual({});
    expect(startWrite[2]).toContain('const replaceKeys = new Set(["mcpServers"])');
    expect(startWrite[2]).toContain("delete next[key]");
  });

  it("streams file contents over SSH stdin instead of exposing secrets in pct argv", async () => {
    const backend = new ProxmoxBackend();
    const sshExec = jest
      .spyOn(backend, "_sshExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend._writeFile("103", "/etc/nora/secret", "never-put-this-in-argv", "0600");

    expect(sshExec.mock.calls[0][0]).not.toContain("never-put-this-in-argv");
    expect(sshExec.mock.calls[0][1].input.toString("utf8")).toBe("never-put-this-in-argv");
    expect(sshExec.mock.calls[0][0]).toContain("umask 077");
  });

  it("runs Hermes as its unprivileged user and keeps its dashboard loopback-only by default", async () => {
    process.env.PROXMOX_HERMES_TEMPLATE = "local:vztmpl/nora-hermes.tar.zst";
    const backend = new ProxmoxBackend();
    jest.spyOn(backend, "_prepareHermesBase").mockResolvedValue(undefined);
    const writes = [];
    jest.spyOn(backend, "_writeFile").mockImplementation(async (...args) => writes.push(args));
    jest.spyOn(backend, "_pctExec").mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const result = await backend._bootstrapHermes("104", {
      id: "agent-hermes",
      env: { OPENAI_API_KEY: "hermes-secret", AGENT_ID: "agent-hermes" },
    });

    const envWrite = writes.find(
      ([, targetPath]) => targetPath === "/opt/data/.nora-system-env.b64",
    );
    const startWrite = writes.find(([, targetPath]) => targetPath === "/opt/nora-hermes/start.sh");
    const serviceWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/systemd/system/nora-hermes.service",
    );
    const prestartWrite = writes.find(
      ([, targetPath]) => targetPath === "/opt/data/.nora-prestart.sh",
    );
    const prestartDropinWrite = writes.find(
      ([, targetPath]) =>
        targetPath === "/etc/systemd/system/nora-hermes.service.d/10-nora-managed-state.conf",
    );
    const coreEnv = decodeEnvironmentFile(envWrite[2]);
    expect(envWrite[2]).not.toContain("hermes-secret");
    expect(coreEnv.OPENAI_API_KEY).toBeUndefined();
    expect(Buffer.from(coreEnv.NORA_HERMES_MANAGED_ENV_B64, "base64").toString("utf8")).toContain(
      'OPENAI_API_KEY="hermes-secret"',
    );
    expect(startWrite[2]).not.toContain("hermes-secret");
    expect(startWrite[2]).toContain("dashboard --host 127.0.0.1");
    expect(spawnSync("sh", ["-n"], { input: startWrite[2] }).status).toBe(0);
    expect(prestartWrite[2]).not.toContain("hermes-secret");
    expect(prestartWrite[2]).toContain("NORA_HERMES_MANAGED_ENV_B64");
    expect(prestartWrite[2]).toContain(".nora-bootstrap-complete");
    expect(spawnSync("sh", ["-n"], { input: prestartWrite[2] }).status).toBe(0);
    expect(prestartDropinWrite[2]).toContain("ExecStartPre=/opt/data/.nora-prestart.sh");
    expect(serviceWrite[2]).toContain("User=hermes");
    expect(serviceWrite[2]).toContain("NoNewPrivileges=true");
    expect(result.dashboardPort).toBeNull();
  });

  it("merges env updates without placing secret values in the SSH command", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-env";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "running" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const writeFile = jest.spyOn(backend, "_writeFile").mockResolvedValue(undefined);
    const pctExec = jest
      .spyOn(backend, "_pctExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend.updateEnv("105", { OPENAI_API_KEY: "rotated-secret" }, { agentId });

    const patchWrite = writeFile.mock.calls.find(([, filePath]) => filePath.endsWith(".patch"));
    expect(patchWrite).toEqual([
      "105",
      expect.stringMatching(/^\/tmp\/nora-env-/),
      expect.not.stringContaining("rotated-secret"),
      "0600",
      expect.objectContaining({ agentId }),
    ]);
    expect(pctExec.mock.calls[0][1]).not.toContain("rotated-secret");
    expect(pctExec.mock.calls[0][1]).toContain("install -m 0600");
  });

  it("deletes absent managed keys even when the desired environment is empty", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-env-empty";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "running" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const writeFile = jest.spyOn(backend, "_writeFile").mockResolvedValue(undefined);
    const pctExec = jest
      .spyOn(backend, "_pctExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend.updateEnv(
      "105",
      {},
      {
        agentId,
        managedEnvNames: ["OPENAI_API_KEY", "GEMINI_API_KEY"],
      },
    );

    expect(
      writeFile.mock.calls.filter(([, filePath]) => filePath.startsWith("/tmp/")),
    ).toHaveLength(3);
    expect(writeFile.mock.calls[0]).toEqual([
      "105",
      expect.stringMatching(/^\/tmp\/nora-env-.*\.patch$/),
      "\n",
      "0600",
      expect.objectContaining({ agentId }),
    ]);
    expect(writeFile.mock.calls[1]).toEqual([
      "105",
      expect.stringMatching(/^\/tmp\/nora-env-.*\.keys$/),
      "GEMINI_API_KEY\nOPENAI_API_KEY\n",
      "0600",
      expect.objectContaining({ agentId }),
    ]);
    const command = pctExec.mock.calls[0][1];
    expect(command).toContain("!($1 in managed)");
    expect(command).toContain('awk \'NF { print }\' "$patch" >> "$tmp"');
    expect(command).toContain('install -m 0600 "$tmp" "$current"');
    expect(command).not.toContain("OPENAI_API_KEY=");
  });

  it("preserves unrelated Proxmox env entries while replacing the exact managed set", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-env-preserve";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "running" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    jest.spyOn(backend, "_writeFile").mockResolvedValue(undefined);
    const pctExec = jest
      .spyOn(backend, "_pctExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend.updateEnv(
      "105",
      { OPENAI_API_KEY: "rotated", EMPTY_EXACT_VALUE: "" },
      {
        agentId,
        managedEnvNames: ["OPENAI_API_KEY", "GEMINI_API_KEY", "EMPTY_EXACT_VALUE"],
      },
    );

    const command = pctExec.mock.calls[0][1];
    expect(command).toContain("!($1 in managed)");
    expect(command).not.toContain("rotated");
    expect(command).not.toMatch(/KEEP_UNRELATED|drop.*unmanaged/i);
  });

  it("stages exact managed state into a stopped LXC through a secret-free mounted-root command", async () => {
    process.env.PROXMOX_SSH_USER = "root";
    process.env.PROXMOX_SUDO = "";
    const backend = new ProxmoxBackend();
    const agentId = "agent-offline-env";
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockImplementation(async (method, requestPath) => {
        if (requestPath.endsWith("/config")) {
          return { description: ownershipMarkerFor(agentId) };
        }
        if (requestPath.endsWith("/status/current")) return { status: "stopped" };
        throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
      });
    const sshExec = jest
      .spyOn(backend, "_sshExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const pctExec = jest.spyOn(backend, "_pctExec");

    await backend.updateEnv(
      "105",
      { OPENAI_API_KEY: "rotated-offline-secret", NORA_DEFAULT_OPENCLAW_MODEL: "openai/gpt-5.5" },
      {
        agentId,
        runtimeFamily: "openclaw",
        managedEnvNames: ["OPENAI_API_KEY", "GEMINI_API_KEY", "NORA_DEFAULT_OPENCLAW_MODEL"],
        replaceManagedState: true,
      },
    );

    expect(pctExec).not.toHaveBeenCalled();
    expect(sshExec).toHaveBeenCalledTimes(1);
    const [command, sshOptions] = sshExec.mock.calls[0];
    expect(command).not.toContain("rotated-offline-secret");
    expect(command).toContain('"$pct_cmd" mount "$vmid"');
    expect(command).toContain('"$pct_cmd" unmount "$vmid"');
    expect(command).toContain('chown --reference="$reference"');
    expect(command).toContain('case "$parent/" in "$root/"*');
    expect(command).toContain('config_lock="/run/lock/lxc/pve-config-$vmid.lock"');
    expect(command.indexOf("flock -x 9")).toBeLessThan(command.indexOf("install_file env.merged"));
    expect(command).toContain("replace_managed_state=1");
    expect(command).not.toContain('cat -- "$names_target" >> "$stage/effective.keys"');
    expect(command).toContain('cat -- "$names_target" >> "$stage/names.merged"');
    expect(command.indexOf('"$pct_cmd" mount "$vmid"')).toBeLessThan(
      command.indexOf("install_file env.merged"),
    );
    expect(command.indexOf("install_file env.merged")).toBeLessThan(
      command.lastIndexOf('unmount "$vmid"'),
    );

    const archiveEntries = await extractTarEntries(sshOptions.input);
    expect(decodeEnvironmentFile(archiveEntries.get("env.patch").content)).toEqual({
      NORA_DEFAULT_OPENCLAW_MODEL: "openai/gpt-5.5",
      OPENAI_API_KEY: "rotated-offline-secret",
    });
    expect(archiveEntries.get("prestart.sh").content).not.toContain("rotated-offline-secret");
    expect(archiveEntries.get("prestart.sh").content).toContain("OPENCLAW_AUTH_SQLITE_RECONCILE");
    expect(archiveEntries.get("prestart-reconcile.js").content).toContain(
      "buildDesiredProviders()",
    );
    expect(archiveEntries.get("provider-bootstrap.sh").content).toContain(
      "secret-free systemd prestart hook",
    );
    expect(archiveEntries.get("dropin.conf").content).toContain(
      "ExecStartPre=/etc/nora/openclaw-prestart.sh",
    );
    expect(
      requestData.mock.calls.filter(([, requestPath]) => requestPath.endsWith("/config")),
    ).toHaveLength(2);
  });

  it("stages an explicit empty desired state for stopped Hermes before start", async () => {
    process.env.PROXMOX_SSH_USER = "root";
    process.env.PROXMOX_SUDO = "";
    const backend = new ProxmoxBackend();
    const agentId = "agent-offline-hermes";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "stopped" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const sshExec = jest
      .spyOn(backend, "_sshExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend.updateEnv(
      "106",
      {},
      {
        agentId,
        runtimeFamily: "hermes",
        managedEnvNames: ["OPENAI_API_KEY", "NORA_HERMES_MANAGED_ENV_B64"],
        replaceManagedState: true,
      },
    );

    const [command, sshOptions] = sshExec.mock.calls[0];
    expect(command).not.toContain("OPENAI_API_KEY=");
    expect(command).toContain("opt/data/.nora-system-env.b64");
    const archiveEntries = await extractTarEntries(sshOptions.input);
    expect(archiveEntries.get("env.patch").content).toBe("\n");
    expect(archiveEntries.get("env.keys").content).toBe(
      "NORA_HERMES_MANAGED_ENV_B64\nOPENAI_API_KEY\n",
    );
    expect(archiveEntries.get("prestart.sh").content).toContain(".nora-bootstrap-complete");
    expect(archiveEntries.get("dropin.conf").content).toContain(
      "ExecStartPre=/opt/data/.nora-prestart.sh",
    );
  });

  it("fails closed for stopped LXC staging without root or a strict helper", async () => {
    delete process.env.PROXMOX_OFFLINE_STAGE_COMMAND;
    const backend = new ProxmoxBackend();
    const agentId = "agent-offline-no-privilege";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "stopped" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const sshExec = jest.spyOn(backend, "_sshExec");

    await expect(
      backend.updateEnv(
        "107",
        {},
        { agentId, managedEnvNames: ["OPENAI_API_KEY"], replaceManagedState: true },
      ),
    ).rejects.toMatchObject({ code: "PROXMOX_OFFLINE_STAGE_PRIVILEGE_REQUIRED" });
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("uses only a configured strict helper for non-root stopped staging", async () => {
    process.env.PROXMOX_OFFLINE_STAGE_COMMAND = "/usr/local/libexec/nora-proxmox-stage";
    const backend = new ProxmoxBackend();
    const agentId = "agent-offline-helper";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "stopped" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    const sshExec = jest
      .spyOn(backend, "_sshExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend.updateEnv(
      "108",
      {},
      { agentId, managedEnvNames: ["OPENAI_API_KEY"], replaceManagedState: true },
    );

    expect(sshExec.mock.calls[0][0]).toBe(
      "'sudo' '-n' '/usr/local/libexec/nora-proxmox-stage' '108' 'openclaw' '1'",
    );
    expect(sshExec.mock.calls[0][0]).not.toContain("/bin/sh -lc");
  });

  it("does not report stopped staging success when SSH completion or unmount is uncertain", async () => {
    process.env.PROXMOX_SSH_USER = "root";
    process.env.PROXMOX_SUDO = "";
    const backend = new ProxmoxBackend();
    const agentId = "agent-offline-uncertain";
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        return { description: ownershipMarkerFor(agentId) };
      }
      if (requestPath.endsWith("/status/current")) return { status: "stopped" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    jest.spyOn(backend, "_sshExec").mockRejectedValue(
      Object.assign(new Error("SSH channel closed before pct unmount exit"), {
        code: "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED",
      }),
    );

    await expect(
      backend.updateEnv(
        "109",
        {},
        { agentId, managedEnvNames: ["OPENAI_API_KEY"], replaceManagedState: true },
      ),
    ).rejects.toMatchObject({
      code: "PROXMOX_OFFLINE_STAGE_UNCONFIRMED",
      containerId: "109",
    });
  });

  it("fails closed when a mounted lock remains after stopped staging", async () => {
    process.env.PROXMOX_SSH_USER = "root";
    process.env.PROXMOX_SUDO = "";
    const backend = new ProxmoxBackend();
    const agentId = "agent-offline-lock";
    let configReads = 0;
    jest.spyOn(backend, "_requestData").mockImplementation(async (method, requestPath) => {
      if (requestPath.endsWith("/config")) {
        configReads += 1;
        return {
          description: ownershipMarkerFor(agentId),
          ...(configReads > 1 ? { lock: "mounted" } : {}),
        };
      }
      if (requestPath.endsWith("/status/current")) return { status: "stopped" };
      throw new Error(`Unexpected Proxmox request: ${method} ${requestPath}`);
    });
    jest.spyOn(backend, "_sshExec").mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await expect(
      backend.updateEnv(
        "110",
        {},
        { agentId, managedEnvNames: ["OPENAI_API_KEY"], replaceManagedState: true },
      ),
    ).rejects.toMatchObject({
      code: "PROXMOX_OFFLINE_STAGE_LOCK_REMAINS",
      containerId: "110",
    });
  });

  it("quotes command strings inside the guest and provides a separate stdin stream", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-exec";
    jest
      .spyOn(backend, "_requestData")
      .mockResolvedValue({ description: ownershipMarkerFor(agentId) });
    const stream = new PassThrough();
    const stdin = new PassThrough();
    const inspect = jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 });
    const resize = jest.fn();
    const open = jest.spyOn(backend, "_openSshStream").mockReturnValue({
      stream,
      stdin,
      inspect,
      resize,
    });

    const result = await backend.exec("106", {
      cmd: "printf safe; uname",
      tty: false,
      agentId,
    });

    expect(open.mock.calls[0][0]).toContain(
      "'pct' 'exec' '106' '--' '/bin/sh' '-lc' 'printf safe; uname'",
    );
    expect(result.stream).toBe(stream);
    expect(result.stdin).toBe(stdin);
    await expect(result.exec.inspect()).resolves.toEqual({ Running: false, ExitCode: 0 });
    await expect(backend.exec("106; rm -rf /", { cmd: ["true"], agentId })).rejects.toThrow(/VMID/);
  });

  it("clamps log tails and does not hide API authentication failures as stopped", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-observe";
    const stream = new PassThrough();
    const open = jest.spyOn(backend, "_openSshStream").mockReturnValue({ stream });
    const requestData = jest
      .spyOn(backend, "_requestData")
      .mockResolvedValueOnce({ description: ownershipMarkerFor(agentId) });
    await backend.logs("107", { tail: 999999, follow: false, agentId });
    expect(open.mock.calls[0][0]).toContain("'-n' '10000'");
    expect(open.mock.calls[0][0]).not.toContain("'-f'");

    const authError = Object.assign(new Error("forbidden"), { statusCode: 403 });
    requestData.mockRejectedValueOnce(authError);
    await expect(backend.status("107", { agentId })).rejects.toBe(authError);

    const missing = Object.assign(new Error("missing"), { statusCode: 404 });
    requestData.mockRejectedValueOnce(missing);
    await expect(backend.status("107", { agentId })).resolves.toEqual({
      running: false,
      uptime: 0,
      cpu: null,
      memory: null,
    });
  });
});
