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
const { waitForAgentReadiness: waitForBackendAgentReadiness } = require("../healthChecks");
const { DEFAULT_OPENCLAW_PACKAGE_SPEC } = require("../../agent-runtime/lib/openclawDefaults");
const { OPENCLAW_MANAGED_MCP_SERVERS_ENV } = require("../../agent-runtime/lib/runtimeBootstrap");

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
const mockCreateNamespacedNetworkPolicy = jest.fn();
const mockReadNamespacedNetworkPolicy = jest.fn();
const mockReplaceNamespacedNetworkPolicy = jest.fn();
const mockDeleteNamespacedNetworkPolicy = jest.fn();
const mockCreateNamespacedSecret = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockReplaceNamespacedSecret = jest.fn();
const mockDeleteNamespacedSecret = jest.fn();
const mockCreateNamespacedPersistentVolumeClaim = jest.fn();
const mockReadNamespacedPersistentVolumeClaim = jest.fn();
const mockDeleteNamespacedPersistentVolumeClaim = jest.fn();
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
    supportsNetworkPolicy: false,
    policyEngine: "",
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
            createNamespacedPersistentVolumeClaim: mockCreateNamespacedPersistentVolumeClaim,
            readNamespacedPersistentVolumeClaim: mockReadNamespacedPersistentVolumeClaim,
            deleteNamespacedPersistentVolumeClaim: mockDeleteNamespacedPersistentVolumeClaim,
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
        if (api === NetworkingV1Api) {
          return {
            createNamespacedNetworkPolicy: mockCreateNamespacedNetworkPolicy,
            readNamespacedNetworkPolicy: mockReadNamespacedNetworkPolicy,
            replaceNamespacedNetworkPolicy: mockReplaceNamespacedNetworkPolicy,
            deleteNamespacedNetworkPolicy: mockDeleteNamespacedNetworkPolicy,
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
    class NetworkingV1Api {}
    class CustomObjectsApi {}

    return { KubeConfig, CoreV1Api, AppsV1Api, NetworkingV1Api, CustomObjectsApi };
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
    mockCreateNamespacedNetworkPolicy.mockReset().mockResolvedValue({});
    mockReadNamespacedNetworkPolicy.mockReset().mockResolvedValue({
      body: { metadata: { name: "existing-networkpolicy", resourceVersion: "networkpolicy-rv" } },
    });
    mockReplaceNamespacedNetworkPolicy.mockReset().mockResolvedValue({});
    mockDeleteNamespacedNetworkPolicy.mockReset().mockResolvedValue({});
    mockCreateNamespacedSecret.mockReset().mockResolvedValue({});
    mockReadNamespacedSecret.mockReset().mockResolvedValue({
      body: { metadata: { resourceVersion: "secret-rv" } },
    });
    mockReplaceNamespacedSecret.mockReset().mockResolvedValue({});
    mockDeleteNamespacedSecret.mockReset().mockResolvedValue({});
    mockCreateNamespacedPersistentVolumeClaim.mockReset().mockResolvedValue({});
    // Reads only happen in _waitForDeleted; defaulting to 404 means "already
    // deleted" so destroy paths terminate immediately.
    mockReadNamespacedPersistentVolumeClaim
      .mockReset()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    mockDeleteNamespacedPersistentVolumeClaim.mockReset().mockResolvedValue({});
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

  it("stops readiness polling immediately when the before-attempt authorization hook fails", async () => {
    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    const beforeAttempt = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(revoked);
    const fetchImpl = jest.fn().mockResolvedValue({ status: 503 });

    await expect(
      waitForHttpReady("http://remote-agent.internal:9090/health", {
        attempts: 3,
        intervalMs: 1,
        timeoutMs: 25,
        fetchImpl,
        beforeAttempt,
      }),
    ).rejects.toBe(revoked);

    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rechecks authorization between runtime and gateway readiness probes", async () => {
    const revoked = Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
    });
    const beforeAttempt = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(revoked);
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });

    await expect(
      waitForAgentReadiness(
        { host: "remote-agent.internal", gatewayHostPort: 19123 },
        {
          beforeAttempt,
          runtime: { attempts: 1, intervalMs: 1, timeoutMs: 25, fetchImpl },
          gateway: { attempts: 1, intervalMs: 1, timeoutMs: 25, fetchImpl },
        },
      ),
    ).rejects.toBe(revoked);

    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it.each([
    ["provisioner", waitForAgentReadiness],
    ["backend", waitForBackendAgentReadiness],
  ])(
    "prefers the %s internal gateway endpoint over a loopback-published host port",
    async (_consumer, readinessFn) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 401 });

      const readiness = await readinessFn(
        {
          host: "agent.internal",
          runtimeHost: "agent.internal",
          runtimePort: AGENT_RUNTIME_PORT,
          gatewayHostPort: 19123,
          gatewayHost: "agent.internal",
          gatewayPort: OPENCLAW_GATEWAY_PORT,
        },
        {
          runtime: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
          gateway: { attempts: 1, intervalMs: 1, timeoutMs: 1, fetchImpl },
        },
      );

      expect(readiness.ok).toBe(true);
      expect(fetchImpl.mock.calls[1][0]).toBe(`http://agent.internal:${OPENCLAW_GATEWAY_PORT}/`);
      expect(readiness.gateway).toEqual(
        expect.objectContaining({ host: "agent.internal", port: OPENCLAW_GATEWAY_PORT }),
      );
    },
  );

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
      gatewayToken: "gateway-secret-sentinel",
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedService).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedConfigMap).toHaveBeenCalledTimes(1);

    // v1.x @kubernetes/client-node uses object args; body is nested inside.
    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const service = mockCreateNamespacedService.mock.calls[0][0].body;
    const configMap = mockCreateNamespacedConfigMap.mock.calls[0][0].body;
    const secret = mockCreateNamespacedSecret.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];

    expect(JSON.stringify(configMap)).not.toContain("test-key");
    expect(JSON.stringify(deployment)).not.toContain("test-key");
    expect(JSON.stringify(configMap)).not.toContain("gateway-secret-sentinel");
    expect(JSON.stringify(deployment)).not.toContain("gateway-secret-sentinel");
    expect(secret.stringData).toEqual(
      expect.objectContaining({
        OPENAI_API_KEY: "test-key",
        OPENCLAW_GATEWAY_TOKEN: "gateway-secret-sentinel",
      }),
    );

    expect(configMap.data["bootstrap.sh"]).toContain(DEFAULT_OPENCLAW_PACKAGE_SPEC);
    expect(configMap.data["bootstrap.sh"]).toContain("__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__");
    expect(configMap.data["bootstrap.sh"]).toContain("paste-api-key");
    expect(configMap.data["bootstrap.sh"]).toContain("__NORA_PRUNE_MANAGED_OPENCLAW_CONFIG_ENV__");
    expect(configMap.data["bootstrap.sh"]).toContain("NORA_K8S_MANAGED_ENV_B64");
    expect(
      configMap.data["bootstrap.sh"].indexOf("__NORA_PRUNE_MANAGED_OPENCLAW_CONFIG_ENV__"),
    ).toBeLessThan(configMap.data["bootstrap.sh"].lastIndexOf("gateway --port"));
    expect(configMap.metadata.labels["nora.sandbox.profile"]).toBe("standard");
    expect(container.command).toEqual(["/bin/sh", "-c"]);
    expect(container.args).toEqual([". /opt/nora-bootstrap/bootstrap.sh"]);
    expect(deployment.metadata.labels["nora.sandbox.profile"]).toBe("standard");
    expect(deployment.spec.template.metadata.labels["nora.sandbox.profile"]).toBe("standard");
    expect(deployment.spec.selector.matchLabels).toEqual({ "openclaw.agent.id": "123" });
    // Recreate: required for the RWO state volume and prevents RollingUpdate
    // surge pods sticking Pending on full clusters.
    expect(deployment.spec.strategy).toEqual({ type: "Recreate" });
    expect(deployment.spec.template.spec.securityContext).toEqual({
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    // Agent state must survive pod replacement — a k8s restart is a rollout.
    expect(mockCreateNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(1);
    const pvc = mockCreateNamespacedPersistentVolumeClaim.mock.calls[0][0].body;
    expect(pvc.metadata.name).toBe("nora-oclaw-nora-qa-123-state");
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
    // Boot must not clobber persisted state: openclaw.json is seeded only
    // when absent.
    expect(configMap.data["bootstrap.sh"]).toContain("[ -f ~/.openclaw/openclaw.json ] ||");
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "nora-bootstrap", mountPath: "/opt/nora-bootstrap" }),
        expect.objectContaining({ name: "nora-agent-state", mountPath: "/root/.openclaw" }),
      ]),
    );
    expect(deployment.spec.template.spec.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "nora-bootstrap",
          configMap: expect.objectContaining({ name: "nora-oclaw-nora-qa-123-bootstrap" }),
        }),
        expect.objectContaining({
          name: "nora-agent-state",
          persistentVolumeClaim: expect.objectContaining({
            claimName: "nora-oclaw-nora-qa-123-state",
          }),
        }),
      ]),
    );
    expect(container.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gateway", containerPort: OPENCLAW_GATEWAY_PORT }),
        expect.objectContaining({ name: "runtime", containerPort: AGENT_RUNTIME_PORT }),
      ]),
    );
    // Pods must not report Ready before the gateway listens; cold boot gets a
    // startup budget so liveness can't kill the npm install.
    expect(container.startupProbe).toEqual(
      expect.objectContaining({ tcpSocket: { port: OPENCLAW_GATEWAY_PORT } }),
    );
    expect(container.readinessProbe).toEqual(
      expect.objectContaining({ tcpSocket: { port: OPENCLAW_GATEWAY_PORT } }),
    );
    expect(container.livenessProbe).toEqual(
      expect.objectContaining({ tcpSocket: { port: OPENCLAW_GATEWAY_PORT } }),
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

  it("keeps kubernetes MCP bootstrap secret-free until managed state is reconciled", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());

    await backend.create({
      id: "321",
      name: "MCP QA",
      vcpu: 2,
      ram_mb: 2048,
      env: {},
      mcpServers: [
        {
          name: "notion",
          npmPackage: "@notionhq/notion-mcp-server",
          env: { NOTION_TOKEN: "mcp-notion-secret-sentinel" },
        },
      ],
    });

    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const configMap = mockCreateNamespacedConfigMap.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];
    const script = configMap.data["bootstrap.sh"];
    const managedMcpEntry = container.env.find(
      (entry) => entry.name === OPENCLAW_MANAGED_MCP_SERVERS_ENV,
    );

    expect(JSON.parse(Buffer.from(managedMcpEntry.value, "base64").toString("utf8"))).toEqual({});
    expect(script).toContain(`process.env.${OPENCLAW_MANAGED_MCP_SERVERS_ENV}`);
    expect(script).toContain("delete server.env");
    expect(script).toContain("config.mcpServers = desiredMcpServers");
    expect(script).toContain("/usr/local/bin/nora-mcp-server");
    expect(script).not.toContain("@notionhq/notion-mcp-server");
    expect(script).not.toContain("NOTION_TOKEN");
    expect(script).not.toContain('"notion"');
    expect(JSON.stringify(configMap)).not.toContain("mcp-notion-secret-sentinel");
    expect(JSON.stringify(deployment)).not.toContain("mcp-notion-secret-sentinel");
  });

  it("routes sensitive updateEnv values into the env Secret instead of plaintext pod spec", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());

    mockReadNamespacedDeployment.mockResolvedValue({
      metadata: { name: "nora-oclaw-nora-qa-123" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "agent", env: [{ name: "OPENAI_API_KEY", value: "old" }] }],
          },
        },
      },
    });
    mockReadNamespacedSecret.mockResolvedValue({
      metadata: { name: "nora-oclaw-nora-qa-123-env", resourceVersion: "secret-rv" },
      type: "Opaque",
      data: { EXISTING_TOKEN: "b2xk" },
    });

    await backend.updateEnv("nora-oclaw-nora-qa-123", {
      OPENAI_API_KEY: "sk-new",
      PLAIN_SETTING: "value",
    });

    // Sensitive value merged into the Secret without dropping existing keys.
    const replacedSecret = mockReplaceNamespacedSecret.mock.calls[0][0].body;
    expect(replacedSecret.stringData).toEqual({ OPENAI_API_KEY: "sk-new" });
    expect(replacedSecret.data).toEqual({ EXISTING_TOKEN: "b2xk" });

    // Deployment env references the Secret; only non-sensitive values inline.
    const patch = mockPatchNamespacedDeployment.mock.calls[0][0].body;
    const envOp = patch.find((op) => op.path.includes("/env"));
    const sensitiveEntry = envOp.value.find((entry) => entry.name === "OPENAI_API_KEY");
    expect(sensitiveEntry.valueFrom).toEqual({
      secretKeyRef: {
        name: "nora-oclaw-nora-qa-123-env",
        key: "OPENAI_API_KEY",
        optional: true,
      },
    });
    expect(sensitiveEntry.value).toBeUndefined();
    expect(envOp.value).toContainEqual({ name: "PLAIN_SETTING", value: "value" });
  });

  it("replaces provider-owned env and Secret keys without removing unrelated settings", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());

    mockReadNamespacedDeployment.mockResolvedValue({
      metadata: { name: "nora-oclaw-nora-qa-123" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "agent",
                env: [
                  {
                    name: "OPENAI_API_KEY",
                    valueFrom: { secretKeyRef: { name: "env", key: "OPENAI_API_KEY" } },
                  },
                  { name: "OPENAI_BASE_URL", value: "https://old.example/v1" },
                  { name: "UNRELATED_SETTING", value: "keep-me" },
                ],
              },
            ],
          },
        },
      },
    });
    mockReadNamespacedSecret.mockResolvedValue({
      metadata: { name: "nora-oclaw-nora-qa-123-env", resourceVersion: "secret-rv" },
      type: "Opaque",
      data: { OPENAI_API_KEY: "b2xk", UNRELATED_TOKEN: "a2VlcA==" },
    });

    await backend.updateEnv(
      "nora-oclaw-nora-qa-123",
      { GEMINI_API_KEY: "gm-new" },
      {
        managedEnvNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY"],
      },
    );

    const replacedSecret = mockReplaceNamespacedSecret.mock.calls[0][0].body;
    expect(replacedSecret.data).toEqual({ UNRELATED_TOKEN: "a2VlcA==" });
    expect(replacedSecret.stringData).toEqual({ GEMINI_API_KEY: "gm-new" });

    const patch = mockPatchNamespacedDeployment.mock.calls[0][0].body;
    const envOp = patch.find((op) => op.path.endsWith("/env"));
    expect(envOp.value).toContainEqual({ name: "UNRELATED_SETTING", value: "keep-me" });
    expect(envOp.value).toContainEqual({
      name: "GEMINI_API_KEY",
      valueFrom: {
        secretKeyRef: {
          name: "nora-oclaw-nora-qa-123-env",
          key: "GEMINI_API_KEY",
          optional: true,
        },
      },
    });
    expect(envOp.value.some((entry) => entry.name === "OPENAI_API_KEY")).toBe(false);
    expect(envOp.value.some((entry) => entry.name === "OPENAI_BASE_URL")).toBe(false);
  });

  it("migrates the legacy managed-env annotation key to norafleet.ai on env update", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());

    // Deployment provisioned before the domain migration: managed-env names
    // tracked only under the legacy nora.solomontsao.com annotation key.
    mockReadNamespacedDeployment.mockResolvedValue({
      metadata: {
        name: "nora-oclaw-nora-qa-123",
        annotations: {
          "nora.solomontsao.com/managed-env-names": JSON.stringify(["LEGACY_MANAGED"]),
        },
      },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "agent",
                env: [
                  { name: "LEGACY_MANAGED", value: "old" },
                  { name: "UNRELATED_SETTING", value: "keep-me" },
                ],
              },
            ],
          },
        },
      },
    });
    mockReadNamespacedSecret.mockResolvedValue({
      metadata: { name: "nora-oclaw-nora-qa-123-env", resourceVersion: "secret-rv" },
      type: "Opaque",
      data: {},
    });

    await backend.updateEnv(
      "nora-oclaw-nora-qa-123",
      { GEMINI_API_KEY: "gm-new" },
      { managedEnvNames: ["GEMINI_API_KEY"] },
    );

    const patch = mockPatchNamespacedDeployment.mock.calls[0][0].body;
    const annotationsOp = patch.find((op) => op.path === "/metadata/annotations");
    // The legacy names must be read (fallback) and rewritten under the new key
    // only — leaving the legacy key behind would fork the tracking state.
    expect(JSON.parse(annotationsOp.value["norafleet.ai/managed-env-names"])).toEqual([
      "GEMINI_API_KEY",
      "LEGACY_MANAGED",
    ]);
    expect(annotationsOp.value["nora.solomontsao.com/managed-env-names"]).toBeUndefined();
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
        externalTrafficPolicy: "Local",
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
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
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
      credentialManagedEnvNames: ["NVIDIA_API_KEY"],
      env: { NEMOCLAW_MODEL: "nvidia/test-model" },
    });

    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const configMap = mockCreateNamespacedConfigMap.mock.calls[0][0].body;
    const secret = mockCreateNamespacedSecret.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];
    const envVars = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
    const policies = mockCreateNamespacedNetworkPolicy.mock.calls.map((call) => call[0].body);
    const secretEnvVars = Object.fromEntries(
      container.env
        .filter((entry) => entry.valueFrom?.secretKeyRef)
        .map((entry) => [entry.name, entry.valueFrom.secretKeyRef]),
    );

    expect(container.image).toBe("registry.example.com/nora-nemoclaw-agent:stable");
    expect(container.workingDir).toBe("/sandbox");
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(envVars).toEqual(
      expect.objectContaining({
        HOME: "/sandbox",
        OPENCLAW_CLI_PATH: "/usr/bin/openclaw",
        OPENCLAW_TSX_BIN: "/usr/bin/tsx",
        NEMOCLAW_MODEL: "nvidia/test-model",
      }),
    );
    expect(envVars.NVIDIA_API_KEY).toBeUndefined();
    expect(JSON.stringify(configMap)).not.toContain("test-nvidia-key");
    expect(JSON.stringify(deployment)).not.toContain("test-nvidia-key");
    expect(secret.metadata.name).toBe("nora-oclaw-nemo-loadbalancer-qa-nemo-env");
    expect(secret.stringData.NVIDIA_API_KEY).toBeUndefined();
    expect(secret.stringData.OPENCLAW_GATEWAY_TOKEN).toEqual(expect.any(String));
    expect(
      JSON.parse(
        Buffer.from(secret.stringData.NORA_K8S_MANAGED_ENV_B64, "base64").toString("utf8"),
      ),
    ).toEqual({ managedNames: ["NVIDIA_API_KEY"], values: {} });
    expect(secretEnvVars.NORA_K8S_MANAGED_ENV_B64).toEqual({
      name: "nora-oclaw-nemo-loadbalancer-qa-nemo-env",
      key: "NORA_K8S_MANAGED_ENV_B64",
      optional: true,
    });
    expect(secretEnvVars.NVIDIA_API_KEY).toBeUndefined();
    expect(container.args).toEqual([". /opt/nora-bootstrap/bootstrap.sh"]);
    expect(configMap.data["bootstrap.sh"]).toContain("nemoclaw@latest");
    expect(configMap.metadata.labels["nora.sandbox.profile"]).toBe("nemoclaw");
    expect(deployment.metadata.labels["nora.sandbox.profile"]).toBe("nemoclaw");
    expect(deployment.spec.template.metadata.labels["nora.sandbox.profile"]).toBe("nemoclaw");
    expect(policies).toHaveLength(5);
    expect(policies.map((policy) => policy.metadata.name)).toEqual(
      expect.arrayContaining([
        "nora-openclaw-default-deny-ingress",
        "nora-openclaw-allow-trusted-ingress",
        "nora-openclaw-nemoclaw-default-deny-egress",
        "nora-openclaw-nemoclaw-allow-dns",
        "nora-openclaw-nemoclaw-allow-external-web",
      ]),
    );
    expect(
      policies.find((policy) => policy.metadata.name === "nora-openclaw-allow-trusted-ingress").spec
        .ingress[0]._from,
    ).toEqual([{ ipBlock: { cidr: "203.0.113.10/32" } }]);
  });

  it("skips NetworkPolicy reconciliation and reports degraded policy status when the cluster does not advertise support", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());

    const result = await backend.create({
      id: "123",
      name: "Nora QA",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedNetworkPolicy).not.toHaveBeenCalled();
    expect(result.policyStatus).toBe("degraded");
    expect(result.policyBundleApplied).toBe(false);
    expect(result.policyIssue).toMatch(/degraded mode/i);
  });

  it("builds stable OpenClaw baseline NetworkPolicy objects with the expected selectors and ports", () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
      }),
    );

    const { policies, status } = backend._buildNetworkPolicies({
      runtimeFamily: "openclaw",
      sandboxProfile: "standard",
      namespace: "openclaw-agents",
    });

    expect(status).toEqual({
      policyStatus: "supported",
      policyBundleAttempted: true,
      policyBundleApplied: true,
      policyIssue: null,
    });
    expect(policies.map((policy) => policy.metadata.name)).toEqual([
      "nora-openclaw-default-deny-ingress",
      "nora-openclaw-allow-trusted-ingress",
    ]);
    expect(policies[0].spec).toEqual({
      podSelector: {
        matchLabels: {
          app: "openclaw-agent",
          "nora.kubernetes.cluster": "test-cluster",
        },
      },
      policyTypes: ["Ingress"],
    });
    expect(policies[1].spec.ingress[0]).toEqual({
      _from: [{ ipBlock: { cidr: "203.0.113.10/32" } }],
      ports: [
        { protocol: "TCP", port: OPENCLAW_GATEWAY_PORT },
        { protocol: "TCP", port: AGENT_RUNTIME_PORT },
      ],
    });
  });

  it("uses explicit trusted ingress CIDRs even for node-port targets", () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "node-port",
        runtimeHost: "172.26.0.2",
        supportsNetworkPolicy: true,
        policyEngine: "calico",
        loadBalancerSourceRanges: ["172.26.0.5/32"],
      }),
    );

    const { policies } = backend._buildNetworkPolicies({
      runtimeFamily: "openclaw",
      sandboxProfile: "standard",
      namespace: "openclaw-agents",
    });

    expect(policies[1].spec.ingress[0]._from).toEqual([{ ipBlock: { cidr: "172.26.0.5/32" } }]);
  });

  it("builds family-aware Hermes ingress policies with Hermes selectors and ports", () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
      }),
    );

    const { policies } = backend._buildNetworkPolicies({
      runtimeFamily: "hermes",
      sandboxProfile: "standard",
      namespace: "hermes-agents",
    });

    expect(policies.map((policy) => policy.metadata.name)).toEqual([
      "nora-hermes-default-deny-ingress",
      "nora-hermes-allow-trusted-ingress",
    ]);
    expect(policies[0].spec.podSelector.matchLabels).toEqual({
      app: "hermes-agent",
      "nora.kubernetes.cluster": "test-cluster",
    });
    expect(policies[1].spec.ingress[0].ports).toEqual([
      { protocol: "TCP", port: 8642 },
      { protocol: "TCP", port: HERMES_DASHBOARD_PORT },
    ]);
  });

  it("builds NemoClaw egress policies that target only NemoClaw-labeled OpenClaw pods", () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
      }),
    );

    const { policies } = backend._buildNetworkPolicies({
      runtimeFamily: "openclaw",
      sandboxProfile: "nemoclaw",
      namespace: "openclaw-agents",
    });

    expect(policies.map((policy) => policy.metadata.name)).toEqual([
      "nora-openclaw-default-deny-ingress",
      "nora-openclaw-allow-trusted-ingress",
      "nora-openclaw-nemoclaw-default-deny-egress",
      "nora-openclaw-nemoclaw-allow-dns",
      "nora-openclaw-nemoclaw-allow-external-web",
    ]);

    const denyEgress = policies.find(
      (policy) => policy.metadata.name === "nora-openclaw-nemoclaw-default-deny-egress",
    );
    const dnsAllow = policies.find(
      (policy) => policy.metadata.name === "nora-openclaw-nemoclaw-allow-dns",
    );

    expect(denyEgress.spec.podSelector.matchLabels).toEqual({
      app: "openclaw-agent",
      "nora.kubernetes.cluster": "test-cluster",
      "nora.sandbox.profile": "nemoclaw",
    });
    expect(denyEgress.spec.policyTypes).toEqual(["Egress"]);
    expect(dnsAllow.spec.egress).toEqual([
      {
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
    ]);
  });

  it("reconciles NetworkPolicy objects before creating the OpenClaw deployment", async () => {
    mockReadNamespacedService.mockResolvedValueOnce({
      body: {
        status: {
          loadBalancer: {
            ingress: [{ hostname: "phase3-openclaw-lb.example.com" }],
          },
        },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
      }),
    );

    const result = await backend.create({
      id: "phase3-openclaw",
      name: "Phase3 OpenClaw",
      vcpu: 2,
      ram_mb: 2048,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(mockCreateNamespacedNetworkPolicy).toHaveBeenCalledTimes(2);
    expect(mockCreateNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedNetworkPolicy.mock.invocationCallOrder[1]).toBeLessThan(
      mockCreateNamespacedDeployment.mock.invocationCallOrder[0],
    );
    expect(result.policyStatus).toBe("supported");
    expect(result.policyBundleAttempted).toBe(true);
    expect(result.policyBundleApplied).toBe(true);
  });

  it("reconciles family-aware ingress policies before creating the Hermes deployment", async () => {
    mockReadNamespacedService.mockResolvedValueOnce({
      body: {
        status: {
          loadBalancer: {
            ingress: [{ hostname: "phase3-hermes-lb.example.com" }],
          },
        },
      },
    });

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
        hermesNamespace: "hermes-agents",
      }),
    );

    const result = await backend.create({
      id: "phase3-hermes",
      name: "Phase3 Hermes",
      runtimeFamily: "hermes",
      vcpu: 2,
      ram_mb: 2048,
      env: {},
    });

    const policies = mockCreateNamespacedNetworkPolicy.mock.calls.map((call) => call[0].body);
    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];
    expect(policies.map((policy) => policy.metadata.name)).toEqual([
      "nora-hermes-default-deny-ingress",
      "nora-hermes-allow-trusted-ingress",
    ]);
    expect(deployment.spec.template.spec.securityContext).toEqual({
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: {
        drop: ["ALL"],
        add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
      },
    });
    expect(mockCreateNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedNetworkPolicy.mock.invocationCallOrder[1]).toBeLessThan(
      mockCreateNamespacedDeployment.mock.invocationCallOrder[0],
    );
    expect(result.policyStatus).toBe("supported");
  });

  it("launches Hermes under the image's PID-1 init without re-exec'ing /init", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile({ hermesNamespace: "hermes-agents" }));

    await backend.create({
      id: "hermes-init-guard",
      name: "Hermes Init Guard",
      runtimeFamily: "hermes",
      vcpu: 2,
      ram_mb: 2048,
      env: {},
    });

    // Bug #1 (#297): the pod must launch args-only so the image ENTRYPOINT
    // (/init, s6-overlay as PID 1) supervises the bootstrap. A nested /init in
    // the bootstrap script fatals with "s6-overlay-suexec: can only run as
    // pid 1" and kills the container before the runtime port can bind.
    const deployment = mockCreateNamespacedDeployment.mock.calls[0][0].body;
    const container = deployment.spec.template.spec.containers[0];
    expect(container.command).toBeUndefined();
    expect(container.args).toEqual(["bash", "-lc", ". /opt/nora-bootstrap/bootstrap.sh"]);

    const bootstrapConfigMap = mockCreateNamespacedConfigMap.mock.calls
      .map((call) => call[0].body)
      .find((body) => body?.metadata?.labels?.["nora.bootstrap"] === "true");
    expect(bootstrapConfigMap).toBeDefined();
    const script = bootstrapConfigMap.data["bootstrap.sh"];
    expect(script).not.toContain("/init");
    expect(script).toContain('nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open');
    expect(script).not.toContain("--insecure");
    expect(script).toContain('exec "$HERMES_BIN" gateway run');
  });

  it("replaces an existing NetworkPolicy instead of failing on redeploy", async () => {
    mockCreateNamespacedNetworkPolicy
      .mockRejectedValueOnce({
        statusCode: 409,
        body: { reason: "AlreadyExists", message: "already exists" },
      })
      .mockResolvedValue({});

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        exposureMode: "load-balancer",
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        loadBalancerSourceRanges: ["203.0.113.10/32"],
      }),
    );

    await backend._upsertNetworkPolicy(
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: {
          name: "nora-openclaw-default-deny-ingress",
          namespace: "openclaw-agents",
        },
        spec: {
          podSelector: { matchLabels: { app: "openclaw-agent" } },
          policyTypes: ["Ingress"],
        },
      },
      "openclaw-agents",
    );

    expect(mockReadNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "nora-openclaw-default-deny-ingress",
      namespace: "openclaw-agents",
    });
    expect(mockReplaceNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nora-openclaw-default-deny-ingress",
        namespace: "openclaw-agents",
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: "nora-openclaw-default-deny-ingress",
            resourceVersion: "networkpolicy-rv",
          }),
        }),
      }),
    );
  });

  it("builds operator-managed ingress policies with CIDR-scoped peer rules", () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
      }),
    );

    const policy = backend._buildOperatorIngressPolicy("openclaw", "openclaw-agents", [
      {
        cidr: "203.0.113.10/32",
        ports: [OPENCLAW_GATEWAY_PORT, AGENT_RUNTIME_PORT],
      },
    ]);

    expect(policy.metadata).toEqual(
      expect.objectContaining({
        name: "nora-openclaw-operator-allow-ingress",
        namespace: "openclaw-agents",
        labels: expect.objectContaining({
          "nora.policy.owner": "operator",
          "nora.policy.kind": "operator-ingress",
          "nora.runtime.family": "openclaw",
        }),
      }),
    );
    expect(policy.spec).toEqual({
      podSelector: {
        matchLabels: {
          app: "openclaw-agent",
          "nora.kubernetes.cluster": "test-cluster",
        },
      },
      policyTypes: ["Ingress"],
      ingress: [
        {
          _from: [{ ipBlock: { cidr: "203.0.113.10/32" } }],
          ports: [
            { protocol: "TCP", port: OPENCLAW_GATEWAY_PORT },
            { protocol: "TCP", port: AGENT_RUNTIME_PORT },
          ],
        },
      ],
    });
  });

  it("reconciles operator-managed ingress policies for both runtime families", async () => {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        openclawNamespace: "openclaw-agents",
        hermesNamespace: "hermes-agents",
      }),
    );

    const result = await backend.reconcilePolicySettings({
      policySettings: {
        ingressRules: {
          openclaw: [{ cidr: "203.0.113.10/32", ports: [OPENCLAW_GATEWAY_PORT] }],
          hermes: [{ cidr: "198.51.100.0/24", ports: [8642, HERMES_DASHBOARD_PORT] }],
        },
      },
      policySettingsStatus: {
        lastAppliedNamespaces: {
          openclaw: ["openclaw-agents"],
          hermes: ["hermes-agents"],
        },
      },
    });

    expect(result).toEqual({
      appliedNamespaces: {
        openclaw: ["openclaw-agents"],
        hermes: ["hermes-agents"],
      },
    });
    expect(mockCreateNamespacedNetworkPolicy).toHaveBeenCalledTimes(2);
    expect(mockCreateNamespacedNetworkPolicy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        namespace: "openclaw-agents",
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: "nora-openclaw-operator-allow-ingress",
          }),
        }),
      }),
    );
    expect(mockCreateNamespacedNetworkPolicy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        namespace: "hermes-agents",
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: "nora-hermes-operator-allow-ingress",
          }),
        }),
      }),
    );
  });

  it("prunes empty operator-managed rules and cleans up stale namespaces", async () => {
    const notFoundError = {
      statusCode: 404,
      body: { reason: "NotFound", message: "not found" },
    };
    mockReadNamespacedNetworkPolicy.mockReset().mockRejectedValue(notFoundError);

    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(
      k8sProfile({
        supportsNetworkPolicy: true,
        policyEngine: "cilium",
        openclawNamespace: "openclaw-agents",
        hermesNamespace: "hermes-agents",
      }),
    );

    const result = await backend.reconcilePolicySettings({
      policySettings: {
        ingressRules: {
          openclaw: [],
          hermes: [],
        },
      },
      policySettingsStatus: {
        lastAppliedNamespaces: {
          openclaw: ["legacy-openclaw", "openclaw-agents"],
          hermes: ["legacy-hermes", "hermes-agents"],
        },
      },
    });

    expect(result).toEqual({
      appliedNamespaces: {
        openclaw: ["openclaw-agents"],
        hermes: ["hermes-agents"],
      },
    });
    expect(mockDeleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(4);
    expect(mockDeleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "nora-openclaw-operator-allow-ingress",
      namespace: "legacy-openclaw",
      propagationPolicy: "Foreground",
    });
    expect(mockDeleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "nora-openclaw-operator-allow-ingress",
      namespace: "openclaw-agents",
      propagationPolicy: "Foreground",
    });
    expect(mockDeleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "nora-hermes-operator-allow-ingress",
      namespace: "legacy-hermes",
      propagationPolicy: "Foreground",
    });
    expect(mockDeleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "nora-hermes-operator-allow-ingress",
      namespace: "hermes-agents",
      propagationPolicy: "Foreground",
    });
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
      "Timed out waiting for a LoadBalancer address for nora-oclaw-pending-loadbalancer-qa-999",
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
    mockDeleteNamespacedPersistentVolumeClaim.mockImplementation(deleteIfLegacyNamespace);
    mockReadNamespacedDeployment.mockRejectedValue(notFound);
    mockReadNamespacedService.mockRejectedValue(notFound);
    mockReadNamespacedConfigMap.mockRejectedValue(notFound);
    mockReadNamespacedSecret.mockRejectedValue(notFound);
    mockReadNamespacedPersistentVolumeClaim.mockRejectedValue(notFound);

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
    backend.updateEnv = jest.fn().mockResolvedValue(undefined);

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
      createVolume: jest.fn().mockResolvedValue({}),
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
    // Bug #2 (#297): the gateway API key must be baked into the container env so
    // the s6-supervised gateway (which reads /run/s6/container_environment, not
    // the sourced managed-env file) inherits it on every boot, including
    // auth-reconcile restarts. It must match the token returned to the control plane.
    const apiServerKeyEnv = config.Env.find((entry) => entry.startsWith("API_SERVER_KEY="));
    expect(apiServerKeyEnv).toBe(`API_SERVER_KEY=${result.gatewayToken}`);
    // Dashboard basic-auth credential is baked into the container env and must
    // match what the proxy re-derives from the returned gateway token.
    const derivedDash =
      require("../../agent-runtime/lib/hermesDashboardAuth").deriveHermesDashboardBasicAuth(
        result.gatewayToken,
      );
    expect(config.Env).toEqual(
      expect.arrayContaining([
        `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${derivedDash.username}`,
        `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${derivedDash.password}`,
        `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${derivedDash.secret}`,
      ]),
    );
    expect(config.Entrypoint).toBeUndefined();
    expect(config.Cmd).toEqual([
      "bash",
      "-lc",
      expect.stringContaining('HERMES_BIN="/opt/hermes/.venv/bin/hermes"'),
    ]);
    // Bug #1 (#297): the CMD must NOT re-exec /init. The image's PID-1 /init
    // (s6-overlay) supervises this command directly; a nested /init fatals with
    // "s6-overlay-suexec: can only run as pid 1" and exits before port 8642 binds.
    expect(config.Cmd[2]).not.toContain("/init");
    expect(config.Cmd[2]).toContain('nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open');
    expect(config.Cmd[2]).not.toContain("--insecure");
    expect(config.Cmd[2]).toContain(">> /opt/data/hermes-dashboard.log 2>&1");
    expect(config.Cmd[2]).not.toContain("/proc/1/fd");
    expect(config.Cmd[2]).toContain('exec "$HERMES_BIN" gateway run');
    expect(config.Cmd.join(" ")).not.toContain("/opt/hermes/docker/entrypoint.sh");
    expect(config.ExposedPorts).toEqual({
      "8642/tcp": {},
      "9119/tcp": {},
    });
    expect(config.HostConfig).toEqual(
      expect.objectContaining({
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 512,
      }),
    );
    expect(backend.docker.createVolume).toHaveBeenCalledWith({ Name: "nora_hermes_home_123" });
    expect(config.HostConfig.Binds).toEqual(["nora_hermes_home_123:/opt/data"]);
    expect(config.Labels).toEqual(
      expect.objectContaining({
        "nora.dashboard.port": String(HERMES_DASHBOARD_PORT),
      }),
    );
    expect(bridgeConnect).toHaveBeenCalledWith({
      Container: "hermes-container-1",
    });
    expect(backend.updateEnv).toHaveBeenCalledWith(
      "hermes-container-1",
      expect.objectContaining({ OPENAI_API_KEY: "test-key", API_SERVER_KEY: expect.any(String) }),
      expect.objectContaining({
        initializeManagedState: true,
        replaceManagedState: true,
        runtimeFamily: "hermes",
      }),
    );
    expect(backend.updateEnv.mock.invocationCallOrder[0]).toBeLessThan(
      createdContainer.start.mock.invocationCallOrder[0],
    );
    expect(result).toEqual(
      expect.objectContaining({
        runtimeHost: "10.0.0.50",
        runtimePort: 8642,
      }),
    );
  });
});

