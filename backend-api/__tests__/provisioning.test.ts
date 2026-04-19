// @ts-nocheck
const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  HERMES_DASHBOARD_PORT,
} = require("../../agent-runtime/lib/contracts");
const {
  waitForHttpReady,
  waitForAgentReadiness,
} = require("../../workers/provisioner/healthChecks");

const mockReadNamespace = jest.fn();
const mockCreateNamespace = jest.fn();
const mockCreateNamespacedDeployment = jest.fn();
const mockCreateNamespacedService = jest.fn();
const mockReadNamespacedService = jest.fn();

jest.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromFile() {}
    loadFromCluster() {}
    makeApiClient(api) {
      if (api === CoreV1Api) {
        return {
          readNamespace: mockReadNamespace,
          createNamespace: mockCreateNamespace,
          createNamespacedService: mockCreateNamespacedService,
          readNamespacedService: mockReadNamespacedService,
        };
      }
      if (api === AppsV1Api) {
        return {
          createNamespacedDeployment: mockCreateNamespacedDeployment,
        };
      }
      throw new Error("unexpected api client");
    }
  }

  class CoreV1Api {}
  class AppsV1Api {}

  return { KubeConfig, CoreV1Api, AppsV1Api };
}, { virtual: true });

describe("provisioning runtime/gateway contracts", () => {
  beforeEach(() => {
    mockReadNamespace.mockReset().mockResolvedValue({});
    mockCreateNamespace.mockReset().mockResolvedValue({});
    mockCreateNamespacedDeployment.mockReset().mockResolvedValue({});
    mockCreateNamespacedService.mockReset().mockResolvedValue({});
    mockReadNamespacedService.mockReset().mockResolvedValue({});
    delete process.env.GATEWAY_HOST;
    delete process.env.KUBECONFIG;
    delete process.env.K8S_NAMESPACE;
    delete process.env.K8S_EXPOSURE_MODE;
    delete process.env.K8S_RUNTIME_NODE_PORT;
    delete process.env.K8S_GATEWAY_NODE_PORT;
    delete process.env.K8S_RUNTIME_HOST;
  });

  it("clears the abort timer even when a readiness fetch fails", async () => {
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error("connection refused"));

    const result = await waitForHttpReady("http://agent.internal:9090/health", {
      attempts: 1,
      intervalMs: 1,
      timeoutMs: 25,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/i);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockRestore();
  });

  it("reports explicit timeout errors for readiness probes", async () => {
    const fetchImpl = jest.fn().mockImplementationOnce(async (_url, { signal }) => {
      return await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    });

    const result = await waitForHttpReady("http://agent.internal:9090/health", {
      attempts: 1,
      intervalMs: 1,
      timeoutMs: 5,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout after 5ms");
  });

  it("checks runtime on 9090 and gateway on the published control-plane port", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 401 });

    const readiness = await waitForAgentReadiness(
      { host: "agent.internal", gatewayHostPort: 19123 },
      {
        runtime: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
        gateway: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
      }
    );

    expect(readiness.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://agent.internal:${AGENT_RUNTIME_PORT}/health`);
    expect(fetchImpl.mock.calls[1][0]).toBe("http://host.docker.internal:19123/");
  });

  it("uses GATEWAY_HOST for published control-plane ports when provided", async () => {
    process.env.GATEWAY_HOST = "gateway.external";
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 403 });

    const readiness = await waitForAgentReadiness(
      { host: "agent.internal", gatewayHostPort: 19123 },
      {
        runtime: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
        gateway: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
      }
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.gateway.host).toBe("gateway.external");
    expect(fetchImpl.mock.calls[1][0]).toBe("http://gateway.external:19123/");
  });

  it("honors explicit runtime and gateway host overrides", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 403 });

    const readiness = await waitForAgentReadiness(
      {
        host: "agent.default",
        runtimeHost: "runtime.service",
        runtimePort: 9191,
        gatewayHost: "gateway.service",
        gatewayPort: 28789,
      },
      {
        runtime: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
        gateway: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
      }
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.runtime.host).toBe("runtime.service");
    expect(readiness.runtime.port).toBe(9191);
    expect(readiness.gateway.host).toBe("gateway.service");
    expect(readiness.gateway.port).toBe(28789);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://runtime.service:9191/health");
    expect(fetchImpl.mock.calls[1][0]).toBe("http://gateway.service:28789/");
  });

  it("can skip the gateway probe for runtime-only families", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({ status: 200 });

    const readiness = await waitForAgentReadiness(
      {
        host: "agent.internal",
        runtimeHost: "runtime.service",
        runtimePort: 8642,
        checkGateway: false,
      },
      {
        runtime: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
      }
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.gateway).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://runtime.service:8642/health");
  });

  it("publishes both runtime and gateway ports for kubernetes agents", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend();

    const result = await backend.create({
      id: "123",
      name: "Nora QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedService).toHaveBeenCalledTimes(1);

    const deployment = mockCreateNamespacedDeployment.mock.calls[0][1];
    const service = mockCreateNamespacedService.mock.calls[0][1];
    const container = deployment.spec.template.spec.containers[0];

    expect(container.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gateway", containerPort: OPENCLAW_GATEWAY_PORT }),
      expect.objectContaining({ name: "runtime", containerPort: AGENT_RUNTIME_PORT }),
    ]));
    expect(service.spec.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gateway", port: OPENCLAW_GATEWAY_PORT, targetPort: OPENCLAW_GATEWAY_PORT }),
      expect.objectContaining({ name: "runtime", port: AGENT_RUNTIME_PORT, targetPort: AGENT_RUNTIME_PORT }),
    ]));
    expect(result).toEqual(expect.objectContaining({
      host: "oclaw-agent-123.openclaw-agents.svc.cluster.local",
      runtimeHost: "oclaw-agent-123.openclaw-agents.svc.cluster.local",
      runtimePort: AGENT_RUNTIME_PORT,
      gatewayHost: "oclaw-agent-123.openclaw-agents.svc.cluster.local",
      gatewayPort: OPENCLAW_GATEWAY_PORT,
    }));
  });

  it("returns node-port endpoints for docker-hosted kind verification", async () => {
    process.env.K8S_EXPOSURE_MODE = "node-port";
    process.env.K8S_RUNTIME_NODE_PORT = "30909";
    process.env.K8S_GATEWAY_NODE_PORT = "31879";
    process.env.K8S_RUNTIME_HOST = "nora-kind-control-plane";
    mockCreateNamespacedService.mockResolvedValueOnce({
      body: {
        spec: {
          ports: [
            { name: "gateway", nodePort: 31879 },
            { name: "runtime", nodePort: 30909 },
          ],
        },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend();

    const result = await backend.create({
      id: "321",
      name: "NodePort QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    const service = mockCreateNamespacedService.mock.calls[0][1];

    expect(service.spec.type).toBe("NodePort");
    expect(service.spec.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gateway", nodePort: 31879 }),
      expect.objectContaining({ name: "runtime", nodePort: 30909 }),
    ]));
    expect(result).toEqual(expect.objectContaining({
      host: "oclaw-agent-321.openclaw-agents.svc.cluster.local",
      runtimeHost: "nora-kind-control-plane",
      runtimePort: 30909,
      gatewayHost: "nora-kind-control-plane",
      gatewayHostPort: 31879,
    }));
  });

  it("falls back to dynamic node ports when fixed node ports are already allocated", async () => {
    process.env.K8S_EXPOSURE_MODE = "node-port";
    process.env.K8S_RUNTIME_NODE_PORT = "30909";
    process.env.K8S_GATEWAY_NODE_PORT = "31879";
    process.env.K8S_RUNTIME_HOST = "nora-kind-control-plane";
    mockCreateNamespacedService
      .mockRejectedValueOnce({
        statusCode: 422,
        body: {
          reason: "Invalid",
          message: "Service \"oclaw-agent-654\" is invalid: spec.ports[0].nodePort: provided port is already allocated",
        },
      })
      .mockResolvedValueOnce({
        body: {
          spec: {
            ports: [
              { name: "gateway", nodePort: 32079 },
              { name: "runtime", nodePort: 32109 },
            ],
          },
        },
      });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend();

    const result = await backend.create({
      id: "654",
      name: "NodePort Fallback QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedService).toHaveBeenCalledTimes(2);

    const fixedService = mockCreateNamespacedService.mock.calls[0][1];
    const fallbackService = mockCreateNamespacedService.mock.calls[1][1];

    expect(fixedService.spec.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gateway", nodePort: 31879 }),
      expect.objectContaining({ name: "runtime", nodePort: 30909 }),
    ]));
    expect(fallbackService.spec.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gateway", port: OPENCLAW_GATEWAY_PORT, targetPort: OPENCLAW_GATEWAY_PORT }),
      expect.objectContaining({ name: "runtime", port: AGENT_RUNTIME_PORT, targetPort: AGENT_RUNTIME_PORT }),
    ]));
    expect(fallbackService.spec.ports.some((port) => port.nodePort != null)).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      host: "oclaw-agent-654.openclaw-agents.svc.cluster.local",
      runtimeHost: "nora-kind-control-plane",
      runtimePort: 32109,
      gatewayHost: "nora-kind-control-plane",
      gatewayHostPort: 32079,
    }));
  });
});

