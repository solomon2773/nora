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
const mockListNamespacedPod = jest.fn();
const mockCreateNamespacedDeployment = jest.fn();
const mockReadNamespacedDeployment = jest.fn();
const mockReplaceNamespacedDeployment = jest.fn();
const mockPatchNamespacedDeployment = jest.fn();
const mockDeleteNamespacedDeployment = jest.fn();
const mockCreateNamespacedService = jest.fn();
const mockReadNamespacedService = jest.fn();
const mockDeleteNamespacedService = jest.fn();
const mockCreateNamespacedConfigMap = jest.fn();
const mockReadNamespacedConfigMap = jest.fn();
const mockReplaceNamespacedConfigMap = jest.fn();
const mockDeleteNamespacedConfigMap = jest.fn();
const mockCreateNamespacedSecret = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockReplaceNamespacedSecret = jest.fn();
const mockDeleteNamespacedSecret = jest.fn();
const mockGetNamespacedCustomObject = jest.fn();
const mockLoadKubeconfigFromFile = jest.fn();

function k8sProfile(overrides = {}) {
  const namespace = overrides.namespace || "openclaw-agents";
  return {
    id: "test-cluster",
    executionTargetId: "k8s:test-cluster",
    label: "Test Kubernetes",
    kubeconfigPath: "/kubeconfigs/test-cluster",
    namespace,
    openclawNamespace: overrides.openclawNamespace || namespace,
    hermesNamespace: overrides.hermesNamespace || namespace,
    exposureMode: "cluster-ip",
    serviceAnnotations: {},
    loadBalancerSourceRanges: [],
    loadBalancerClass: "",
    loadBalancerReadyTimeoutMs: 600000,
    loadBalancerReadyIntervalMs: 5000,
    ...overrides,
  };
}

jest.mock(
  "@kubernetes/client-node",
  () => {
    class KubeConfig {
      loadFromFile(path) {
        return mockLoadKubeconfigFromFile(path);
      }
      loadFromCluster() {}
      makeApiClient(api) {
        if (api === CoreV1Api) {
          return {
            readNamespace: mockReadNamespace,
            createNamespace: mockCreateNamespace,
            listNamespacedPod: mockListNamespacedPod,
            createNamespacedService: mockCreateNamespacedService,
            readNamespacedService: mockReadNamespacedService,
            deleteNamespacedService: mockDeleteNamespacedService,
            createNamespacedConfigMap: mockCreateNamespacedConfigMap,
            readNamespacedConfigMap: mockReadNamespacedConfigMap,
            replaceNamespacedConfigMap: mockReplaceNamespacedConfigMap,
            deleteNamespacedConfigMap: mockDeleteNamespacedConfigMap,
            createNamespacedSecret: mockCreateNamespacedSecret,
            readNamespacedSecret: mockReadNamespacedSecret,
            replaceNamespacedSecret: mockReplaceNamespacedSecret,
            deleteNamespacedSecret: mockDeleteNamespacedSecret,
          };
        }
        if (api === AppsV1Api) {
          return {
            createNamespacedDeployment: mockCreateNamespacedDeployment,
            readNamespacedDeployment: mockReadNamespacedDeployment,
            replaceNamespacedDeployment: mockReplaceNamespacedDeployment,
            patchNamespacedDeployment: mockPatchNamespacedDeployment,
            deleteNamespacedDeployment: mockDeleteNamespacedDeployment,
          };
        }
        if (api === CustomObjectsApi) {
          return {
            getNamespacedCustomObject: mockGetNamespacedCustomObject,
          };
        }
        throw new Error("unexpected api client");
      }
    }

    class CoreV1Api {}
    class AppsV1Api {}
    class CustomObjectsApi {}

    return { KubeConfig, CoreV1Api, AppsV1Api, CustomObjectsApi };
  },
  { virtual: true },
);

