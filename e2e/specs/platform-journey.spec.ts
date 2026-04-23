import { expect, test } from "@playwright/test";
import {
  DEFAULT_PASSWORD,
  authenticatePage,
  createUserSession,
  extractIdFromUrl,
  getCurrentUser,
  getPreferredProvider,
  uniqueEmail,
  uniqueName,
  waitForAdminAuditEvent,
  waitForMarketplaceListingByName,
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

  test("the first operator can sign up and become the admin", async ({ page, request }) => {
    admin = {
      email: uniqueEmail("nora-admin"),
      password: DEFAULT_PASSWORD,
      token: "",
      profile: null,
    };

    await page.goto("/signup");
    await expect(
      page.getByRole("heading", { name: /create operator account/i })
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
      })
    ).toBeVisible();

    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem("token")))
      .toBeTruthy();

    admin.token = await page.evaluate(() => window.localStorage.getItem("token"));
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

    const providerButton = page
      .getByRole("button")
      .filter({ hasText: provider.name })
      .first();
    await providerButton.click();
    await page.getByPlaceholder(new RegExp(`Enter your ${provider.name} API key`, "i")).fill(
      `e2e-${provider.id}-key`
    );
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
    await expect(
      page.getByRole("heading", { name: /deploy new agent/i })
    ).toBeVisible();

    await page.getByPlaceholder(/customer-support-operator/i).fill(primaryAgent.name);

    await Promise.all([
      page.waitForURL(/\/clawhub$/, { waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: /next: choose skills/i }).click(),
    ]);

    await Promise.all([
      page.waitForURL(/\/app\/agents\/[^/?#]+$/, {
        waitUntil: "domcontentloaded",
      }),
      page
        .getByRole("button", { name: /deploy agent & open validation/i })
        .click(),
    ]);

    primaryAgent.id = extractIdFromUrl(page.url(), "/app/agents/");
    await expect(
      page.getByRole("heading", { name: primaryAgent.name, exact: true })
    ).toBeVisible();
    await expect(page.getByText(/deployment queued|provisioning in progress/i)).toBeVisible();

    await authenticatePage(page, admin.token, "/app/dashboard");
    await expect(
      page.getByRole("heading", { name: /system overview/i })
    ).toBeVisible();
    await expect(page.getByText(primaryAgent.name)).toBeVisible();

    await authenticatePage(page, admin.token, "/app/agents");
    await expect(
      page.getByRole("heading", { name: /fleet management/i })
    ).toBeVisible();
    await page.getByPlaceholder(/filter agents by name/i).fill(primaryAgent.name);
    await expect(page.getByText(primaryAgent.name)).toBeVisible();
  });

  test("agent detail supports rename, duplicate, and marketplace publishing", async ({ page, request }) => {
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
      page.getByRole("heading", { name: duplicateAgent.name, exact: true })
    ).toBeVisible();

    await page.getByRole("button", { name: /settings/i }).click();
    const duplicateSettingsSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /general settings/i }) })
      .first();

    publishedListing = {
      id: "",
      name: uniqueName("Marketplace Template"),
    };
    await duplicateSettingsSection
      .getByRole("button", { name: /publish to marketplace/i })
      .click();

    const publishDialog = page.getByRole("dialog", {
      name: /publish to marketplace/i,
    });
    await expect(publishDialog).toBeVisible();
    await publishDialog.getByLabel(/template name/i).fill(publishedListing.name);
    await publishDialog
      .getByLabel(/description/i)
      .fill("Community-ready OpenClaw template used to verify the full Nora platform journey.");

    await Promise.all([
      page.waitForURL(/\/app\/marketplace(\?tab=my)?$/, {
        waitUntil: "domcontentloaded",
      }),
      publishDialog
        .getByRole("button", { name: /submit for review/i })
        .click(),
    ]);

    await expect(page.getByText(publishedListing.name)).toBeVisible();

    const storedListing = await waitForOwnedListingByName(
      request,
      admin.token,
      publishedListing.name
    );
    publishedListing.id = storedListing.id;
  });

  test("the operator can inspect the pending marketplace listing", async ({ page }) => {
    await authenticatePage(page, admin.token, "/app/marketplace?tab=my");
    await expect(page.getByText(publishedListing.name)).toBeVisible();

    await page.locator(`a[href="/app/marketplace/${publishedListing.id}"]`).first().click();
    await page.waitForURL(new RegExp(`/app/marketplace/${publishedListing.id}$`), {
      waitUntil: "domcontentloaded",
    });

    await expect(
      page.getByRole("heading", { name: publishedListing.name, exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /install as new agent/i })
    ).toBeVisible();
  });

  test("workspaces, monitoring, and logs show the account activity", async ({ page, request }) => {
    workspaceName = uniqueName("Ops Workspace");

    await authenticatePage(page, admin.token, "/app/workspaces");
    await expect(
      page.getByRole("heading", { name: /^workspaces$/i })
    ).toBeVisible();

    await page.getByPlaceholder(/new workspace name/i).fill(workspaceName);
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByText(workspaceName)).toBeVisible();

    await page
      .getByRole("button", { name: `Delete workspace ${workspaceName}` })
      .click();
    await expect(page.getByText(workspaceName)).not.toBeVisible();

    await waitForUserEvent(
      request,
      admin.token,
      (event) => String(event.message || "").includes(publishedListing.name)
    );

    await authenticatePage(page, admin.token, "/app/monitoring");
    await expect(
      page.getByRole("heading", { name: /fleet monitoring/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: new RegExp(primaryAgent.name) })
    ).toBeVisible();
    await expect(page.getByText(/submitted for review/i)).toBeVisible();

    await authenticatePage(page, admin.token, "/app/logs");
    await expect(
      page.getByRole("heading", { name: /account event log/i })
    ).toBeVisible();
    await page
      .getByPlaceholder(/source, agent, request, error, or message/i)
      .fill(publishedListing.name);
    await expect(
      page.getByText(publishedListing.name, { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: /clear filters/i }).click();
  });

  test("admin pages show global state and can approve the listing", async ({ page, request }) => {
    secondaryUser = await createUserSession(request, {
      email: uniqueEmail("nora-standard-user"),
    });
    const secondaryProfile = await getCurrentUser(request, secondaryUser.token);
    expect(secondaryProfile.role).toBe("user");

    await authenticatePage(page, admin.token, "/admin");
    await expect(
      page.getByRole("heading", { name: /admin control plane/i })
    ).toBeVisible();
    await expect(page.getByText(/queue health/i)).toBeVisible();

    await page.goto("/admin/fleet", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /global agent fleet/i })
    ).toBeVisible();
    await expect(page.getByText(primaryAgent.name)).toBeVisible();
    await page.goto(`/admin/fleet/${primaryAgent.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: primaryAgent.name, exact: true })
    ).toBeVisible();
    await expect(page.getByText(/runtime metadata/i)).toBeVisible();
    await expect(page.getByText(/live runtime logs/i)).toBeVisible();

    await page.goto("/admin/queue", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /deployment queue and dlq/i })
    ).toBeVisible();
    await expect(page.getByText(/queued deploy jobs/i)).toBeVisible();

    await page.goto("/admin/users", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /accounts and roles/i })
    ).toBeVisible();
    await page.getByPlaceholder(/search by email, name, or user id/i).fill(
      secondaryUser.email
    );
    await expect(
      page.getByRole("row").filter({ hasText: secondaryUser.email }).first()
    ).toBeVisible();

    await page.goto("/admin/marketplace", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /marketplace moderation/i })
    ).toBeVisible();
    await page.goto(`/admin/marketplace/${publishedListing.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: publishedListing.name, exact: true })
    ).toBeVisible();
    await expect(page.getByText("Template Files", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /approve listing/i })).toBeVisible();

    await page.goto("/admin/marketplace", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /marketplace moderation/i })
    ).toBeVisible();

    const listingRow = page
      .getByRole("row")
      .filter({ hasText: publishedListing.name })
      .first();
    await expect(listingRow).toBeVisible();
    await listingRow.getByRole("button", { name: /approve/i }).click();
    await expect(listingRow).toContainText(/published/i);

    await waitForAdminAuditEvent(
      request,
      admin.token,
      (event) => String(event.message || "").includes(publishedListing.name)
    );

    await page.goto("/admin/audit", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /platform activity log/i })
    ).toBeVisible();
    await page
      .getByPlaceholder(/message, source, actor, owner, request, or error/i)
      .fill(publishedListing.name);
    await expect(
      page.getByText(
        `Marketplace listing "${publishedListing.name}" marked published`,
        { exact: true }
      )
    ).toBeVisible();

    await page.goto("/admin/settings", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /^platform settings$/i })
    ).toBeVisible();
  });

  test("a standard user can install the approved listing and is blocked from admin", async ({ page, request }) => {
    const publishedListingForCommunity = await waitForMarketplaceListingByName(
      request,
      secondaryUser.token,
      publishedListing.name
    );

    await authenticatePage(page, secondaryUser.token, "/admin");
    await page.waitForURL(/\/app\/dashboard$/, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: /system overview/i })
    ).toBeVisible();

    await authenticatePage(page, secondaryUser.token, "/app/marketplace?tab=community");
    await expect(
      page.locator(`a[href="/app/marketplace/${publishedListingForCommunity.id}"]`).first()
    ).toBeVisible();

    await page
      .locator(`a[href="/app/marketplace/${publishedListingForCommunity.id}"]`)
      .first()
      .click();
    await page.waitForURL(
      new RegExp(`/app/marketplace/${publishedListingForCommunity.id}$`),
      { waitUntil: "domcontentloaded" }
    );

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
    await expect(
      page.getByRole("heading", { name: installName, exact: true })
    ).toBeVisible();

    await authenticatePage(page, secondaryUser.token, "/app/dashboard");
    await expect(page.getByText(installName)).toBeVisible();
  });
});
