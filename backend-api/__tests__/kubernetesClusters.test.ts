// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockLoadKubeconfigFromFile = jest.fn();
const mockListNamespace = jest.fn();
const mockListNamespacedDaemonSet = jest.fn();
const mockCreateSelfSubjectAccessReview = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromFile(path) {
      return mockLoadKubeconfigFromFile(path);
    }
    loadFromString() {}
    loadFromCluster() {}
    makeApiClient(api) {
      if (api === CoreV1Api) return { listNamespace: mockListNamespace };
      if (api === AppsV1Api) return { listNamespacedDaemonSet: mockListNamespacedDaemonSet };
      if (api === AuthorizationV1Api) {
        return { createSelfSubjectAccessReview: mockCreateSelfSubjectAccessReview };
      }
      return { listNamespace: mockListNamespace };
    }
  }

  class CoreV1Api {}
  class AppsV1Api {}
  class AuthorizationV1Api {}

  return { KubeConfig, CoreV1Api, AppsV1Api, AuthorizationV1Api, NetworkingV1Api: class {} };
});

const {
  buildPolicySettingsHash,
  markKubernetesClusterPolicyStatus,
  normalizePolicySettings,
  rowToProfile,
  testKubernetesCluster,
  updateKubernetesClusterPolicySettings,
} = require("../kubernetesClusters");

function kubernetesClusterRow(overrides = {}) {
  return {
    id: "aks-eastus2",
    label: "AKS East US 2",
    provider: "aks",
    cluster_name: "nora-dns-vjb9kjjz",
    enabled: true,
    is_default: true,
    credential_mode: "mounted_path",
    kubeconfig_path: "/kubeconfigs/aks-kubeconfig",
    kubeconfig_encrypted: null,
    kube_context: "",
    namespace: "nora-openclaw-agents",
    openclaw_namespace: "nora-openclaw-agents",
    hermes_namespace: "nora-hermes-agents",
    exposure_mode: "load-balancer",
    runtime_host: "",
    service_annotations: {},
    load_balancer_source_ranges: [],
    load_balancer_class: "",
    load_balancer_ready_timeout_ms: 1200000,
    load_balancer_ready_interval_ms: 5000,
    last_test_status: null,
    last_test_message: null,
    ...overrides,
  };
}