describe("provisioning runtime/gateway contracts", () => {
  beforeEach(() => {
    mockReadNamespace.mockReset().mockResolvedValue({});
    mockCreateNamespace.mockReset().mockResolvedValue({});
    mockListNamespacedPod.mockReset().mockResolvedValue({ body: { items: [] } });
    mockCreateNamespacedDeployment.mockReset().mockResolvedValue({});
    mockReadNamespacedDeployment.mockReset().mockResolvedValue({
      body: { metadata: { resourceVersion: "deployment-rv" } },
    });
    mockReplaceNamespacedDeployment.mockReset().mockResolvedValue({});
    mockPatchNamespacedDeployment.mockReset().mockResolvedValue({});
    mockDeleteNamespacedDeployment.mockReset().mockResolvedValue({});
    mockCreateNamespacedService.mockReset().mockResolvedValue({});
    mockReadNamespacedService.mockReset().mockResolvedValue({});
    mockDeleteNamespacedService.mockReset().mockResolvedValue({});
    mockCreateNamespacedConfigMap.mockReset().mockResolvedValue({});
    mockReadNamespacedConfigMap.mockReset().mockResolvedValue({
      body: { metadata: { resourceVersion: "configmap-rv" } },
    });
    mockReplaceNamespacedConfigMap.mockReset().mockResolvedValue({});
    mockDeleteNamespacedConfigMap.mockReset().mockResolvedValue({});
    mockCreateNamespacedSecret.mockReset().mockResolvedValue({});
    mockReadNamespacedSecret.mockReset().mockResolvedValue({
      body: { metadata: { resourceVersion: "secret-rv" } },
    });
    mockReplaceNamespacedSecret.mockReset().mockResolvedValue({});
    mockDeleteNamespacedSecret.mockReset().mockResolvedValue({});
    mockGetNamespacedCustomObject.mockReset().mockResolvedValue({});
    mockLoadKubeconfigFromFile.mockReset().mockReturnValue(undefined);
    delete process.env.GATEWAY_HOST;
    delete process.env.NVIDIA_API_KEY;
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
        signal.addEventListener(
          "abort",
          () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
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
      },
    );

    expect(readiness.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://agent.internal:${AGENT_RUNTIME_PORT}/health`);
    expect(fetchImpl.mock.calls[1][0]).toBe("http://host.docker.internal:19123/");
  });

  it("reports missing mounted kubeconfig files with actionable guidance", () => {
    const missing = new Error(
      "ENOENT: no such file or directory, open '/kubeconfigs/aks-kubeconfig'",
    );
    missing.code = "ENOENT";
    mockLoadKubeconfigFromFile.mockImplementationOnce(() => {
      throw missing;
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");

    expect(() => {
      new K8sBackend(
        k8sProfile({
          label: "AKS East US 2",
          kubeconfigPath: "/kubeconfigs/aks-kubeconfig",
        }),
      );
    }).toThrow(
      /AKS East US 2 mounted kubeconfig file was not found at \/kubeconfigs\/aks-kubeconfig.*NORA_KUBECONFIGS_DIR/s,
    );
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
      },
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
      },
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
      },
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.gateway).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://runtime.service:8642/health");
  });

  it("publishes both runtime and gateway ports for kubernetes agents", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());

    const result = await backend.create({
      id: "123",
      name: "Nora QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedService).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedConfigMap).toHaveBeenCalledTimes(1);

    // v1.x @kubernetes/client-node uses object args; body is nested inside.
    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const service = mockCreateNamespacedService.mock.calls[0][0].body;
    const configMap = mockCreateNamespacedConfigMap.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];

    expect(configMap.data["bootstrap.sh"]).toContain("openclaw@latest");
    expect(configMap.data["bootstrap.sh"]).toContain("__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__");
    expect(configMap.data["bootstrap.sh"]).toContain("paste-api-key");
    expect(container.command).toEqual(["/bin/sh", "-c"]);
    expect(container.args).toEqual([". /opt/nora-bootstrap/bootstrap.sh"]);
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "nora-bootstrap", mountPath: "/opt/nora-bootstrap" }),
      ]),
    );
    expect(deployment.spec.template.spec.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "nora-bootstrap",
          configMap: expect.objectContaining({ name: "nora-oclaw-nora-qa-123-bootstrap" }),
        }),
      ]),
    );
    expect(container.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gateway", containerPort: OPENCLAW_GATEWAY_PORT }),
        expect.objectContaining({ name: "runtime", containerPort: AGENT_RUNTIME_PORT }),
      ]),
    );
    expect(service.spec.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "gateway",
          port: OPENCLAW_GATEWAY_PORT,
          targetPort: OPENCLAW_GATEWAY_PORT,
        }),
        expect.objectContaining({
          name: "runtime",
          port: AGENT_RUNTIME_PORT,
          targetPort: AGENT_RUNTIME_PORT,
        }),
      ]),
    );
    expect(result).toEqual(
      expect.objectContaining({
        host: "nora-oclaw-nora-qa-123.openclaw-agents.svc.cluster.local",
        runtimeHost: "nora-oclaw-nora-qa-123.openclaw-agents.svc.cluster.local",
        runtimePort: AGENT_RUNTIME_PORT,
        gatewayHost: "nora-oclaw-nora-qa-123.openclaw-agents.svc.cluster.local",
        gatewayPort: OPENCLAW_GATEWAY_PORT,
      }),
    );
  });

  it("returns node-port endpoints for docker-hosted kind verification", async () => {
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
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "node-port",
        runtimeNodePort: 30909,
        gatewayNodePort: 31879,
        runtimeHost: "nora-kind-control-plane",
      }),
    );

    const result = await backend.create({
      id: "321",
      name: "NodePort QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    const service = mockCreateNamespacedService.mock.calls[0][0].body;

    expect(service.spec.type).toBe("NodePort");
    expect(service.spec.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gateway", nodePort: 31879 }),
        expect.objectContaining({ name: "runtime", nodePort: 30909 }),
      ]),
    );
    expect(result).toEqual(
      expect.objectContaining({
        host: "nora-oclaw-nodeport-qa-321.openclaw-agents.svc.cluster.local",
        runtimeHost: "nora-kind-control-plane",
        runtimePort: 30909,
        gatewayHost: "nora-kind-control-plane",
        gatewayHostPort: 31879,
      }),
    );
  });

  it("falls back to dynamic node ports when fixed node ports are already allocated", async () => {
    mockCreateNamespacedService
      .mockRejectedValueOnce({
        statusCode: 422,
        body: {
          reason: "Invalid",
          message:
            'Service "nora-oclaw-nodeport-fallback-qa-654" is invalid: spec.ports[0].nodePort: provided port is already allocated',
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
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "node-port",
        runtimeNodePort: 30909,
        gatewayNodePort: 31879,
        runtimeHost: "nora-kind-control-plane",
      }),
    );

    const result = await backend.create({
      id: "654",
      name: "NodePort Fallback QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedService).toHaveBeenCalledTimes(2);

    const fixedService = mockCreateNamespacedService.mock.calls[0][0].body;
    const fallbackService = mockCreateNamespacedService.mock.calls[1][0].body;

    expect(fixedService.spec.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gateway", nodePort: 31879 }),
        expect.objectContaining({ name: "runtime", nodePort: 30909 }),
      ]),
    );
    expect(fallbackService.spec.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "gateway",
          port: OPENCLAW_GATEWAY_PORT,
          targetPort: OPENCLAW_GATEWAY_PORT,
        }),
        expect.objectContaining({
          name: "runtime",
          port: AGENT_RUNTIME_PORT,
          targetPort: AGENT_RUNTIME_PORT,
        }),
      ]),
    );
    expect(fallbackService.spec.ports.some((port) => port.nodePort != null)).toBe(false);
    expect(result).toEqual(
      expect.objectContaining({
        host: "nora-oclaw-nodeport-fallback-qa-654.openclaw-agents.svc.cluster.local",
        runtimeHost: "nora-kind-control-plane",
        runtimePort: 32109,
        gatewayHost: "nora-kind-control-plane",
        gatewayHostPort: 32079,
      }),
    );
  });

  it("returns load-balancer endpoints for cloud kubernetes services", async () => {
    mockCreateNamespacedService.mockResolvedValueOnce({
      body: {
        spec: {
          ports: [
            { name: "gateway", port: OPENCLAW_GATEWAY_PORT },
            { name: "runtime", port: AGENT_RUNTIME_PORT },
          ],
        },
      },
    });
    mockReadNamespacedService.mockResolvedValueOnce({
      body: {
        status: {
          loadBalancer: {
            ingress: [{ hostname: "agent-lb.example.elb.amazonaws.com" }],
          },
        },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        serviceAnnotations: {
          "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
        },
        loadBalancerSourceRanges: ["203.0.113.10/32", "198.51.100.0/24"],
        loadBalancerClass: "eks.amazonaws.com/nlb",
        loadBalancerReadyTimeoutMs: 50,
        loadBalancerReadyIntervalMs: 1,
      }),
    );

    const result = await backend.create({
      id: "789",
      name: "LoadBalancer QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    const service = mockCreateNamespacedService.mock.calls[0][0].body;

    expect(service.metadata.annotations).toEqual({
      "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
    });
    expect(service.spec).toEqual(
      expect.objectContaining({
        type: "LoadBalancer",
        loadBalancerSourceRanges: ["203.0.113.10/32", "198.51.100.0/24"],
        loadBalancerClass: "eks.amazonaws.com/nlb",
      }),
    );
    expect(service.spec.ports.some((port) => port.nodePort != null)).toBe(false);
    expect(mockReadNamespacedService).toHaveBeenCalledWith({
      name: "nora-oclaw-loadbalancer-qa-789",
      namespace: "openclaw-agents",
    });
    expect(result).toEqual(
      expect.objectContaining({
        host: "nora-oclaw-loadbalancer-qa-789.openclaw-agents.svc.cluster.local",
        runtimeHost: "agent-lb.example.elb.amazonaws.com",
        runtimePort: AGENT_RUNTIME_PORT,
        gatewayHost: "agent-lb.example.elb.amazonaws.com",
        gatewayPort: OPENCLAW_GATEWAY_PORT,
      }),
    );
  });

  it("deploys NemoClaw through the kubernetes adapter when selected as a sandbox", async () => {
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    mockCreateNamespacedService.mockResolvedValueOnce({
      body: {
        status: {
          loadBalancer: {
            ingress: [{ ip: "192.0.2.24" }],
          },
        },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        loadBalancerReadyTimeoutMs: 50,
        loadBalancerReadyIntervalMs: 1,
      }),
    );

    await backend.create({
      id: "nemo",
      name: "Nemo LoadBalancer QA",
      image: "registry.example.com/nora-nemoclaw-agent:stable",
      vcpu: 2,
      ram_mb: 2048,
      sandboxProfile: "nemoclaw",
      env: { NEMOCLAW_MODEL: "nvidia/test-model" },
    });

    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const configMap = mockCreateNamespacedConfigMap.mock.calls[0][0].body;
    const secret = mockCreateNamespacedSecret.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];
    const envVars = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
    const secretEnvVars = Object.fromEntries(
      container.env
        .filter((entry) => entry.valueFrom?.secretKeyRef)
        .map((entry) => [entry.name, entry.valueFrom.secretKeyRef]),
    );

    expect(container.image).toBe("registry.example.com/nora-nemoclaw-agent:stable");
    expect(container.workingDir).toBe("/sandbox");
    expect(envVars).toEqual(
      expect.objectContaining({
        HOME: "/sandbox",
        OPENCLAW_CLI_PATH: "/usr/bin/openclaw",
        OPENCLAW_TSX_BIN: "/usr/bin/tsx",
        NEMOCLAW_MODEL: "nvidia/test-model",
      }),
    );
    expect(envVars.NVIDIA_API_KEY).toBeUndefined();
    expect(secret.metadata.name).toBe("nora-oclaw-nemo-loadbalancer-qa-nemo-env");
    expect(secret.stringData).toEqual(
      expect.objectContaining({
        NVIDIA_API_KEY: "test-nvidia-key",
      }),
    );
    expect(secretEnvVars.NVIDIA_API_KEY).toEqual({
      name: "nora-oclaw-nemo-loadbalancer-qa-nemo-env",
      key: "NVIDIA_API_KEY",
    });
    expect(container.args).toEqual([". /opt/nora-bootstrap/bootstrap.sh"]);
    expect(configMap.data["bootstrap.sh"]).toContain("nemoclaw@latest");
  });

  it("returns cpu and memory telemetry from kubernetes pod metrics", async () => {
    mockReadNamespacedDeployment.mockResolvedValueOnce({
      body: {
        status: { availableReplicas: 1 },
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: "agent",
                  resources: {
                    limits: { cpu: "2000m", memory: "2048Mi" },
                  },
                },
              ],
            },
          },
        },
      },
    });
    mockListNamespacedPod.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: "oclaw-agent-123-pod" },
            status: {
              phase: "Running",
              startTime: "2026-05-20T07:00:00.000Z",
            },
          },
        ],
      },
    });
    mockGetNamespacedCustomObject.mockResolvedValueOnce({
      body: {
        timestamp: "2026-05-20T07:30:00.000Z",
        containers: [
          {
            name: "agent",
            usage: { cpu: "500m", memory: "1024Mi" },
          },
        ],
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());
    const telemetry = await backend.stats("oclaw-agent-123");

    expect(mockGetNamespacedCustomObject).toHaveBeenCalledWith({
      group: "metrics.k8s.io",
      version: "v1beta1",
      namespace: "openclaw-agents",
      plural: "pods",
      name: "oclaw-agent-123-pod",
    });
    expect(telemetry).toEqual(
      expect.objectContaining({
        backend_type: "k8s",
        capabilities: {
          cpu: true,
          memory: true,
          network: false,
          disk: false,
          pids: false,
        },
        current: expect.objectContaining({
          running: true,
          recorded_at: "2026-05-20T07:30:00.000Z",
          cpu_percent: 25,
          memory_usage_mb: 1024,
          memory_limit_mb: 2048,
          memory_percent: 50,
        }),
      }),
    );
  });

  it("falls back cleanly when kubernetes pod metrics are unavailable", async () => {
    mockReadNamespacedDeployment.mockResolvedValueOnce({
      body: {
        status: { availableReplicas: 1 },
        spec: {
          template: {
            spec: {
              containers: [{ name: "agent" }],
            },
          },
        },
      },
    });
    mockListNamespacedPod.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: "oclaw-agent-123-pod" },
            status: { phase: "Running" },
          },
        ],
      },
    });
    mockGetNamespacedCustomObject.mockRejectedValueOnce(new Error("metrics API unavailable"));

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());
    const telemetry = await backend.stats("oclaw-agent-123");

    expect(telemetry).toEqual(
      expect.objectContaining({
        backend_type: "k8s",
        capabilities: {
          cpu: false,
          memory: false,
          network: false,
          disk: false,
          pids: false,
        },
        current: expect.objectContaining({
          running: true,
          cpu_percent: null,
          memory_usage_mb: null,
          memory_limit_mb: null,
          memory_percent: null,
        }),
      }),
    );
  });

  it("rejects invalid kubernetes service annotations json", () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");

    expect(() => new K8sBackend(k8sProfile({ serviceAnnotations: "[]" }))).toThrow(
      "Kubernetes service annotations must be a JSON object",
    );
  });

  it("times out when a cloud load balancer address is not assigned", async () => {
    mockCreateNamespacedService.mockResolvedValueOnce({
      body: {
        status: {
          loadBalancer: {
            ingress: [],
          },
        },
      },
    });
    mockReadNamespacedService.mockResolvedValue({
      body: {
        status: {
          loadBalancer: {
            ingress: [],
          },
        },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        loadBalancerReadyTimeoutMs: 2,
        loadBalancerReadyIntervalMs: 1,
      }),
    );

    await expect(
      backend.create({
        id: "999",
        name: "Pending LoadBalancer QA",
        vcpu: 2,
        ram_mb: 2048,
        env: { OPENAI_API_KEY: "test-key" },
      }),
    ).rejects.toThrow(
      "Timed out waiting for K8s LoadBalancer address for nora-oclaw-pending-loadbalancer-qa-999",
    );
  });

  it("destroys previous Kubernetes resources in the namespace stored on the old host", async () => {
    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    const deleteIfLegacyNamespace = jest.fn(({ namespace }) =>
      namespace === "openclaw-agents" ? Promise.resolve({}) : Promise.reject(notFound),
    );

    mockDeleteNamespacedDeployment.mockImplementation(deleteIfLegacyNamespace);
    mockDeleteNamespacedService.mockImplementation(deleteIfLegacyNamespace);
    mockDeleteNamespacedConfigMap.mockImplementation(deleteIfLegacyNamespace);
    mockDeleteNamespacedSecret.mockImplementation(deleteIfLegacyNamespace);
    mockReadNamespacedDeployment.mockRejectedValue(notFound);
    mockReadNamespacedService.mockRejectedValue(notFound);
    mockReadNamespacedConfigMap.mockRejectedValue(notFound);
    mockReadNamespacedSecret.mockRejectedValue(notFound);

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        namespace: "nora-openclaw-agents",
        openclawNamespace: "nora-openclaw-agents",
        hermesNamespace: "nora-hermes-agents",
      }),
    );
    await backend.destroy("nora-oclaw-legacy-agent", {
      host: "nora-oclaw-legacy-agent.openclaw-agents.svc.cluster.local",
      runtimeFamily: "openclaw",
    });

    expect(mockDeleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-oclaw-legacy-agent",
        namespace: "openclaw-agents",
        propagationPolicy: "Foreground",
      }),
    );
    expect(mockDeleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-oclaw-legacy-agent",
        namespace: "openclaw-agents",
        propagationPolicy: "Foreground",
      }),
    );
    expect(mockDeleteNamespacedConfigMap).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-oclaw-legacy-agent-bootstrap",
        namespace: "openclaw-agents",
        propagationPolicy: "Foreground",
      }),
    );
    expect(mockDeleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-oclaw-legacy-agent-env",
        namespace: "openclaw-agents",
        propagationPolicy: "Foreground",
      }),
    );
  });

  it("stops Kubernetes deployments in the namespace stored on the agent host", async () => {
    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    mockPatchNamespacedDeployment.mockImplementation(({ namespace }) =>
      namespace === "legacy-openclaw" ? Promise.resolve({}) : Promise.reject(notFound),
    );
    mockReadNamespacedDeployment.mockResolvedValue({
      body: {
        spec: { replicas: 0 },
        status: { replicas: 0, readyReplicas: 0, availableReplicas: 0, updatedReplicas: 0 },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        namespace: "nora-openclaw-agents",
        openclawNamespace: "nora-openclaw-agents",
        hermesNamespace: "nora-hermes-agents",
      }),
    );

    await backend.stop("nora-oclaw-legacy-agent", {
      host: "nora-oclaw-legacy-agent.legacy-openclaw.svc.cluster.local",
      runtimeFamily: "openclaw",
    });

    expect(mockPatchNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-oclaw-legacy-agent",
        namespace: "legacy-openclaw",
        body: [{ op: "replace", path: "/spec/replicas", value: 0 }],
      }),
    );
  });

  it("reports Kubernetes pod replicas from the namespace stored on the agent host", async () => {
    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    mockReadNamespacedDeployment.mockImplementation(({ namespace }) =>
      namespace === "legacy-openclaw"
        ? Promise.resolve({
            body: {
              spec: { replicas: 3 },
              status: {
                replicas: 3,
                readyReplicas: 2,
                availableReplicas: 2,
                updatedReplicas: 3,
              },
            },
          })
        : Promise.reject(notFound),
    );

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        namespace: "nora-openclaw-agents",
        openclawNamespace: "nora-openclaw-agents",
        hermesNamespace: "nora-hermes-agents",
      }),
    );

    const status = await backend.status("nora-oclaw-legacy-agent", {
      host: "nora-oclaw-legacy-agent.legacy-openclaw.svc.cluster.local",
      runtimeFamily: "openclaw",
    });

    expect(status).toEqual({
      running: true,
      uptime: null,
      cpu: null,
      memory: null,
      replicas: {
        specReplicas: 3,
        replicas: 3,
        readyReplicas: 2,
        availableReplicas: 2,
        updatedReplicas: 3,
      },
    });
    expect(mockReadNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-oclaw-legacy-agent",
        namespace: "legacy-openclaw",
      }),
    );
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

    expect(config.Env).toEqual(
      expect.arrayContaining(["GATEWAY_HEALTH_URL=http://127.0.0.1:8642"]),
    );
    expect(config.Entrypoint).toBeUndefined();
    expect(config.Cmd).toEqual([
      "bash",
      "-lc",
      expect.stringContaining('HERMES_BIN="/opt/hermes/.venv/bin/hermes"'),
    ]);
    expect(config.Cmd[2]).toContain(
      'nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --insecure --no-open',
    );
    expect(config.Cmd[2]).toContain(">> /opt/data/hermes-dashboard.log 2>&1");
    expect(config.Cmd[2]).not.toContain("/proc/1/fd");
    expect(config.Cmd[2]).toContain('exec "$HERMES_BIN" gateway run');
    expect(config.Cmd.join(" ")).not.toContain("/opt/hermes/docker/entrypoint.sh");
    expect(config.ExposedPorts).toEqual({
      "8642/tcp": {},
      "9119/tcp": {},
    });
    expect(config.Labels).toEqual(
      expect.objectContaining({
        "nora.dashboard.port": String(HERMES_DASHBOARD_PORT),
      }),
    );
    expect(bridgeConnect).toHaveBeenCalledWith({
      Container: "hermes-container-1",
    });
    expect(result).toEqual(
      expect.objectContaining({
        runtimeHost: "10.0.0.50",
        runtimePort: 8642,
      }),
    );
  });
});