describe("docker gateway port allocation (BYOC Phase B)", () => {
  afterEach(() => {
    delete process.env.DOCKER_AGENT_BIND_IP;
  });

  function mockDockerBackend() {
    const DockerBackend = require("../../workers/provisioner/backends/docker");
    const backend = new DockerBackend();
    backend.updateEnv = jest.fn().mockResolvedValue(undefined);
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
    const removeVolume = jest.fn().mockResolvedValue({});
    backend.docker = {
      getImage: jest.fn().mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) }),
      getContainer: jest
        .fn()
        .mockReturnValue({ inspect: jest.fn().mockRejectedValue(new Error("not found")) }),
      listContainers: jest.fn().mockResolvedValue([]),
      createVolume: jest.fn().mockResolvedValue({}),
      createContainer: jest.fn().mockResolvedValue(createdContainer),
      getNetwork: jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue({}) }),
      getVolume: jest.fn().mockReturnValue({ remove: removeVolume }),
    };
    backend._testCreatedContainer = createdContainer;
    backend._testRemoveVolume = removeVolume;
    return backend;
  }

  it("publishes the worker-allocated host port", async () => {
    const backend = mockDockerBackend();
    const result = await backend.create({
      id: "999",
      name: "Port QA",
      gatewayHostPort: 19500,
      runtimeHostPort: 19501,
      env: {},
    });
    const config = backend.docker.createContainer.mock.calls[0][0];
    expect(config.HostConfig).toEqual(
      expect.objectContaining({
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 512,
      }),
    );
    expect(config.HostConfig.CapAdd).toBeUndefined();
    expect(backend.updateEnv).toHaveBeenCalledWith(
      "oclaw-port-1",
      expect.objectContaining({ OPENCLAW_GATEWAY_TOKEN: expect.any(String) }),
      expect.objectContaining({
        initializeManagedState: true,
        replaceManagedState: true,
        runtimeFamily: "openclaw",
      }),
    );
    expect(backend.updateEnv.mock.invocationCallOrder[0]).toBeLessThan(
      backend._testCreatedContainer.start.mock.invocationCallOrder[0],
    );
    expect(config.HostConfig.PortBindings["18789/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "19500" },
    ]);
    expect(config.HostConfig.PortBindings["9090/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "19501" },
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        gatewayHostPort: "19500",
        gatewayHost: "10.0.0.7",
        gatewayPort: OPENCLAW_GATEWAY_PORT,
      }),
    );
  });

  it("falls back to the deterministic hash when no port is allocated", async () => {
    const backend = mockDockerBackend();
    // id "999" -> 19000 + (999 % 1000) = 19999
    await backend.create({ id: "999", name: "Port QA", env: {} });
    const config = backend.docker.createContainer.mock.calls[0][0];
    expect(config.HostConfig.PortBindings["18789/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "19999" },
    ]);
  });

  it("allows an explicit concrete host bind IP while rejecting implicit wildcard exposure", async () => {
    process.env.DOCKER_AGENT_BIND_IP = "192.0.2.10";
    const backend = mockDockerBackend();
    await backend.create({ id: "999", name: "Port QA", gatewayHostPort: 19500, env: {} });
    const config = backend.docker.createContainer.mock.calls[0][0];
    expect(config.HostConfig.PortBindings["18789/tcp"]).toEqual([
      { HostIp: "192.0.2.10", HostPort: "19500" },
    ]);
  });

  it("detects a host port published by another running Docker container", async () => {
    const backend = mockDockerBackend();
    backend.docker.listContainers.mockResolvedValue([
      {
        Id: "other-container",
        Names: ["/unrelated-service"],
        Ports: [{ IP: "0.0.0.0", PrivatePort: 8080, PublicPort: 19500, Type: "tcp" }],
      },
    ]);

    await expect(
      backend.isHostPortBound(19500, { ignoreContainerName: "nora-oclaw-port-qa-999" }),
    ).resolves.toBe(true);
  });

  it("ignores the replaceable same-name container when checking its reserved port", async () => {
    const backend = mockDockerBackend();
    backend.docker.listContainers.mockResolvedValue([
      {
        Id: "old-agent-container",
        Names: ["/nora-oclaw-port-qa-999"],
        Ports: [{ IP: "127.0.0.1", PrivatePort: 18789, PublicPort: 19500, Type: "tcp" }],
      },
    ]);

    await expect(
      backend.isHostPortBound(19500, { ignoreContainerName: "nora-oclaw-port-qa-999" }),
    ).resolves.toBe(false);
  });

  it("removes agent volumes when the Docker container is already missing", async () => {
    const backend = mockDockerBackend();
    const missingContainer = {
      inspect: jest.fn().mockRejectedValue(
        Object.assign(new Error("No such container: missing-agent"), {
          statusCode: 404,
        }),
      ),
      stop: jest.fn(),
      remove: jest.fn(),
    };
    const removeVolume = jest.fn().mockResolvedValue({});
    backend.docker.getContainer.mockReturnValue(missingContainer);
    backend.docker.getVolume.mockImplementation(() => ({ remove: removeVolume }));

    await expect(
      backend.destroy("missing-agent", { agentId: "agent-1", preserveState: false }),
    ).resolves.toBeUndefined();

    expect(missingContainer.stop).not.toHaveBeenCalled();
    expect(missingContainer.remove).not.toHaveBeenCalled();
    expect(backend.docker.getVolume).toHaveBeenNthCalledWith(1, "nora_agent_state_agent-1");
    expect(backend.docker.getVolume).toHaveBeenNthCalledWith(2, "nora_agent_home_agent-1");
    expect(removeVolume).toHaveBeenCalledTimes(2);
  });

  it("treats already-absent agent volumes as idempotent destroy success", async () => {
    const backend = mockDockerBackend();
    const notFound = Object.assign(new Error("No such volume"), { statusCode: 404 });
    backend.docker.getContainer.mockReturnValue({
      inspect: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("No such container: missing-agent"), { statusCode: 404 }),
        ),
      stop: jest.fn(),
      remove: jest.fn(),
    });
    backend.docker.getVolume.mockImplementation(() => ({
      remove: jest.fn().mockRejectedValue(notFound),
    }));

    await expect(
      backend.destroy("missing-agent", { agentId: "agent-1", preserveState: false }),
    ).resolves.toBeUndefined();
    expect(backend.docker.getVolume).toHaveBeenCalledTimes(2);
  });

  it("surfaces volume cleanup failure after attempting every Nora-managed volume", async () => {
    const backend = mockDockerBackend();
    const removeState = jest.fn().mockRejectedValue(new Error("volume is busy"));
    const removeHome = jest.fn().mockResolvedValue({});
    backend.docker.getContainer.mockReturnValue({
      inspect: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("No such container: missing-agent"), { statusCode: 404 }),
        ),
      stop: jest.fn(),
      remove: jest.fn(),
    });
    backend.docker.getVolume.mockImplementation((volume) => ({
      remove: volume === "nora_agent_state_agent-1" ? removeState : removeHome,
    }));

    await expect(
      backend.destroy("missing-agent", { agentId: "agent-1", preserveState: false }),
    ).rejects.toMatchObject({
      code: "DOCKER_VOLUME_CLEANUP_FAILED",
      volumeNames: ["nora_agent_state_agent-1"],
    });
    expect(removeState).toHaveBeenCalledTimes(1);
    expect(removeHome).toHaveBeenCalledTimes(1);
  });

  it("leaves pre-existing volumes alone when a replacement create fails", async () => {
    const backend = mockDockerBackend();
    // A redeploy recreates the container against volumes that already hold the
    // agent's state, so a failed create must not clean them up.
    backend.docker.getVolume.mockImplementation(() => ({
      inspect: jest.fn().mockResolvedValue({}),
      remove: backend._testRemoveVolume,
    }));
    backend._testCreatedContainer.start.mockRejectedValueOnce(new Error("no such image"));

    await expect(
      backend.create({ id: "agent-1", name: "Agent", env: {}, gatewayHostPort: 19500 }),
    ).rejects.toThrow(/no such image/);

    expect(backend._testCreatedContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(backend._testRemoveVolume).not.toHaveBeenCalled();
  });

  it("cleans up volumes it created itself when a first deployment fails", async () => {
    const backend = mockDockerBackend();
    backend.docker.getVolume.mockImplementation(() => ({
      inspect: jest.fn().mockRejectedValue(new Error("no such volume")),
      remove: backend._testRemoveVolume,
    }));
    backend._testCreatedContainer.start.mockRejectedValueOnce(new Error("no such image"));

    await expect(
      backend.create({ id: "agent-1", name: "Agent", env: {}, gatewayHostPort: 19500 }),
    ).rejects.toThrow(/no such image/);

    expect(backend._testRemoveVolume).toHaveBeenCalledTimes(2);
  });

  it("preserves durable volumes when a bind conflict will be retried", async () => {
    const backend = mockDockerBackend();
    backend._testCreatedContainer.start.mockRejectedValueOnce(
      new Error("Bind for 127.0.0.1:19500 failed: port is already allocated"),
    );

    await expect(
      backend.create({ id: "999", name: "Port QA", gatewayHostPort: 19500, env: {} }),
    ).rejects.toThrow(/port is already allocated/);

    expect(backend._testCreatedContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(backend._testRemoveVolume).not.toHaveBeenCalled();
  });
});

