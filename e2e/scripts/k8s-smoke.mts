#!/usr/bin/env tsx
// @ts-nocheck
import { execFileSync } from "node:child_process";

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:4100";
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || "openclaw-agents";
const POLL_INTERVAL_MS = Number.parseInt(process.env.K8S_SMOKE_POLL_MS || "5000", 10);
// First boot can spend several minutes installing OpenClaw and bundled plugins.
const POLL_TIMEOUT_MS = Number.parseInt(process.env.K8S_SMOKE_TIMEOUT_MS || "600000", 10);

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
    throw new Error(`${method} ${path} failed with ${response.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }

  return { response, body: parsed };
}

function kubectl(...args) {
  return execFileSync("kubectl", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

  throw new Error(`Timed out waiting for agent ${agentId} to reach one of: ${allowedStatuses.join(", ")}`);
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

async function main() {
  const stamp = Date.now();
  const email = `k8s-smoke-${stamp}@example.com`;
  const password = "SmokePassword123!";
  let token = null;
  let agentId = null;

  try {
    await api("/auth/signup", {
      method: "POST",
      body: { email, password },
    });

    const login = await api("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    token = login.body.token;

    const deploy = await api("/agents/deploy", {
      method: "POST",
      token,
      body: {
        name: `Kind Smoke ${stamp}`,
        deploy_target: "k8s",
      },
    });
    agentId = deploy.body.id;

    const runningAgent = await waitForAgentStatus(token, agentId, ["running", "warning", "error"]);
    if (runningAgent.status === "error") {
      throw new Error(`Agent ${agentId} entered error state`);
    }
    if (runningAgent.backend_type !== "k8s") {
      throw new Error(`Expected backend_type=k8s, received ${runningAgent.backend_type}`);
    }

    kubectl("get", "deployment", `oclaw-agent-${agentId}`, "-n", K8S_NAMESPACE);
    kubectl("get", "service", `oclaw-agent-${agentId}`, "-n", K8S_NAMESPACE);

    const gatewayUrl = await api(`/agents/${agentId}/gateway-url`, { token });
    if (!String(gatewayUrl.body.url || "").startsWith("http://")) {
      throw new Error(`Unexpected gateway URL payload: ${JSON.stringify(gatewayUrl.body)}`);
    }

    await waitForGateway(token, agentId);

    const embedResponse = await fetch(
      `${API_BASE_URL}/agents/${agentId}/gateway/embed?token=${encodeURIComponent(token)}`
    );
    if (!embedResponse.ok) {
      throw new Error(`Gateway embed returned ${embedResponse.status}`);
    }

    await api(`/agents/${agentId}/stop`, { method: "POST", token });
    await waitForAgentStatus(token, agentId, ["stopped"]);

    await api(`/agents/${agentId}/start`, { method: "POST", token });
    await waitForAgentStatus(token, agentId, ["running", "warning"]);
    await waitForGateway(token, agentId);

    await api(`/agents/${agentId}/restart`, { method: "POST", token });
    await waitForAgentStatus(token, agentId, ["running", "warning"]);
    await waitForGateway(token, agentId);

    console.log(JSON.stringify({
      ok: true,
      agentId,
      gatewayUrl: gatewayUrl.body.url,
      namespace: K8S_NAMESPACE,
    }));
  } finally {
    if (token && agentId) {
      await api(`/agents/${agentId}`, {
        method: "DELETE",
        token,
        expectOk: false,
      });
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