describe("docker gateway port allocation (BYOC Phase B)", () => {
  function mockDockerBackend() {
    const DockerBackend = require("../../workers/provisioner/backends/docker");
    const backend = new DockerBackend();
    backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    const createdContainer = {
      id: "oclaw-port-1",
      start: jest.fn().mockResolvedValue({}),
      putArchive: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({}),
      inspect: jest.fn().mockResolvedValue({
        NetworkSettings: {
          IPAddress: "10.0.0.7",
          Networks: {},
          Ports: { "18789/tcp": [{ HostPort: "19500" }] },
        },
      }),
    };
    backend.docker = {
      getImage: jest.fn().mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) }),
      getContainer: jest
        .fn()
        .mockReturnValue({ inspect: jest.fn().mockRejectedValue(new Error("not found")) }),
      createVolume: jest.fn().mockResolvedValue({}),
      createContainer: jest.fn().mockResolvedValue(createdContainer),
      getNetwork: jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue({}) }),
      getVolume: jest.fn().mockReturnValue({ remove: jest.fn().mockResolvedValue({}) }),
    };
    return backend;
  }

  it("publishes the worker-allocated host port", async () => {
    const backend = mockDockerBackend();
    await backend.create({ id: "999", name: "Port QA", gatewayHostPort: 19500, env: {} });
    const config = backend.docker.createContainer.mock.calls[0][0];
    expect(config.HostConfig.PortBindings["18789/tcp"]).toEqual([{ HostPort: "19500" }]);
  });

  it("falls back to the deterministic hash when no port is allocated", async () => {
    const backend = mockDockerBackend();
    // id "999" -> 19000 + (999 % 1000) = 19999
    await backend.create({ id: "999", name: "Port QA", env: {} });
    const config = backend.docker.createContainer.mock.calls[0][0];
    expect(config.HostConfig.PortBindings["18789/tcp"]).toEqual([{ HostPort: "19999" }]);
  });
});