describe("kubernetes cluster registry", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockLoadKubeconfigFromFile.mockReset().mockReturnValue(undefined);
    mockListNamespace.mockReset().mockResolvedValue({});
    mockListNamespacedDaemonSet.mockReset().mockResolvedValue({
      items: [{ metadata: { name: "cilium" } }],
    });
    mockCreateSelfSubjectAccessReview.mockReset().mockResolvedValue({
      status: { allowed: true },
    });
  });

  it("exposes NetworkPolicy capability metadata on cluster profiles", () => {
    const profile = rowToProfile(
      kubernetesClusterRow({
        supports_network_policy: true,
        policy_engine: "cilium",
      }),
    );

    expect(profile.supportsNetworkPolicy).toBe(true);
    expect(profile.policyEngine).toBe("cilium");
    expect(profile.policySupportStatus).toBe("supported");
    expect(profile.policyIssue).toBeNull();
  });

  it("normalizes ports and description for a valid ingress policy rule", () => {
    const settings = normalizePolicySettings({
      ingressRules: {
        openclaw: [
          {
            cidr: "203.0.113.10/32",
            ports: [9090, 18789, 9090],
            description: " corp vpn ",
          },
        ],
      },
    });

    expect(settings).toEqual({
      ingressRules: {
        openclaw: [
          {
            id: expect.any(String),
            cidr: "203.0.113.10/32",
            ports: [9090, 18789],
            description: "corp vpn",
          },
        ],
        hermes: [],
      },
    });
  });

  it("rejects duplicate CIDR entries within the same runtime family", () => {
    expect(() =>
      normalizePolicySettings({
        ingressRules: {
          openclaw: [
            { cidr: "203.0.113.10/32", ports: [9090] },
            { cidr: "203.0.113.10/32", ports: [18789] },
          ],
        },
      }),
    ).toThrow(/duplicate CIDR/i);
  });

  it("rejects ingress rules that target ports outside the runtime baseline", () => {
    expect(() =>
      normalizePolicySettings({
        ingressRules: {
          openclaw: [{ cidr: "203.0.113.10/32", ports: [8080] }],
        },
      }),
    ).toThrow(/18789 and 9090/);
  });

  it("treats omitted runtime-family buckets as empty lists for full replacement", () => {
    const settings = normalizePolicySettings({
      ingressRules: {
        hermes: [{ cidr: "198.51.100.0/24", ports: [8642] }],
      },
    });

    expect(settings).toEqual({
      ingressRules: {
        openclaw: [],
        hermes: [
          {
            id: expect.any(String),
            cidr: "198.51.100.0/24",
            ports: [8642],
            description: null,
          },
        ],
      },
    });
  });

  it("maps custom policy summary fields onto cluster profiles", () => {
    const policySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-1", cidr: "203.0.113.10/32", ports: [18789, 9090] }],
        hermes: [],
      },
    };
    const desiredHash = buildPolicySettingsHash(policySettings);
    const profile = rowToProfile(
      kubernetesClusterRow({
        policy_settings: policySettings,
        policy_settings_status: {
          state: "applied",
          desiredHash,
          appliedHash: desiredHash,
          customPolicyAppliedAt: "2026-06-22T12:00:00.000Z",
        },
      }),
    );

    expect(profile.customPolicyConfigured).toBe(true);
    expect(profile.customIngressConfigured).toBe(true);
    expect(profile.customPolicyApplied).toBe(true);
    expect(profile.customPolicyState).toBe("applied");
    expect(profile.customPolicyDesiredHash).toBe(desiredHash);
    expect(profile.customIngressRuleCounts).toEqual({ openclaw: 1, hermes: 0 });
  });

  it("does not let a stale reconcile result mark newer policy settings as applied", async () => {
    const stalePolicySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-1", cidr: "203.0.113.10/32", ports: [18789, 9090] }],
        hermes: [],
      },
    };
    const currentPolicySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-2", cidr: "198.51.100.20/32", ports: [18789] }],
        hermes: [],
      },
    };
    const staleHash = buildPolicySettingsHash(stalePolicySettings);
    const currentHash = buildPolicySettingsHash(currentPolicySettings);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          kubernetesClusterRow({
            policy_settings: currentPolicySettings,
            policy_settings_status: {
              state: "queued",
              desiredHash: currentHash,
              appliedHash: null,
              customPolicyIssue: null,
            },
          }),
        ],
      })
      .mockImplementationOnce((_sql, params) => ({
        rows: [
          kubernetesClusterRow({
            policy_settings: currentPolicySettings,
            policy_settings_status: JSON.parse(params[1]),
          }),
        ],
      }));

    const cluster = await markKubernetesClusterPolicyStatus("aks-eastus2", {
      state: "applied",
      desiredHash: staleHash,
      appliedHash: staleHash,
      lastAppliedNamespaces: { openclaw: ["nora-openclaw-agents"] },
      customPolicyAppliedAt: "2026-06-22T12:00:00.000Z",
      updatedAt: "2026-06-22T12:00:01.000Z",
    });

    const persistedStatus = JSON.parse(mockDb.query.mock.calls[1][1][1]);
    expect(persistedStatus.state).toBe("queued");
    expect(persistedStatus.desiredHash).toBe(currentHash);
    expect(persistedStatus.appliedHash).toBe(staleHash);
    expect(persistedStatus.customPolicyAppliedAt).toBeNull();
    expect(cluster.customPolicyApplied).toBe(false);
    expect(cluster.customPolicyState).toBe("queued");
    expect(cluster.customPolicyDesiredHash).toBe(currentHash);
  });

  it("does not let a stale reconcile job overwrite newer queued status as applying", async () => {
    const stalePolicySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-1", cidr: "203.0.113.10/32", ports: [18789, 9090] }],
        hermes: [],
      },
    };
    const currentPolicySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-2", cidr: "198.51.100.20/32", ports: [18789] }],
        hermes: [],
      },
    };
    const staleHash = buildPolicySettingsHash(stalePolicySettings);
    const currentHash = buildPolicySettingsHash(currentPolicySettings);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          kubernetesClusterRow({
            policy_settings: currentPolicySettings,
            policy_settings_status: {
              state: "queued",
              desiredHash: currentHash,
              appliedHash: null,
              customPolicyIssue: "newer issue",
            },
          }),
        ],
      })
      .mockImplementationOnce((_sql, params) => ({
        rows: [
          kubernetesClusterRow({
            policy_settings: currentPolicySettings,
            policy_settings_status: JSON.parse(params[1]),
          }),
        ],
      }));

    const cluster = await markKubernetesClusterPolicyStatus("aks-eastus2", {
      state: "applying",
      desiredHash: staleHash,
      customPolicyIssue: null,
      updatedAt: "2026-06-22T12:00:01.000Z",
    });

    const persistedStatus = JSON.parse(mockDb.query.mock.calls[1][1][1]);
    expect(persistedStatus.state).toBe("queued");
    expect(persistedStatus.desiredHash).toBe(currentHash);
    expect(persistedStatus.customPolicyIssue).toBe("newer issue");
    expect(cluster.customPolicyState).toBe("queued");
    expect(cluster.customPolicyDesiredHash).toBe(currentHash);
  });

  it("repairs an already stale applying status when an old terminal result arrives", async () => {
    const stalePolicySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-1", cidr: "203.0.113.10/32", ports: [18789, 9090] }],
        hermes: [],
      },
    };
    const currentPolicySettings = {
      ingressRules: {
        openclaw: [{ id: "rule-2", cidr: "198.51.100.20/32", ports: [18789] }],
        hermes: [],
      },
    };
    const staleHash = buildPolicySettingsHash(stalePolicySettings);
    const currentHash = buildPolicySettingsHash(currentPolicySettings);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          kubernetesClusterRow({
            policy_settings: currentPolicySettings,
            policy_settings_status: {
              state: "applying",
              desiredHash: staleHash,
              appliedHash: null,
              customPolicyIssue: null,
            },
          }),
        ],
      })
      .mockImplementationOnce((_sql, params) => ({
        rows: [
          kubernetesClusterRow({
            policy_settings: currentPolicySettings,
            policy_settings_status: JSON.parse(params[1]),
          }),
        ],
      }));

    const cluster = await markKubernetesClusterPolicyStatus("aks-eastus2", {
      state: "applied",
      desiredHash: staleHash,
      appliedHash: staleHash,
      lastAppliedNamespaces: { openclaw: ["nora-openclaw-agents"] },
      customPolicyAppliedAt: "2026-06-22T12:00:00.000Z",
      updatedAt: "2026-06-22T12:00:01.000Z",
    });

    const persistedStatus = JSON.parse(mockDb.query.mock.calls[1][1][1]);
    expect(persistedStatus.state).toBe("queued");
    expect(persistedStatus.desiredHash).toBe(currentHash);
    expect(persistedStatus.appliedHash).toBe(staleHash);
    expect(persistedStatus.customPolicyAppliedAt).toBeNull();
    expect(cluster.customPolicyApplied).toBe(false);
    expect(cluster.customPolicyState).toBe("queued");
    expect(cluster.customPolicyDesiredHash).toBe(currentHash);
  });

  it("persists normalized policy settings with queued desired-hash status", async () => {
    const updated = kubernetesClusterRow({
      policy_settings: {
        ingressRules: {
          openclaw: [{ id: "rule-1", cidr: "203.0.113.10/32", ports: [18789, 9090] }],
          hermes: [],
        },
      },
      policy_settings_status: {
        state: "queued",
        desiredHash: "hash-queued",
        appliedHash: null,
        lastAppliedNamespaces: null,
        customPolicyIssue: null,
        customPolicyAppliedAt: null,
        updatedAt: "2026-06-22T12:00:00.000Z",
      },
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await updateKubernetesClusterPolicySettings("aks-eastus2", {
      ingressRules: {
        openclaw: [{ cidr: "203.0.113.10/32", ports: [9090, 18789] }],
      },
    });

    expect(cluster.customPolicyState).toBe("queued");
    expect(cluster.policySettings.ingressRules.openclaw[0]).toEqual({
      id: "rule-1",
      cidr: "203.0.113.10/32",
      ports: [9090, 18789],
      description: null,
    });
    expect(mockDb.query.mock.calls[1][1][1]).toContain('"openclaw"');
    expect(mockDb.query.mock.calls[1][1][2]).toContain('"state":"queued"');
  });

  it("stores actionable connection-test failures for missing mounted kubeconfigs", async () => {
    const missing = new Error(
      "ENOENT: no such file or directory, open '/kubeconfigs/aks-kubeconfig'",
    );
    missing.code = "ENOENT";
    mockLoadKubeconfigFromFile.mockImplementationOnce(() => {
      throw missing;
    });
    const updated = kubernetesClusterRow({
      last_test_status: "failed",
      last_test_message:
        "AKS East US 2 mounted kubeconfig file was not found at /kubeconfigs/aks-kubeconfig. Make sure NORA_KUBECONFIGS_DIR is mounted with docker-compose.kubernetes.yml and contains this file, or update the Admin Kubeconfig path to the file visible inside the Nora containers.",
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await testKubernetesCluster("aks-eastus2");

    expect(cluster.lastTestStatus).toBe("failed");
    expect(cluster.lastTestMessage).toMatch(/mounted kubeconfig file was not found/);
    expect(cluster.lastTestMessage).toMatch(/NORA_KUBECONFIGS_DIR/);
    expect(mockDb.query.mock.calls[1][1][2]).toBe(updated.last_test_message);
  });

  it("stores probed NetworkPolicy capability details during cluster tests", async () => {
    const updated = kubernetesClusterRow({
      last_test_status: "ok",
      last_test_message:
        "Kubernetes API is reachable and NetworkPolicy support was detected (cilium).",
      supports_network_policy: true,
      policy_engine: "cilium",
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await testKubernetesCluster("aks-eastus2");

    expect(cluster.supportsNetworkPolicy).toBe(true);
    expect(cluster.policyEngine).toBe("cilium");
    expect(mockListNamespacedDaemonSet).toHaveBeenCalledWith({
      namespace: "kube-system",
      limit: 100,
    });
    expect(mockCreateSelfSubjectAccessReview).toHaveBeenCalled();
  });

  it("accepts wrapped Kubernetes client responses when probing policy support", async () => {
    mockListNamespacedDaemonSet.mockResolvedValueOnce({
      body: { items: [{ metadata: { name: "cilium" } }] },
    });
    mockCreateSelfSubjectAccessReview.mockResolvedValue({
      body: { status: { allowed: true } },
    });
    const updated = kubernetesClusterRow({
      last_test_status: "ok",
      last_test_message:
        "Kubernetes API is reachable and NetworkPolicy support was detected (cilium).",
      supports_network_policy: true,
      policy_engine: "cilium",
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [kubernetesClusterRow()] })
      .mockResolvedValueOnce({ rows: [updated] });

    const cluster = await testKubernetesCluster("aks-eastus2");

    expect(cluster.supportsNetworkPolicy).toBe(true);
    expect(cluster.policyEngine).toBe("cilium");
  });
});
