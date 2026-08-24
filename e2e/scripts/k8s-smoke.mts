#!/usr/bin/env tsx
// @ts-nocheck
import { execFileSync, spawnSync } from "node:child_process";

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:4100";
const KUBECTL_BIN = process.env.KUBECTL_BIN || "kubectl";
const K8S_CLUSTER_ID = process.env.NORA_K8S_CLUSTER_ID || "kind-local";
const K8S_EXECUTION_TARGET_ID = `k8s:${K8S_CLUSTER_ID}`;
const K8S_PROVIDER = process.env.NORA_K8S_PROVIDER || "kubernetes";
const K8S_CLUSTER_LABEL = process.env.NORA_K8S_CLUSTER_LABEL || "Kind Local";
const K8S_CLUSTER_NAME = process.env.NORA_K8S_CLUSTER_NAME || K8S_CLUSTER_ID;
const K8S_KUBECONFIG_PATH = process.env.NORA_K8S_KUBECONFIG_PATH || "/kubeconfigs/kubeconfig";
const K8S_NAMESPACE = process.env.NORA_K8S_NAMESPACE || "openclaw-agents";
const K8S_OPENCLAW_NAMESPACE = process.env.NORA_K8S_OPENCLAW_NAMESPACE || K8S_NAMESPACE;
const K8S_HERMES_NAMESPACE = process.env.NORA_K8S_HERMES_NAMESPACE || K8S_NAMESPACE;
const K8S_EXPOSURE_MODE = process.env.NORA_K8S_EXPOSURE_MODE || "node-port";
const K8S_RUNTIME_HOST = process.env.NORA_K8S_RUNTIME_HOST || "";
const K8S_RUNTIME_NODE_PORT = process.env.NORA_K8S_RUNTIME_NODE_PORT || "";
const K8S_GATEWAY_NODE_PORT = process.env.NORA_K8S_GATEWAY_NODE_PORT || "";
const K8S_SERVICE_ANNOTATIONS_JSON = process.env.NORA_K8S_SERVICE_ANNOTATIONS_JSON || "";
const K8S_LOAD_BALANCER_SOURCE_RANGES = process.env.NORA_K8S_LOAD_BALANCER_SOURCE_RANGES || "";
const K8S_LOAD_BALANCER_CLASS = process.env.NORA_K8S_LOAD_BALANCER_CLASS || "";
const K8S_LOAD_BALANCER_READY_TIMEOUT_MS = Number.parseInt(
  process.env.NORA_K8S_LOAD_BALANCER_READY_TIMEOUT_MS || "600000",
  10,
);
const K8S_LOAD_BALANCER_READY_INTERVAL_MS = Number.parseInt(
  process.env.NORA_K8S_LOAD_BALANCER_READY_INTERVAL_MS || "5000",
  10,
);
const POLL_INTERVAL_MS = Number.parseInt(process.env.K8S_SMOKE_POLL_MS || "5000", 10);
// First boot can spend several minutes installing OpenClaw and bundled plugins.
const POLL_TIMEOUT_MS = Number.parseInt(process.env.K8S_SMOKE_TIMEOUT_MS || "600000", 10);
const CLEANUP_TIMEOUT_MS = Number.parseInt(process.env.K8S_SMOKE_CLEANUP_TIMEOUT_MS || "15000", 10);
const RUNTIME_FAMILIES = (process.env.K8S_SMOKE_RUNTIME_FAMILIES || "openclaw,hermes")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PEER_POD_NAME = process.env.K8S_SMOKE_PEER_POD_NAME || "k8s-smoke-peer";
const SMOKE_CELLS = (process.env.K8S_SMOKE_CELLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const NEMOCLAW_MODEL = process.env.NEMOCLAW_DEFAULT_MODEL || "nvidia/nemotron-3-super-120b-a12b";

const RUNTIMES = {
  openclaw: {
    label: "OpenClaw",
    policyNames: ["nora-openclaw-default-deny-ingress", "nora-openclaw-allow-trusted-ingress"],
    blockedPorts: [18789, 9090],
    embedPath: (agentId, token) =>
      `/agents/${agentId}/gateway/embed?token=${encodeURIComponent(token)}`,
  },
  hermes: {
    label: "Hermes",
    policyNames: ["nora-hermes-default-deny-ingress", "nora-hermes-allow-trusted-ingress"],
    blockedPorts: [8642, 9119],
    embedPath: (agentId, token) =>
      `/agents/${agentId}/hermes-ui/embed?token=${encodeURIComponent(token)}`,
  },
};

function parseSmokeCells() {
  const entries =
    SMOKE_CELLS.length > 0
      ? SMOKE_CELLS
      : RUNTIME_FAMILIES.map((runtimeFamily) => `${runtimeFamily}:standard`);
  return entries.map((entry) => {
    const [runtimeFamilyRaw, sandboxProfileRaw] = entry.split(":");
    const runtimeFamily = String(runtimeFamilyRaw || "").trim();
    const sandboxProfile = String(sandboxProfileRaw || "standard").trim() || "standard";
    return {
      key: `${runtimeFamily}:${sandboxProfile}`,
      runtimeFamily,
      sandboxProfile,
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, { method = "GET", token = null, body, expectOk = true } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (expectOk && !response.ok) {
    throw new Error(
      `${method} ${path} failed with ${response.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
    );
  }

  return { response, body: parsed };
}

async function apiWithTimeout(path, { timeoutMs = CLEANUP_TIMEOUT_MS, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if ((options.expectOk ?? true) && !response.ok) {
      throw new Error(
        `${options.method || "GET"} ${path} failed with ${response.status}: ${
          typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        }`,
      );
    }

    return { response, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function retryApi(path, options = {}, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await api(path, options);
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `${options.method || "GET"} ${path} did not succeed: ${lastError || "no response"}`,
  );
}

function kubectl(...args) {
  return execFileSync(KUBECTL_BIN, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function kubectlStatus(...args) {
  const result = spawnSync(KUBECTL_BIN, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function namespaceForRuntime(runtimeFamily) {
  return runtimeFamily === "hermes" ? K8S_HERMES_NAMESPACE : K8S_OPENCLAW_NAMESPACE;
}

function deployedResourceName(agent, runtimeFamily) {
  const containerId = String(agent?.container_id || "").trim();
  if (containerId) return containerId;
  return runtimeFamily === "hermes" ? `hermes-agent-${agent.id}` : `oclaw-agent-${agent.id}`;
}

function parseServiceAnnotations() {
  const raw = String(K8S_SERVICE_ANNOTATIONS_JSON || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NORA_K8S_SERVICE_ANNOTATIONS_JSON must be a JSON object");
  }
  return parsed;
}

// Seed the built-in zero-key demo provider.
//
// The smoke never configured an LLM provider, so provisioning failed every
// attempt with "LLM provider state was removed while the runtime was
// provisioning" and the agent finished `stopped`. The demo provider is the one
// path that needs no credential, which is what makes it right for CI — the run
// stays free of real keys.
async function ensureDemoLlmProvider(token) {
  const existing = await api("/llm-providers", { token, expectOk: false });
  if (
    existing.response.ok &&
    Array.isArray(existing.body) &&
    existing.body.some((entry) => entry?.provider === "demo")
  ) {
    return;
  }
  const created = await api("/llm-providers", {
    method: "POST",
    token,
    body: { provider: "demo", isDefault: true },
    expectOk: false,
  });
  if (!created.response.ok && created.response.status !== 409) {
    throw new Error(`Failed to register the demo LLM provider: ${created.response.status}`);
  }
}

async function registerKubernetesCluster(token) {
  const body = {
    id: K8S_CLUSTER_ID,
    label: K8S_CLUSTER_LABEL,
    provider: K8S_PROVIDER,
    clusterName: K8S_CLUSTER_NAME,
    credentialMode: "mounted_path",
    kubeconfigPath: K8S_KUBECONFIG_PATH,
    namespace: K8S_NAMESPACE,
    openclawNamespace: K8S_OPENCLAW_NAMESPACE,
    hermesNamespace: K8S_HERMES_NAMESPACE,
    exposureMode: K8S_EXPOSURE_MODE,
    runtimeHost: K8S_RUNTIME_HOST,
    runtimeNodePort: K8S_RUNTIME_NODE_PORT,
    gatewayNodePort: K8S_GATEWAY_NODE_PORT,
    serviceAnnotations: parseServiceAnnotations(),
    loadBalancerSourceRanges: K8S_LOAD_BALANCER_SOURCE_RANGES,
    loadBalancerClass: K8S_LOAD_BALANCER_CLASS,
    loadBalancerReadyTimeoutMs: K8S_LOAD_BALANCER_READY_TIMEOUT_MS,
    loadBalancerReadyIntervalMs: K8S_LOAD_BALANCER_READY_INTERVAL_MS,
    enabled: true,
    isDefault: true,
  };
  const created = await api("/admin/kubernetes-clusters", {
    method: "POST",
    token,
    body,
    expectOk: false,
  });
  if (created.response.ok) return;
  if (created.response.status !== 409) {
    throw new Error(`Failed to register Kubernetes cluster: ${created.response.status}`);
  }
  await api(`/admin/kubernetes-clusters/${K8S_CLUSTER_ID}`, {
    method: "PUT",
    token,
    body,
  });
}

async function testKubernetesCluster(token) {
  const { body } = await api(`/admin/kubernetes-clusters/${K8S_CLUSTER_ID}/test`, {
    method: "POST",
    token,
  });
  if (body?.lastTestStatus !== "ok") {
    throw new Error(
      `Kubernetes cluster connection test did not pass: ${JSON.stringify({
        lastTestStatus: body?.lastTestStatus,
        lastTestMessage: body?.lastTestMessage,
        supportsNetworkPolicy: body?.supportsNetworkPolicy,
        policyEngine: body?.policyEngine,
      })}`,
    );
  }
  return body;
}

async function waitForAgentStatus(token, agentId, allowedStatuses) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const { body } = await api(`/agents/${agentId}`, { token });
      if (allowedStatuses.includes(body.status)) {
        return body;
      }
      lastError = `last status=${body.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for agent ${agentId} to reach one of: ${allowedStatuses.join(
      ", ",
    )}; ${lastError || "no status response"}`,
  );
}

async function waitForGateway(token, agentId) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const { response, body } = await api(`/agents/${agentId}/gateway/status`, {
        token,
        expectOk: false,
      });
      if (response.ok) return;
      lastError = `${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for gateway readiness on agent ${agentId}; ${lastError || "no response"}`,
  );
}

async function waitForHermesUi(token, agentId) {
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const { response, body } = await api(`/agents/${agentId}/hermes-ui`, {
        token,
        expectOk: false,
      });
      last = body;
      if (response.ok && body?.health?.ok && body?.dashboard?.ready) return;
    } catch (error) {
      last = error?.message || String(error);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for Hermes UI readiness on agent ${agentId}; last response: ${JSON.stringify(
      last,
    )}`,
  );
}

async function waitForRuntimeSurface(token, agent) {
  if (agent.runtime_family === "hermes") {
    await waitForHermesUi(token, agent.id);
    return;
  }
  await waitForGateway(token, agent.id);
}

function assertK8sResources(runtimeFamily, agent) {
  const namespace = namespaceForRuntime(runtimeFamily);
  const resourceName = deployedResourceName(agent, runtimeFamily);
  kubectl("get", "deployment", resourceName, "-n", namespace);
  kubectl("get", "service", resourceName, "-n", namespace);
}

function assertPolicyStatus(agent, runtimeFamily) {
  const status = agent.networkPolicyStatus;
  if (!status) {
    throw new Error(`${runtimeFamily} agent ${agent.id} did not expose networkPolicyStatus`);
  }
  if (status.policyStatus !== "supported") {
    throw new Error(
      `${runtimeFamily} agent ${agent.id} expected policyStatus=supported, received ${JSON.stringify(status)}`,
    );
  }
  if (!status.policyBundleAttempted || !status.policyBundleApplied) {
    throw new Error(
      `${runtimeFamily} agent ${agent.id} expected applied policy bundle, received ${JSON.stringify(status)}`,
    );
  }
}

function assertNetworkPoliciesExist(runtimeFamily) {
  const runtime = RUNTIMES[runtimeFamily];
  const namespace = namespaceForRuntime(runtimeFamily);
  for (const policyName of runtime.policyNames) {
    kubectl("get", "networkpolicy", policyName, "-n", namespace);
  }
}

function ensurePeerPod(namespace) {
  const existing = kubectlStatus("get", "pod", PEER_POD_NAME, "-n", namespace, "-o", "name");
  if (existing.status !== 0) {
    kubectl(
      "run",
      PEER_POD_NAME,
      "-n",
      namespace,
      "--image=busybox:1.36",
      "--restart=Never",
      "--labels",
      "app=k8s-smoke-peer",
      "--command",
      "--",
      "sh",
      "-c",
      "sleep 3600",
    );
  }
  kubectl(
    "wait",
    "--for=condition=Ready",
    `pod/${PEER_POD_NAME}`,
    "-n",
    namespace,
    "--timeout=180s",
  );
}

function assertPeerPodBlocked(runtimeFamily, agent) {
  const runtime = RUNTIMES[runtimeFamily];
  const namespace = namespaceForRuntime(runtimeFamily);
  const serviceName = deployedResourceName(agent, runtimeFamily);
  ensurePeerPod(namespace);

  for (const port of runtime.blockedPorts) {
    const probe = kubectlStatus(
      "exec",
      "-n",
      namespace,
      PEER_POD_NAME,
      "--",
      "sh",
      "-c",
      `wget -T 5 -qO- http://${serviceName}:${port} >/dev/null`,
    );
    if (probe.status === 0) {
      throw new Error(
        `${runtime.label} service ${serviceName}:${port} was reachable from peer pod ${PEER_POD_NAME}; expected ingress isolation`,
      );
    }
  }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

async function fetchRuntimeEmbed(runtimeFamily, agentId, token) {
  const runtime = RUNTIMES[runtimeFamily];
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const embedResponse = await fetch(`${API_BASE_URL}${runtime.embedPath(agentId, token)}`);
      if (embedResponse.ok) return;
      lastError = `${runtime.label} embed returned ${embedResponse.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`${runtime.label} embed did not become reachable: ${lastError || "unknown"}`);
}

async function cleanupAgent(token, agentId) {
  try {
    await apiWithTimeout(`/agents/${agentId}`, {
      method: "DELETE",
      token,
      expectOk: false,
    });
  } catch (error) {
    const message = String(error?.message || error);
    console.warn(
      `Cleanup delete for agent ${agentId} did not finish within ${CLEANUP_TIMEOUT_MS}ms: ${message}`,
    );
  }
}

async function main() {
  const stamp = Date.now();
  const email = `k8s-smoke-${stamp}@example.com`;
  const password = "SmokePassword123!";
  let token = null;
  const agentIds = [];
  const peerNamespaces = new Set();
  const results = [];
  const cells = parseSmokeCells();

  try {
    const unsupportedRuntime = cells.find((cell) => !RUNTIMES[cell.runtimeFamily]);
    if (unsupportedRuntime) {
      throw new Error(
        `Unsupported K8s smoke runtime entry: ${unsupportedRuntime.runtimeFamily}. Supported values: ${Object.keys(
          RUNTIMES,
        ).join(", ")}`,
      );
    }
    const invalidSandbox = cells.find(
      (cell) =>
        cell.sandboxProfile !== "standard" &&
        !(cell.runtimeFamily === "openclaw" && cell.sandboxProfile === "nemoclaw"),
    );
    if (invalidSandbox) {
      throw new Error(
        `Unsupported K8S_SMOKE_CELLS entry: ${invalidSandbox.key}. Use runtime:sandbox pairs such as openclaw:standard,openclaw:nemoclaw,hermes:standard.`,
      );
    }
    if (cells.some((cell) => cell.sandboxProfile === "nemoclaw") && !process.env.NVIDIA_API_KEY) {
      throw new Error("K8S_SMOKE_CELLS includes openclaw:nemoclaw but NVIDIA_API_KEY is not set");
    }

    await api("/auth/signup", {
      method: "POST",
      body: { email, password },
    });

    const login = await api("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    token = login.body.token;

    await ensureDemoLlmProvider(token);
    await registerKubernetesCluster(token);
    await testKubernetesCluster(token);

    for (const cell of cells) {
      const { runtimeFamily, sandboxProfile } = cell;
      const runtime = RUNTIMES[runtimeFamily];
      const deploy = await api("/agents/deploy", {
        method: "POST",
        token,
        body: {
          name: `${runtime.label} ${sandboxProfile === "nemoclaw" ? "NemoClaw " : ""}K8s Smoke ${stamp}`,
          runtime_family: runtimeFamily,
          backend_type: "k8s",
          deploy_target: K8S_EXECUTION_TARGET_ID,
          execution_target_id: K8S_EXECUTION_TARGET_ID,
          sandbox_profile: sandboxProfile,
          ...(sandboxProfile === "nemoclaw" ? { model: NEMOCLAW_MODEL } : {}),
        },
      });
      const agentId = deploy.body.id;
      agentIds.push(agentId);

      const runningAgent = await waitForAgentStatus(token, agentId, [
        "running",
        "warning",
        "error",
      ]);
      if (runningAgent.status === "error") {
        throw new Error(`Agent ${agentId} entered error state`);
      }
      if (runningAgent.runtime_family !== runtimeFamily) {
        throw new Error(
          `Expected runtime_family=${runtimeFamily}, received ${runningAgent.runtime_family}`,
        );
      }
      if (runningAgent.backend_type !== "k8s") {
        throw new Error(`Expected backend_type=k8s, received ${runningAgent.backend_type}`);
      }
      if ((runningAgent.sandbox_profile || "standard") !== sandboxProfile) {
        throw new Error(
          `Expected sandbox_profile=${sandboxProfile}, received ${runningAgent.sandbox_profile}`,
        );
      }

      assertPolicyStatus(runningAgent, runtimeFamily);
      assertK8sResources(runtimeFamily, runningAgent);
      assertNetworkPoliciesExist(runtimeFamily);
      peerNamespaces.add(namespaceForRuntime(runtimeFamily));

      let surfaceUrl = null;
      if (runtimeFamily === "openclaw") {
        const gatewayUrl = await retryApi(`/agents/${agentId}/gateway-url`, { token });
        surfaceUrl = gatewayUrl.body.url;
        if (!isHttpUrl(surfaceUrl)) {
          throw new Error(`Unexpected gateway URL payload: ${JSON.stringify(gatewayUrl.body)}`);
        }
      } else {
        const hermesUi = await retryApi(`/agents/${agentId}/hermes-ui`, { token });
        surfaceUrl = hermesUi.body?.dashboard?.url || hermesUi.body?.url;
        if (!isHttpUrl(surfaceUrl)) {
          throw new Error(`Unexpected Hermes UI payload: ${JSON.stringify(hermesUi.body)}`);
        }
      }

      await waitForRuntimeSurface(token, runningAgent);
      await fetchRuntimeEmbed(runtimeFamily, agentId, token);
      assertPeerPodBlocked(runtimeFamily, runningAgent);

      await retryApi(`/agents/${agentId}/stop`, { method: "POST", token });
      await waitForAgentStatus(token, agentId, ["stopped"]);

      await retryApi(`/agents/${agentId}/start`, { method: "POST", token });
      const restartedAgent = await waitForAgentStatus(token, agentId, ["running", "warning"]);
      await waitForRuntimeSurface(token, restartedAgent);

      await retryApi(`/agents/${agentId}/restart`, { method: "POST", token });
      const restartedAgainAgent = await waitForAgentStatus(token, agentId, ["running", "warning"]);
      await waitForRuntimeSurface(token, restartedAgainAgent);

      results.push({
        runtimeFamily,
        sandboxProfile,
        agentId,
        surfaceUrl,
        deployment: deployedResourceName(restartedAgainAgent, runtimeFamily),
      });
    }

    console.log(
      JSON.stringify({
        ok: true,
        agents: results,
        namespace: K8S_NAMESPACE,
        executionTarget: K8S_EXECUTION_TARGET_ID,
      }),
    );
  } finally {
    for (const namespace of peerNamespaces) {
      kubectlStatus("delete", "pod", PEER_POD_NAME, "-n", namespace, "--ignore-not-found=true");
    }
    if (token) {
      for (const agentId of agentIds.reverse()) {
        await cleanupAgent(token, agentId);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
