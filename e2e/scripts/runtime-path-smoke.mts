#!/usr/bin/env tsx
// @ts-nocheck
import { execFileSync } from "node:child_process";

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:4110";
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || "openclaw-agents";
const KUBECTL_BIN = process.env.KUBECTL_BIN || "/tmp/nora-tools/kubectl";
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.RUNTIME_PATH_SMOKE_POLL_MS || "5000",
  10
);
const POLL_TIMEOUT_MS = Number.parseInt(
  process.env.RUNTIME_PATH_SMOKE_TIMEOUT_MS || "600000",
  10
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(
  path,
  { method = "GET", token = null, body, expectOk = true } = {}
) {
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
      `${method} ${path} failed with ${response.status}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`
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

async function waitForAgent(agentId, token, allowedStatuses) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const { body } = await api(`/agents/${agentId}`, { token });
    if (allowedStatuses.includes(body.status)) return body;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for agent ${agentId} to reach one of: ${allowedStatuses.join(", ")}`
  );
}

async function waitForGateway(agentId, token) {
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

async function waitForMarketplaceListing(token) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const { body } = await api("/marketplace", { token });
    const listing = Array.isArray(body)
      ? body.find((entry) => entry?.status === "published") || body[0]
      : null;
    if (listing?.id) return listing;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for starter marketplace listings");
}

function assertRuntimePath(agent, {
  deployTarget,
  sandboxProfile,
  backendType,
  image,
}) {
  if (agent.deploy_target !== deployTarget) {
    throw new Error(
      `Expected deploy_target=${deployTarget}, received ${agent.deploy_target}`
    );
  }
  if (agent.sandbox_profile !== sandboxProfile) {
    throw new Error(
      `Expected sandbox_profile=${sandboxProfile}, received ${agent.sandbox_profile}`
    );
  }
  if (agent.backend_type !== backendType) {
    throw new Error(
      `Expected backend_type=${backendType}, received ${agent.backend_type}`
    );
  }
  if (agent.image !== image) {
    throw new Error(`Expected image=${image}, received ${agent.image}`);
  }
}

function assertK8sResources(agentId) {
  kubectl("get", "deployment", `oclaw-agent-${agentId}`, "-n", K8S_NAMESPACE);
  kubectl("get", "service", `oclaw-agent-${agentId}`, "-n", K8S_NAMESPACE);
}

async function main() {
  const stamp = Date.now();
  const email = `runtime-path-smoke-${stamp}@example.com`;
  const password = "SmokePassword123!";
  const agentIds = [];

  let token = null;

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

    const sourceDeploy = await api("/agents/deploy", {
      method: "POST",
      token,
      body: { name: `Runtime Path Source ${stamp}` },
    });
    const sourceId = sourceDeploy.body.id;
    agentIds.push(sourceId);

    let sourceAgent = await waitForAgent(sourceId, token, [
      "running",
      "warning",
      "error",
    ]);
    if (sourceAgent.status === "error") {
      throw new Error(`Source agent ${sourceId} entered error state`);
    }
    await waitForGateway(sourceId, token);
    assertRuntimePath(sourceAgent, {
      deployTarget: "docker",
      sandboxProfile: "standard",
      backendType: "docker",
      image: "nora-openclaw-agent:local",
    });

    const duplicateDeploy = await api(`/agents/${sourceId}/duplicate`, {
      method: "POST",
      token,
      body: {
        name: `Runtime Path Duplicate ${stamp}`,
        deploy_target: "k8s",
        clone_mode: "files_only",
      },
    });
    const duplicateId = duplicateDeploy.body.id;
    agentIds.push(duplicateId);

    const duplicateAgent = await waitForAgent(duplicateId, token, [
      "running",
      "warning",
      "error",
    ]);
    if (duplicateAgent.status === "error") {
      throw new Error(`Duplicate agent ${duplicateId} entered error state`);
    }
    await waitForGateway(duplicateId, token);
    assertRuntimePath(duplicateAgent, {
      deployTarget: "k8s",
      sandboxProfile: "standard",
      backendType: "k8s",
      image: "node:24-slim",
    });
    assertK8sResources(duplicateId);

    await api(`/agents/${sourceId}/stop`, { method: "POST", token });
    await waitForAgent(sourceId, token, ["stopped"]);

    await api(`/agents/${sourceId}/redeploy`, {
      method: "POST",
      token,
      body: {
        deploy_target: "k8s",
      },
    });
    sourceAgent = await waitForAgent(sourceId, token, [
      "running",
      "warning",
      "error",
    ]);
    if (sourceAgent.status === "error") {
      throw new Error(`Redeployed source agent ${sourceId} entered error state`);
    }
    await waitForGateway(sourceId, token);
    assertRuntimePath(sourceAgent, {
      deployTarget: "k8s",
      sandboxProfile: "standard",
      backendType: "k8s",
      image: "node:24-slim",
    });
    assertK8sResources(sourceId);

    const listing = await waitForMarketplaceListing(token);
    const installDeploy = await api("/marketplace/install", {
      method: "POST",
      token,
      body: {
        listingId: listing.id,
        name: `Runtime Path Install ${stamp}`,
        deploy_target: "k8s",
      },
    });
    const installedId = installDeploy.body.id;
    agentIds.push(installedId);

    const installedAgent = await waitForAgent(installedId, token, [
      "running",
      "warning",
      "error",
    ]);
    if (installedAgent.status === "error") {
      throw new Error(`Installed agent ${installedId} entered error state`);
    }
    await waitForGateway(installedId, token);
    assertRuntimePath(installedAgent, {
      deployTarget: "k8s",
      sandboxProfile: "standard",
      backendType: "k8s",
      image: "node:24-slim",
    });
    assertK8sResources(installedId);

    console.log(
      JSON.stringify(
        {
          ok: true,
          apiBaseUrl: API_BASE_URL,
          sourceAgentId: sourceId,
          duplicateAgentId: duplicateId,
          installedAgentId: installedId,
          marketplaceListingId: listing.id,
        },
        null,
        2
      )
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
