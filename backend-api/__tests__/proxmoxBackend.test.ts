// @ts-nocheck
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const https = require("https");
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
      name: "Promo Agent",
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
    const customProviderWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-custom-providers.json",
    );
    const gatewayConfigWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/nora/openclaw-gateway-config.json",
    );
    const serviceWrite = writes.find(
      ([, targetPath]) => targetPath === "/etc/systemd/system/nora-openclaw.service",
    );
    expect(envWrite[2]).not.toContain("sk-live-secret");
    expect(decodeEnvironmentFile(envWrite[2]).OPENAI_API_KEY).toBe("sk-live-secret");
    expect(envWrite[3]).toBe("0600");
    expect(startWrite[2]).not.toContain("sk-live-secret");
    expect(startWrite[2]).not.toContain("foundry-secret");
    expect(startWrite[2]).not.toContain("glpat-proxmox-secret");
    expect(startWrite[2]).toContain("openclaw.env.b64");
    expect(startWrite[2]).toContain(".nora-proxmox-bootstrap-complete");
    expect(startWrite[2]).toContain('const replaceKeys = new Set(["mcpServers"])');
    expect(startWrite[2]).toContain("delete next[key]");
    expect(startWrite[3]).toBe("0700");
    expect(gatewayConfigWrite[3]).toBe("0600");
    expect(JSON.parse(gatewayConfigWrite[2]).mcpServers).toEqual({
      gitlab: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-gitlab"],
        env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-proxmox-secret" },
      },
    });
    expect(customProviderWrite[2]).toContain("foundry-secret");
    expect(customProviderWrite[3]).toBe("0600");
    expect(spawnSync("sh", ["-n"], { input: startWrite[2] }).status).toBe(0);
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
    const coreEnv = decodeEnvironmentFile(envWrite[2]);
    expect(envWrite[2]).not.toContain("hermes-secret");
    expect(coreEnv.OPENAI_API_KEY).toBeUndefined();
    expect(Buffer.from(coreEnv.NORA_HERMES_MANAGED_ENV_B64, "base64").toString("utf8")).toContain(
      'OPENAI_API_KEY="hermes-secret"',
    );
    expect(startWrite[2]).not.toContain("hermes-secret");
    expect(startWrite[2]).toContain("dashboard --host 127.0.0.1");
    expect(spawnSync("sh", ["-n"], { input: startWrite[2] }).status).toBe(0);
    expect(serviceWrite[2]).toContain("User=hermes");
    expect(serviceWrite[2]).toContain("NoNewPrivileges=true");
    expect(result.dashboardPort).toBeNull();
  });

  it("merges env updates without placing secret values in the SSH command", async () => {
    const backend = new ProxmoxBackend();
    const agentId = "agent-env";
    jest
      .spyOn(backend, "_requestData")
      .mockResolvedValue({ description: ownershipMarkerFor(agentId) });
    const writeFile = jest.spyOn(backend, "_writeFile").mockResolvedValue(undefined);
    const pctExec = jest
      .spyOn(backend, "_pctExec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    await backend.updateEnv("105", { OPENAI_API_KEY: "rotated-secret" }, { agentId });

    expect(writeFile).toHaveBeenCalledWith(
      "105",
      expect.stringMatching(/^\/tmp\/nora-env-/),
      expect.not.stringContaining("rotated-secret"),
      "0600",
    );
    expect(pctExec.mock.calls[0][1]).not.toContain("rotated-secret");
    expect(pctExec.mock.calls[0][1]).toContain("install -m 0600");
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

    expect(open.mock.calls[0][0]).toContain("pct exec 106 -- /bin/sh -lc 'printf safe; uname'");
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
    expect(open.mock.calls[0][0]).toContain("-n 10000");
    expect(open.mock.calls[0][0]).not.toContain(" -f ");

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
