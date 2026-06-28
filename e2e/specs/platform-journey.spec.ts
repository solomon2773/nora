import { expect, test } from "@playwright/test";
import {
  DEFAULT_PASSWORD,
  apiJson,
  authenticatePage,
  createUserSession,
  extractIdFromUrl,
  getCurrentUser,
  getPreferredProvider,
  loginInFreshContext,
  uniqueEmail,
  uniqueName,
  waitForAdminAuditEvent,
  waitForAgentHubListingByName,
  waitForOwnedListingByName,
  waitForUserEvent,
} from "./support/app";

test.describe("Complete platform journey", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120000);

  /** @type {{email: string, password: string, token: string, profile: any} | null} */
  let admin = null;
  /** @type {{email: string, password: string, token: string} | null} */
  let secondaryUser = null;
  /** @type {{id: string, name: string, model?: string} | null} */
  let provider = null;
  /** @type {{id: string, name: string} | null} */
  let primaryAgent = null;
  /** @type {{id: string, name: string} | null} */
  let duplicateAgent = null;
  /** @type {{id: string, name: string} | null} */
  let publishedListing = null;
  let workspaceName = "";
  const authCookieName = "nora_auth";

  async function loginAndCaptureToken(_requestContext, email, password) {
    return loginInFreshContext(email, password);
  }

  test("the first operator can sign up and become the admin", async ({ page, request }) => {
    admin = {
      email: uniqueEmail("nora-admin"),
      password: DEFAULT_PASSWORD,
      token: "",
      profile: null,
    };

    await page.goto("/signup");
    // The signup heading is race-prone: it renders "Create operator account" by
    // default, then flips to "Claim this server" once the async bootstrap-status
    // fetch confirms a zero-user instance. On a fresh E2E stack the page settles
    // on the claim variant, so accept either heading (same idiom as
    // navigation.spec.ts) — this is just a "signup page is ready" gate.
    await expect(
      page.getByRole("heading", { name: /create operator account|claim this server/i }),
    ).toBeVisible();

    await page.getByLabel(/email address/i).fill(admin.email);
    await page.getByLabel(/^password$/i).fill(admin.password);

    await Promise.all([
      page.waitForURL(/\/app\/getting-started$/, {
        waitUntil: "domcontentloaded",
      }),
      page.getByRole("button", { name: /^create account$/i }).click(),
    ]);

    await expect(
      page.getByRole("heading", {
        name: /bring nora online like a production operator platform/i,
      }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const cookies = await page.context().cookies();
        return cookies.some((cookie) => cookie.name === authCookieName);
      })
      .toBe(true);

    admin.token = await loginAndCaptureToken(request, admin.email, admin.password);
    admin.profile = await getCurrentUser(request, admin.token);

    expect(admin.profile.email).toBe(admin.email);
    expect(admin.profile.role).toBe("admin");
  });

  test("settings can change the password and save a provider key", async ({ page, request }) => {
    provider = await getPreferredProvider(request, admin.token);
    expect(provider).toBeTruthy();

    await authenticatePage(page, admin.token, "/app/settings");
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible();
    await expect(page.getByText(admin.email)).toBeVisible();
    await expect(page.getByText(/resource limits/i)).toBeVisible();

    const nextPassword = "SmokePassword456!";
    await page.getByPlaceholder("Enter current password").fill(admin.password);
    await page.getByPlaceholder("At least 6 characters").fill(nextPassword);
    await page.getByPlaceholder("Re-enter new password").fill(nextPassword);
    await page.getByRole("button", { name: /update password/i }).click();
    await expect(page.getByText(/password updated successfully/i)).toBeVisible();
    admin.password = nextPassword;

    const providerButton = page.getByRole("button").filter({ hasText: provider.name }).first();
    await providerButton.click();
    await page
      .getByPlaceholder(new RegExp(`Enter your ${provider.name} API key`, "i"))
      .fill(`e2e-${provider.id}-key`);
    await page.getByRole("button", { name: /save api key/i }).click();
    await expect(page.getByRole("heading", { name: /provider added!/i })).toBeVisible();
    await page.getByRole("button", { name: /add another/i }).click();
    await expect(page.getByText(/configured llm providers/i)).toBeVisible();
    await expect(page.getByText(provider.name).first()).toBeVisible();
  });

  test("deploy queues an agent and the dashboard reflects it", async ({ page }) => {
    primaryAgent = {
      id: "",
      name: uniqueName("Primary Agent"),
    };

    await authenticatePage(page, admin.token, "/app/deploy");
    await expect(page.getByRole("heading", { name: /deploy new agent/i })).toBeVisible();

    await page.getByPlaceholder(/customer-support-operator/i).fill(primaryAgent.name);

    await Promise.all([
      page.waitForURL(/\/clawhub$/, { waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: /next: choose skills/i }).click(),
    ]);

    await Promise.all([
      page.waitForURL(/\/app\/agents\/[^/?#]+$/, {
        waitUntil: "domcontentloaded",
      }),
      page.getByRole("button", { name: /deploy agent & open validation/i }).click(),
    ]);

    primaryAgent.id = extractIdFromUrl(page.url(), "/app/agents/");
    await expect(page.getByRole("heading", { name: primaryAgent.name, exact: true })).toBeVisible();
    await expect(page.getByText(/deployment queued|provisioning in progress/i)).toBeVisible();

    await authenticatePage(page, admin.token, "/app/dashboard");
    await expect(page.getByRole("heading", { name: /system overview/i })).toBeVisible();
    await expect(page.getByText(primaryAgent.name)).toBeVisible();

    await authenticatePage(page, admin.token, "/app/agents");
    await expect(page.getByRole("heading", { name: /fleet management/i })).toBeVisible();
    await page.getByPlaceholder(/filter agents by name/i).fill(primaryAgent.name);
    await expect(page.getByText(primaryAgent.name)).toBeVisible();
  });

  test("agent detail supports rename, duplicate, and Agent Hub sharing", async ({
    page,
    request,
  }) => {
    await authenticatePage(page, admin.token, `/app/agents/${primaryAgent.id}`);
    await page.getByRole("button", { name: /settings/i }).click();

    primaryAgent.name = uniqueName("Renamed Agent");
    const settingsSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /general settings/i }) })
      .first();
    await settingsSection.locator('input[type="text"]').first().fill(primaryAgent.name);
    await settingsSection.getByRole("button", { name: /save name/i }).click();
    await expect(settingsSection.getByText(primaryAgent.name)).toBeVisible();

    duplicateAgent = {
      id: "",
      name: uniqueName("Duplicate Agent"),
    };
    await settingsSection.getByRole("button", { name: /duplicate agent/i }).click();

    const duplicateDialog = page.getByRole("dialog", { name: /^duplicate agent$/i });
    await expect(duplicateDialog).toBeVisible();
    await duplicateDialog.getByLabel(/new agent name/i).fill(duplicateAgent.name);

    await Promise.all([
      page.waitForURL(/\/app\/agents\/[^/?#]+$/, {
        waitUntil: "domcontentloaded",
      }),
      duplicateDialog.getByRole("button", { name: /^duplicate$/i }).click(),
    ]);

    duplicateAgent.id = extractIdFromUrl(page.url(), "/app/agents/");
    await expect(
      page.getByRole("heading", { name: duplicateAgent.name, exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: /settings/i }).click();
    const duplicateSettingsSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /general settings/i }) })
      .first();

    publishedListing = {
      id: "",
      name: uniqueName("Agent Hub Template"),
    };
    await duplicateSettingsSection.getByRole("button", { name: /share to agent hub/i }).click();

    const publishDialog = page.getByRole("dialog", {
      name: /share to agent hub/i,
    });
    await expect(publishDialog).toBeVisible();
    await publishDialog.getByLabel(/template name/i).fill(publishedListing.name);
    await publishDialog
      .getByLabel(/description/i)
      .fill("Community-ready OpenClaw template used to verify the full Nora platform journey.");

    await Promise.all([
      page.waitForURL(/\/app\/agent-hub(\?tab=my)?$/, {
        waitUntil: "domcontentloaded",
      }),
      publishDialog.getByRole("button", { name: /share template/i }).click(),
    ]);

    await expect(page.getByText(publishedListing.name)).toBeVisible();

    const storedListing = await waitForOwnedListingByName(
      request,
      admin.token,
      publishedListing.name,
    );
    publishedListing.id = storedListing.id;
  });

  test("the operator can inspect the shared Agent Hub listing", async ({ page }) => {
    await authenticatePage(page, admin.token, "/app/agent-hub?tab=my");
    await expect(page.getByText(publishedListing.name)).toBeVisible();

    await page.locator(`a[href="/app/agent-hub/${publishedListing.id}"]`).first().click();
    await page.waitForURL(new RegExp(`/app/agent-hub/${publishedListing.id}$`), {
      waitUntil: "domcontentloaded",
    });

    await expect(
      page.getByRole("heading", { name: publishedListing.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /install as new agent/i })).toBeVisible();
  });

  test("workspaces, monitoring, and logs show the account activity", async ({ page, request }) => {
    workspaceName = uniqueName("Ops Workspace");

    await authenticatePage(page, admin.token, "/app/workspaces");
    await expect(page.getByRole("heading", { name: /^workspaces$/i })).toBeVisible();

    await page.getByPlaceholder(/new workspace name/i).fill(workspaceName);
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByText(workspaceName)).toBeVisible();

    await page.getByRole("button", { name: `Delete workspace ${workspaceName}` }).click();
    await expect(page.getByText(workspaceName)).not.toBeVisible();

    await waitForUserEvent(request, admin.token, (event) =>
      String(event.message || "").includes(publishedListing.name),
    );

    await authenticatePage(page, admin.token, "/app/monitoring");
    await expect(page.getByRole("heading", { name: /fleet monitoring/i })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(primaryAgent.name) })).toBeVisible();
    await expect(
      page.getByText(`Agent Hub listing "${publishedListing.name}" was shared`),
    ).toBeVisible();

    await authenticatePage(page, admin.token, "/app/logs");
    await expect(page.getByRole("heading", { name: /account event log/i })).toBeVisible();
    await page
      .getByPlaceholder(/source, agent, request, error, or message/i)
      .fill(publishedListing.name);
    await expect(page.getByText(publishedListing.name, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /clear filters/i }).click();
  });

  test("admin pages show global state and can approve the listing", async ({ page, request }) => {
    secondaryUser = await createUserSession(request, {
      email: uniqueEmail("nora-standard-user"),
    });
    const secondaryProfile = await getCurrentUser(request, secondaryUser.token);
    expect(secondaryProfile.role).toBe("user");
    admin.token = await loginAndCaptureToken(request, admin.email, admin.password);

    await authenticatePage(page, admin.token, "/admin");
    await expect(page.getByRole("heading", { name: /admin control plane/i })).toBeVisible();
    await expect(page.getByText(/queue health/i)).toBeVisible();

    await page.goto("/admin/fleet", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /global agent fleet/i })).toBeVisible();
    await expect(page.getByText(primaryAgent.name)).toBeVisible();
    await page.goto(`/admin/fleet/${primaryAgent.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { name: primaryAgent.name, exact: true })).toBeVisible();
    await expect(page.getByText(/runtime metadata/i)).toBeVisible();
    await expect(page.getByText(/live runtime logs/i)).toBeVisible();

    await page.goto("/admin/queue", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /deployment queue and dlq/i })).toBeVisible();
    await expect(page.getByText(/queued deploy jobs/i)).toBeVisible();

    await page.goto("/admin/users", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /accounts and roles/i })).toBeVisible();
    await page.getByPlaceholder(/search by email, name, or user id/i).fill(secondaryUser.email);
    await expect(
      page.getByRole("row").filter({ hasText: secondaryUser.email }).first(),
    ).toBeVisible();

    await page.goto("/admin/agent-hub", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /agent hub moderation/i })).toBeVisible();
    await page.goto(`/admin/agent-hub/${publishedListing.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: publishedListing.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Template Files", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /approve listing/i })).toBeVisible();

    await page.goto("/admin/agent-hub", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /agent hub moderation/i })).toBeVisible();

    const listingRow = page.getByRole("row").filter({ hasText: publishedListing.name }).first();
    await expect(listingRow).toBeVisible();
    await listingRow.getByRole("button", { name: /approve/i }).click();
    await expect(listingRow).toContainText(/published/i);

    const publishedAuditMessage = `Agent Hub listing "${publishedListing.name}" marked published`;
    await waitForAdminAuditEvent(
      request,
      admin.token,
      (event) => String(event.message || "") === publishedAuditMessage,
    );

    await page.goto("/admin/audit", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /platform activity log/i })).toBeVisible();
    await page
      .getByPlaceholder(/message, source, actor, owner, request, or error/i)
      .fill(publishedListing.name);
    await expect(page.getByText(publishedAuditMessage, { exact: true })).toBeVisible();

    await page.goto("/admin/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /^platform settings$/i })).toBeVisible();

    await page.getByLabel(/platform default/i).selectOption("es");
    await page.getByRole("button", { name: /save language/i }).click();
    await expect(page.getByText(/default language updated/i)).toBeVisible();

    await authenticatePage(page, secondaryUser.token, "/app/settings");
    await page.waitForURL(/\/app\/es\/settings$/, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /configuracion/i })).toBeVisible();

    await page.getByLabel(/display language/i).selectOption("fr");
    await page.waitForURL(/\/app\/fr\/settings$/, { waitUntil: "domcontentloaded" });
    const localizedProfile = await getCurrentUser(request, secondaryUser.token);
    expect(localizedProfile.preferredLocale).toBe("fr");
    expect(localizedProfile.effectiveLocale).toBe("fr");

    await apiJson(request, "/api/admin/settings/language", {
      method: "PUT",
      token: admin.token,
      data: { defaultLocale: "en" },
    });
    await apiJson(request, "/api/auth/profile", {
      method: "PATCH",
      token: secondaryUser.token,
      data: { preferredLocale: null },
    });
  });

  test("a standard user can install the approved listing and is blocked from admin", async ({
    page,
    request,
  }) => {
    const publishedListingForCommunity = await waitForAgentHubListingByName(
      request,
      secondaryUser.token,
      publishedListing.name,
    );

    await authenticatePage(page, secondaryUser.token, "/admin");
    await page.waitForURL(/\/app\/dashboard$/, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { name: /system overview/i })).toBeVisible();

    await authenticatePage(page, secondaryUser.token, "/app/agent-hub");
    await expect(
      page.locator(`a[href="/app/agent-hub/${publishedListingForCommunity.id}"]`).first(),
    ).toBeVisible();

    await page
      .locator(`a[href="/app/agent-hub/${publishedListingForCommunity.id}"]`)
      .first()
      .click();
    await page.waitForURL(new RegExp(`/app/agent-hub/${publishedListingForCommunity.id}$`), {
      waitUntil: "domcontentloaded",
    });

    const installName = uniqueName("Community Install");
    await page.getByRole("button", { name: /install as new agent/i }).click();

    const installDialog = page.getByRole("dialog", { name: /install template/i });
    await expect(installDialog).toBeVisible();
    await installDialog.getByLabel(/new agent name/i).fill(installName);

    await Promise.all([
      page.waitForURL(/\/app\/agents\/[^/?#]+$/, {
        waitUntil: "domcontentloaded",
      }),
      installDialog.getByRole("button", { name: /^install$/i }).click(),
    ]);

    const installedAgentId = extractIdFromUrl(page.url(), "/app/agents/");
    expect(installedAgentId).toBeTruthy();
    await expect(page.getByRole("heading", { name: installName, exact: true })).toBeVisible();

    await authenticatePage(page, secondaryUser.token, "/app/dashboard");
    await expect(page.getByText(installName)).toBeVisible();
  });
});