// A redeploy destroys the Deployment and recreates it against the same state
// claim. Deleting the claim there discards the agent's durable state on what the
// operator asked to be an in-place replacement.
describe("kubernetes destroy state preservation", () => {
  function stubbedK8sBackend() {
    const K8sBackend = require("../../workers/provisioner/backends/k8s");
    const backend = new K8sBackend(k8sProfile());
    backend._candidateNamespacesForDestroy = jest.fn().mockReturnValue(["nora"]);
    backend._deleteDeploymentIfExists = jest.fn().mockResolvedValue(true);
    backend._deleteServiceIfExists = jest.fn().mockResolvedValue(true);
    backend._deleteBootstrapConfigMapIfExists = jest.fn().mockResolvedValue(true);
    backend._deleteEnvSecretIfExists = jest.fn().mockResolvedValue(true);
    backend._deleteStateVolumeClaimIfExists = jest.fn().mockResolvedValue(true);
    return backend;
  }

  it("deletes the state claim on a true delete", async () => {
    const backend = stubbedK8sBackend();

    await backend.destroy("nora-oclaw-nora-qa-123", { preserveState: false });

    expect(backend._deleteStateVolumeClaimIfExists).toHaveBeenCalledWith(
      "nora-oclaw-nora-qa-123",
      "nora",
    );
  });

  it("keeps the state claim across a redeploy", async () => {
    const backend = stubbedK8sBackend();

    await backend.destroy("nora-oclaw-nora-qa-123", { preserveState: true });

    expect(backend._deleteStateVolumeClaimIfExists).not.toHaveBeenCalled();
    expect(backend._deleteDeploymentIfExists).toHaveBeenCalledWith(
      "nora-oclaw-nora-qa-123",
      "nora",
    );
    expect(backend._deleteServiceIfExists).toHaveBeenCalledWith("nora-oclaw-nora-qa-123", "nora");
  });
});
