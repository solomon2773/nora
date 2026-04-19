import { expect, test } from "@playwright/test";

test.describe("Public marketing pages", () => {
  test("landing page exposes the main public paths", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        name: /deploy intelligence anywhere\./i,
      })
    ).toBeVisible();
    await expect(page.locator("#platform")).toBeVisible();
    await expect(page.locator("#workflow")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();

    const pricingLink = page.locator('a[href="/pricing"]').first();
    await expect(pricingLink).toBeVisible();

    const docsLink = page.locator(
      'a[href="https://github.com/solomon2773/nora#quick-start"]'
    ).first();
    await expect(docsLink).toBeVisible();

    await page.locator('a[href="#platform"]').first().click();
    await expect(page.locator("#platform")).toBeInViewport();
  });

  test("pricing, login, and signup entry points are reachable", async ({ page }) => {
    await page.goto("/pricing");
    await expect(
      page.getByRole("heading", { name: /open source first/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /what apache 2\.0 means here/i })
    ).toBeVisible();
    await expect(
      page.locator(
        'a[href="https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh"]'
      ).first()
    ).toBeVisible();

    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i })
    ).toBeVisible();

    await page.goto("/signup");
    await expect(
      page.getByRole("heading", { name: /create operator account/i })
    ).toBeVisible();
  });
});
