import { expect, test } from "@playwright/test";

test.describe("Public marketing pages", () => {
  test("landing page exposes the main public paths", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        name: /run openclaw and hermes on infrastructure you control/i,
      }),
    ).toBeVisible();
    await expect(page.locator("#platform")).toBeVisible();
    await expect(page.locator("#workflow")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();

    const pricingLink = page.locator('a[href="/pricing"]').first();
    await expect(pricingLink).toBeVisible();

    const docsLink = page.locator('a[href="https://docs.norafleet.ai/quickstart"]').first();
    await expect(docsLink).toBeVisible();

    await page.locator('a[href="#platform"]').first().click();
    await expect(page.locator("#platform")).toBeInViewport();
  });

  test("pricing, login, and signup entry points are reachable", async ({ page }) => {
    await page.goto("/pricing");
    await expect(
      page.getByRole("heading", { name: /open source licensing with room to operate/i }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /what apache 2\.0 means here/i })).toBeVisible();
    await expect(
      page
        .locator('a[href="https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh"]')
        .first(),
    ).toBeVisible();

    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i }),
    ).toBeVisible();

    await page.goto("/signup");
    // A zero-user instance renders first-run claim mode instead of the generic
    // signup heading — both are legitimate states for this route.
    await expect(
      page.getByRole("heading", { name: /create operator account|claim this server/i }),
    ).toBeVisible();
  });

  test("Spanish and French public routes render localized copy", async ({ page }) => {
    await page.goto("/es");
    await expect(
      page.getByRole("heading", {
        name: /ejecuta openclaw y hermes en infraestructura bajo tu control/i,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /prueba la demo sin claves/i }).first(),
    ).toBeVisible();
    await expect(page.locator('a[href="/es/pricing"]').first()).toBeVisible();

    await page.goto("/fr/pricing");
    await expect(
      page.getByRole("heading", {
        name: /la licence open source laisse de la place pour operer/i,
      }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /creer un compte/i }).first()).toBeVisible();
  });

  test("localized auth entry points are reachable", async ({ page }) => {
    await page.goto("/es/login");
    await expect(
      page.getByRole("heading", { name: /inicia sesion en tu cuenta de operador/i }),
    ).toBeVisible();

    await page.goto("/fr/signup");
    await expect(
      page.getByRole("heading", { name: /creer un compte operateur|claim this server/i }),
    ).toBeVisible();
  });

  test("Simplified and Traditional Chinese routes render localized copy", async ({ page }) => {
    await page.goto("/zh-Hans");
    await expect(
      page.getByRole("heading", {
        name: /在您掌控的基础设施上运行 OpenClaw 和 Hermes/i,
      }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /试用零密钥演示/i }).first()).toBeVisible();
    await expect(page.locator('a[href="/zh-Hans/pricing"]').first()).toBeVisible();

    await page.goto("/zh-Hant/login");
    await expect(page.getByRole("heading", { name: /登入您的操作員帳戶/i })).toBeVisible();
  });
});
