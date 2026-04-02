// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Marketing site navigation", () => {
  test("landing page loads with hero section", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /open-source control plane/i })).toBeVisible();
    await expect(page.getByText("OpenClaw agents", { exact: true })).toBeVisible();
  });

  test("features section is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#features")).toBeVisible();
  });

  test("how-it-works section is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#how-it-works")).toBeVisible();
  });

  test("footer is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("footer")).toBeVisible();
  });

  test("footer pricing link points to public pricing route", async ({ page }) => {
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

  test("nav links to features scrolls", async ({ page }) => {
    await page.goto("/");
    await page.click('a[href="#features"]');
    await page.waitForTimeout(500);
    await expect(page.locator("#features")).toBeInViewport();
  });

  test("homepage exposes commercial paths CTA", async ({ page }) => {
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

test.describe("Pricing page", () => {
  test("pricing page loads with commercial-path copy while keeping current domain proof visible", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: /open source first\.?\s*commercial help when you need it\.?/i })).toBeVisible();
    await expect(page.getByText(/repo → support → managed/i)).toBeVisible();
    await expect(page.getByText(/paid onboarding & support/i)).toBeVisible();
    await expect(page.getByText(/managed nora \/ custom deployment/i)).toBeVisible();
    await expect(page.locator('a[href="https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh"]').first()).toBeVisible();
  });
});

test.describe("Dashboard navigation", () => {
  test("dashboard redirects without auth", async ({ page }) => {
    await page.goto("/app/agents");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login page is accessible", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
  });
});
