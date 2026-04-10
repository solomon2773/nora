#!/usr/bin/env node
import { chromium } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8080";
const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:4100";
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.DASHBOARD_SMOKE_POLL_MS || "5000",
  10
);
const POLL_TIMEOUT_MS = Number.parseInt(
  process.env.DASHBOARD_SMOKE_TIMEOUT_MS || "240000",
  10
);
const HEADLESS = process.env.HEADLESS !== "0";
const ALLOW_LOCAL_HTTPS_ERRORS =
  process.env.ALLOW_LOCAL_HTTPS_ERRORS === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiUrl(path) {
  return new URL(path.replace(/^\//, ""), `${API_BASE_URL.replace(/\/$/, "")}/`).toString();
}

async function api(
  path,
  { method = "GET", token = null, body, expectOk = true } = {}
) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(apiUrl(path), {
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
    `Timed out waiting for agent ${agentId} to reach one of: ${allowedStatuses.join(", ")}`
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

async function gotoHeading(page, pathname, headingText) {
  await page.goto(new URL(pathname, BASE_URL).toString(), {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("heading", { name: headingText, exact: true })
    .waitFor({ state: "visible", timeout: 30000 });
}

async function waitForDeployButtonEnabled(page) {
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll("button")).find((node) =>
      /Deploy Agent & Open Validation/i.test(node.textContent || "")
    );
    return Boolean(button && !button.disabled);
  });
}

function extractAgentIdFromUrl(url) {
  const match = url.match(/\/app\/agents\/([^/?#]+)/);
  if (!match) {
    throw new Error(`Could not extract agent id from URL: ${url}`);
  }
  return match[1];
}

function openClawButton(page) {
  return page.getByRole("button", { name: "OpenClaw" }).first();
}

async function main() {
  const stamp = Date.now();
  const email = `dashboard-runtime-smoke-${stamp}@example.com`;
  const password = "SmokePassword123!";
  const agentName = `Release Smoke ${stamp}`;

  let token = null;
  let agentId = null;
  let browser = null;

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

    browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({
      ignoreHTTPSErrors: ALLOW_LOCAL_HTTPS_ERRORS,
      viewport: { width: 1512, height: 1080 },
      deviceScaleFactor: 1,
    });

    await context.addInitScript((storedToken) => {
      window.localStorage.setItem("token", storedToken);
    }, token);

    const page = await context.newPage();

    await gotoHeading(page, "/app/dashboard", "System Overview");
    await gotoHeading(page, "/app/agents", "Fleet Management");
    await gotoHeading(page, "/app/deploy", "Deploy New Agent");

    await page
      .getByPlaceholder("e.g. customer-support-operator")
      .fill(agentName);
    await waitForDeployButtonEnabled(page);

    await Promise.all([
      page.waitForURL(/\/app\/agents\/[^/?#]+$/, { timeout: 30000 }),
      page
        .getByRole("button", { name: /Deploy Agent & Open Validation/i })
        .click(),
    ]);

    agentId = extractAgentIdFromUrl(page.url());
    await page
      .getByRole("heading", { name: agentName, exact: true })
      .waitFor({ state: "visible", timeout: 30000 });

    const deployedAgent = await waitForAgentStatus(token, agentId, [
      "running",
      "warning",
      "error",
    ]);
    if (deployedAgent.status === "error") {
      throw new Error(`Agent ${agentId} entered error state`);
    }

    await waitForGateway(token, agentId);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: agentName, exact: true })
      .waitFor({ state: "visible", timeout: 30000 });
    await openClawButton(page).click();
    await page.getByRole("heading", { name: "Gateway Status", exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
    await page.getByText("Online", { exact: true }).first().waitFor({
      state: "visible",
      timeout: 30000,
    });

    const gatewayUrl = await api(`/agents/${agentId}/gateway-url`, { token });
    if (!String(gatewayUrl.body.url || "").startsWith("http")) {
      throw new Error(
        `Unexpected gateway URL payload: ${JSON.stringify(gatewayUrl.body)}`
      );
    }

    const embedResponse = await fetch(
      apiUrl(
        `/agents/${agentId}/gateway/embed?token=${encodeURIComponent(token)}`
      )
    );
    if (!embedResponse.ok) {
      throw new Error(`Gateway embed returned ${embedResponse.status}`);
    }

    await api(`/agents/${agentId}/stop`, { method: "POST", token });
    await waitForAgentStatus(token, agentId, ["stopped"]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: agentName, exact: true })
      .waitFor({ state: "visible", timeout: 30000 });
    await openClawButton(page).click();
    await page
      .getByText(/OpenClaw Gateway available when agent is running/i)
      .waitFor({ state: "visible", timeout: 30000 });

    await api(`/agents/${agentId}/start`, { method: "POST", token });
    await waitForAgentStatus(token, agentId, ["running", "warning"]);
    await waitForGateway(token, agentId);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: agentName, exact: true })
      .waitFor({ state: "visible", timeout: 30000 });
    await openClawButton(page).click();
    await page.getByRole("heading", { name: "Gateway Status", exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
    await page.getByText("Online", { exact: true }).first().waitFor({
      state: "visible",
      timeout: 30000,
    });

    await api(`/agents/${agentId}/restart`, { method: "POST", token });
    await waitForAgentStatus(token, agentId, ["running", "warning"]);
    await waitForGateway(token, agentId);

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: BASE_URL,
          apiBaseUrl: API_BASE_URL,
          agentId,
          status: "running-or-warning",
          gatewayUrl: gatewayUrl.body.url,
        },
        null,
        2
      )
    );
  } finally {
    if (token && agentId) {
      await api(`/agents/${agentId}`, {
        method: "DELETE",
        token,
        expectOk: false,
      });
    }
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
