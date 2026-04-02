// @ts-check
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:18080";
const repoRoot = path.resolve(__dirname, "..");
const manageLocalStack = !process.env.BASE_URL || process.env.PLAYWRIGHT_MANAGED_SERVER === "1";

module.exports = defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: manageLocalStack
    ? {
        command: "./e2e/scripts/start-local-stack.sh",
        cwd: repoRoot,
        url: `${BASE_URL}/login`,
        reuseExistingServer: false,
        timeout: 240000,
      }
    : undefined,
});
