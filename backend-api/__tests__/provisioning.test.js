const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
} = require("../../agent-runtime/lib/contracts");
const { waitForAgentReadiness } = require("../../workers/provisioner/healthChecks");

const mockReadNamespace = jest.fn();
const mockCreateNamespace = jest.fn();
const mockCreateNamespacedDeployment = jest.fn();
const mockCreateNamespacedService = jest.fn();

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
    delete process.env.GATEWAY_HOST;
    delete process.env.KUBECONFIG;
    delete process.env.K8S_NAMESPACE;
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
});
