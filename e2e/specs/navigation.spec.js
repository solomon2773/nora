// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Marketing site navigation", () => {
  test("landing page loads with hero section", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /deploy intelligence anywhere\./i })).toBeVisible();
    await expect(page.getByText(/Fully open source\. Commercial self-hosting allowed\./i)).toBeVisible();
  });

  test("platform section is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#platform")).toBeVisible();
  });

  test("workflow section is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#workflow")).toBeVisible();
  });

  test("footer is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("footer")).toBeVisible();
  });

  test("footer usage-rights link points to public route", async ({ page }) => {
    await page.goto("/");
    const pricingLink = page.locator('footer a[href="/pricing"]').first();
    await expect(pricingLink).toBeVisible();
    await expect(pricingLink).toHaveAttribute("href", "/pricing");
  });

  test("footer links to the real GitHub repo", async ({ page }) => {
    await page.goto("/");
    const repoLink = page.locator('footer a[href="https://github.com/solomon2773/nora"]').first();
    await expect(repoLink).toBeVisible();
    await expect(repoLink).toHaveAttribute("href", "https://github.com/solomon2773/nora");
  });

  test("nav links to platform scrolls", async ({ page }) => {
    await page.goto("/");
    await page.click('a[href="#platform"]');
    await page.waitForTimeout(500);
    await expect(page.locator("#platform")).toBeInViewport();
  });

  test("homepage exposes open-source usage page", async ({ page }) => {
    await page.goto("/");
    const cta = page.locator('a[href="/pricing"]').first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/pricing");
  });

  test("homepage exposes install docs link", async ({ page }) => {
    await page.goto("/");
    const docsLink = page.locator('a[href="https://github.com/solomon2773/nora#quick-start"]').first();
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveAttribute("href", "https://github.com/solomon2773/nora#quick-start");
  });
});

test.describe("Open-source usage page", () => {
  test("usage page loads with current open-source rights copy", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: /open source first/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /what apache 2\.0 means here/i })).toBeVisible();
    await expect(page.getByText(/use nora commercially inside your own company\./i)).toBeVisible();
    await expect(page.getByText(/run nora in paas mode as your own hosted business or internal platform\./i)).toBeVisible();
    await expect(page.locator('a[href="https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh"]').first()).toBeVisible();
  });
});

test.describe("Auth entry points", () => {
  test("login page is accessible", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /log in to your operator account/i })).toBeVisible();
  });

  test("signup page is accessible", async ({ page }) => {
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/signup/);
    await expect(page.getByRole("heading", { name: /create operator account/i })).toBeVisible();
  });
});
