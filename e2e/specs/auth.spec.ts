import { expect, test } from "@playwright/test";

test.describe("Auth gates", () => {
  test("login rejects invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i })
    ).toBeVisible();

    await page.getByLabel(/email address/i).fill("invalid@example.com");
    await page.getByLabel(/^password$/i).fill("not-the-right-password");
    await page.getByRole("button", { name: /^log in$/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByText(/invalid email or password|login failed/i)
    ).toBeVisible();
  });

  test("operator and admin surfaces require authentication", async ({ page }) => {
    await page.goto("/app/dashboard");
    await page.waitForURL(/\/login$/, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i })
    ).toBeVisible();

    await page.goto("/admin");
    await page.waitForURL(/\/login$/, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /log in to your operator account/i })
    ).toBeVisible();
  });
});