describe("Hermes dashboard provisioning", () => {
  it("starts the official Hermes dashboard alongside the gateway", async () => {
    const HermesBackend = require("../../workers/provisioner/backends/hermes");
    const backend = new HermesBackend();

    const createdContainer = {
      id: "hermes-container-1",
      start: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({
        NetworkSettings: {
          IPAddress: "10.0.0.50",
          Networks: {},
        },
      }),
      remove: jest.fn().mockResolvedValue({}),
    };
    const existingContainer = {
      inspect: jest.fn().mockRejectedValue(new Error("not found")),
    };
    const bridgeConnect = jest.fn().mockResolvedValue({});

    backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    backend.docker = {
      getImage: jest.fn().mockReturnValue({
        inspect: jest.fn().mockResolvedValue({}),
      }),
      getContainer: jest.fn().mockReturnValue(existingContainer),
      createContainer: jest.fn().mockResolvedValue(createdContainer),
      getNetwork: jest.fn().mockReturnValue({
        connect: bridgeConnect,
      }),
    };

    const result = await backend.create({
      id: "123",
      name: "Hermes QA",
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    const config = backend.docker.createContainer.mock.calls[0][0];

    expect(config.Env).toEqual(expect.arrayContaining([
      "GATEWAY_HEALTH_URL=http://127.0.0.1:8642",
    ]));
    expect(config.Entrypoint).toEqual(["/bin/bash", "-lc"]);
    expect(config.Cmd).toEqual([
      expect.stringContaining(
        "/opt/hermes/docker/entrypoint.sh dashboard --host 0.0.0.0 --insecure --no-open"
      ),
    ]);
    expect(config.Cmd[0]).toContain("chown -R hermes:hermes /opt/data/logs");
    expect(config.Cmd[0]).toContain(">> /proc/1/fd/1 2>> /proc/1/fd/2");
    expect(config.Cmd[0]).not.toContain("dashboard.log");
    expect(config.Cmd[0]).toContain(
      "exec /opt/hermes/docker/entrypoint.sh gateway run"
    );
    expect(config.ExposedPorts).toEqual({
      "8642/tcp": {},
      "9119/tcp": {},
    });
    expect(config.Labels).toEqual(
      expect.objectContaining({
        "nora.dashboard.port": String(HERMES_DASHBOARD_PORT),
      })
    );
    expect(bridgeConnect).toHaveBeenCalledWith({
      Container: "hermes-container-1",
    });
    expect(result).toEqual(
      expect.objectContaining({
        runtimeHost: "10.0.0.50",
        runtimePort: 8642,
      })
    );
  });
});
