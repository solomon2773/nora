#!/usr/bin/env tsx
// @ts-nocheck
import { execFileSync } from "node:child_process";

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
const RUNTIME_FAMILIES = (process.env.K8S_SMOKE_RUNTIME_FAMILIES || "openclaw")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const SMOKE_CELLS = (process.env.K8S_SMOKE_CELLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const NEMOCLAW_MODEL = process.env.NEMOCLAW_DEFAULT_MODEL || "nvidia/nemotron-3-super-120b-a12b";

const RUNTIMES = {
  openclaw: {
    label: "OpenClaw",
    deploymentName: (agentId) => `oclaw-agent-${agentId}`,
    embedPath: (agentId, token) =>
      `/agents/${agentId}/gateway/embed?token=${encodeURIComponent(token)}`,
  },
  hermes: {
    label: "Hermes",
    deploymentName: (agentId) => `hermes-agent-${agentId}`,
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

function kubectl(...args) {
  return execFileSync(KUBECTL_BIN, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function namespaceForRuntime(runtimeFamily) {
  return runtimeFamily === "hermes" ? K8S_HERMES_NAMESPACE : K8S_OPENCLAW_NAMESPACE;
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

async function waitForAgentStatus(token, agentId, allowedStatuses) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const { body } = await api(`/agents/${agentId}`, { token });
    if (allowedStatuses.includes(body.status)) {
      return body;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for agent ${agentId} to reach one of: ${allowedStatuses.join(", ")}`,
  );
}

async function waitForGateway(token, agentId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const { response } = await api(`/agents/${agentId}/gateway/status`, {
      token,
      expectOk: false,
    });
    if (response.ok) return;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for gateway readiness on agent ${agentId}`);
}

async function waitForHermesUi(token, agentId) {
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const { response, body } = await api(`/agents/${agentId}/hermes-ui`, {
      token,
      expectOk: false,
    });
    last = body;
    if (response.ok && body?.health?.ok && body?.dashboard?.ready) return;
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

function assertK8sResources(runtimeFamily, agentId) {
  const runtime = RUNTIMES[runtimeFamily];
  const namespace = namespaceForRuntime(runtimeFamily);
  kubectl("get", "deployment", runtime.deploymentName(agentId), "-n", namespace);
  kubectl("get", "service", runtime.deploymentName(agentId), "-n", namespace);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

async function fetchRuntimeEmbed(runtimeFamily, agentId, token) {
  const runtime = RUNTIMES[runtimeFamily];
  const embedResponse = await fetch(`${API_BASE_URL}${runtime.embedPath(agentId, token)}`);
  if (!embedResponse.ok) {
    throw new Error(`${runtime.label} embed returned ${embedResponse.status}`);
  }
}

async function main() {
  const stamp = Date.now();
  const email = `k8s-smoke-${stamp}@example.com`;
  const password = "SmokePassword123!";
  let token = null;
  const agentIds = [];
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

    await registerKubernetesCluster(token);

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

      assertK8sResources(runtimeFamily, agentId);

      let surfaceUrl = null;
      if (runtimeFamily === "openclaw") {
        const gatewayUrl = await api(`/agents/${agentId}/gateway-url`, { token });
        surfaceUrl = gatewayUrl.body.url;
        if (!isHttpUrl(surfaceUrl)) {
          throw new Error(`Unexpected gateway URL payload: ${JSON.stringify(gatewayUrl.body)}`);
        }
      } else {
        const hermesUi = await api(`/agents/${agentId}/hermes-ui`, { token });
        surfaceUrl = hermesUi.body?.dashboard?.url || hermesUi.body?.url;
        if (!isHttpUrl(surfaceUrl)) {
          throw new Error(`Unexpected Hermes UI payload: ${JSON.stringify(hermesUi.body)}`);
        }
      }

      await waitForRuntimeSurface(token, runningAgent);
      await fetchRuntimeEmbed(runtimeFamily, agentId, token);

      await api(`/agents/${agentId}/stop`, { method: "POST", token });
      await waitForAgentStatus(token, agentId, ["stopped"]);

      await api(`/agents/${agentId}/start`, { method: "POST", token });
      const restartedAgent = await waitForAgentStatus(token, agentId, ["running", "warning"]);
      await waitForRuntimeSurface(token, restartedAgent);

      await api(`/agents/${agentId}/restart`, { method: "POST", token });
      const restartedAgainAgent = await waitForAgentStatus(token, agentId, ["running", "warning"]);
      await waitForRuntimeSurface(token, restartedAgainAgent);

      results.push({
        runtimeFamily,
        sandboxProfile,
        agentId,
        surfaceUrl,
        deployment: runtime.deploymentName(agentId),
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
    if (token) {
      for (const agentId of agentIds.reverse()) {
        await api(`/agents/${agentId}`, {
          method: "DELETE",
          token,
          expectOk: false,
        });
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
