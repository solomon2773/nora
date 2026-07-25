import { expect, test, type Page } from "@playwright/test";

type LocalDockerDemoCapability = {
  enabled: boolean;
  runtimeFamily: string;
  deployTarget: string;
  executionTargetId: string;
  sandboxProfile: string;
  requiresLiveDocker: boolean;
  issue?: string | null;
};

async function mockGettingStartedApis(
  page: Page,
  {
    enabledDeployTargets,
    localDockerDemo,
  }: {
    enabledDeployTargets: string[];
    localDockerDemo: LocalDockerDemoCapability;
  },
) {
  let activationRequested = false;
  const consoleErrors: string[] = [];
  const httpFailures: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) httpFailures.push(`${response.status()} ${response.url()}`);
  });

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "operator-1", email: "operator@example.com", role: "admin" }),
    });
  });
  await page.route("**/api/config/platform", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "selfhosted",
        enabledDeployTargets,
        capabilities: { localDockerDemo },
        systemBanner: null,
        language: { defaultLocale: "en" },
      }),
    });
  });
  await page.route("**/api/agents/activate-demo", async (route) => {
    activationRequested = true;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Activation should not be called" }),
    });
  });
  await page.route("**/api/llm-providers", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/agents", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/workspaces", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  return {
    consoleErrors,
    httpFailures,
    activationWasRequested: () => activationRequested,
  };
}

async function expectDemoActivationDisabled(page: Page) {
  await expect(page.getByRole("button", { name: /local docker demo unavailable/i })).toBeDisabled();
}

test.describe("Getting started capabilities", () => {
  test("disables the local Docker demo action on Kubernetes-only deployments", async ({ page }) => {
    const harness = await mockGettingStartedApis(page, {
      enabledDeployTargets: ["k8s"],
      localDockerDemo: {
        enabled: false,
        runtimeFamily: "openclaw",
        deployTarget: "docker",
        executionTargetId: "docker",
        sandboxProfile: "standard",
        requiresLiveDocker: true,
        issue: "Local Docker demo is not enabled.",
      },
    });

    await page.goto("/app/getting-started");

    await expectDemoActivationDisabled(page);
    await expect(page.getByTestId("demo-activation-unavailable")).toContainText(
      "Local Docker demo is not enabled.",
    );
    expect(harness.activationWasRequested()).toBe(false);
    expect(harness.consoleErrors).toEqual([]);
    expect(harness.httpFailures).toEqual([]);
  });

  test("surfaces a non-Docker capability reason while keeping activation disabled", async ({
    page,
  }) => {
    const harness = await mockGettingStartedApis(page, {
      enabledDeployTargets: ["docker"],
      localDockerDemo: {
        enabled: false,
        runtimeFamily: "openclaw",
        deployTarget: "docker",
        executionTargetId: "docker",
        sandboxProfile: "standard",
        requiresLiveDocker: true,
        issue: "The OpenClaw runtime family is disabled by this deployment.",
      },
    });

    await page.goto("/app/getting-started");

    await expectDemoActivationDisabled(page);
    const unavailableMessage = page.getByTestId("demo-activation-unavailable");
    await expect(unavailableMessage).toContainText(
      "The OpenClaw runtime family is disabled by this deployment.",
    );
    await expect(unavailableMessage).not.toContainText(/does not enable the local Docker target/i);
    expect(harness.activationWasRequested()).toBe(false);
    expect(harness.consoleErrors).toEqual([]);
    expect(harness.httpFailures).toEqual([]);
  });

  test("describes the complete demo tuple when the backend omits a reason", async ({ page }) => {
    const harness = await mockGettingStartedApis(page, {
      enabledDeployTargets: ["docker"],
      localDockerDemo: {
        enabled: false,
        runtimeFamily: "openclaw",
        deployTarget: "docker",
        executionTargetId: "docker",
        sandboxProfile: "standard",
        requiresLiveDocker: true,
        issue: null,
      },
    });

    await page.goto("/app/getting-started");

    await expectDemoActivationDisabled(page);
    await expect(page.getByTestId("demo-activation-unavailable")).toContainText(
      "requires the OpenClaw runtime, local Docker execution target, and standard sandbox profile to be enabled together",
    );
    expect(harness.activationWasRequested()).toBe(false);
    expect(harness.consoleErrors).toEqual([]);
    expect(harness.httpFailures).toEqual([]);
  });
});
