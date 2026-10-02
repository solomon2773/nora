// @ts-nocheck
// Captures the screenshots used by docs/guides/logging.mdx from a running
// local stack, signed in as a real account that already has a running agent
// with collected logs (seeded demo agents have no containers, so the Logs
// pages would only show empty states).
//
// Usage (from e2e/):
//   NORA_SCREENSHOT_EMAIL=you@example.com \
//   NORA_SCREENSHOT_PASSWORD_FILE=/path/to/file-containing-password \
//   NORA_SCREENSHOT_AGENT_ID=<agent id with logs> \
//   npx tsx ./scripts/capture-logging-docs-shots.mts
//
// The account must be a platform admin for the admin-dashboard shots. The
// delete-agent shot only opens the confirmation dialog and cancels it.
//
// The workspace-settings shot needs a workspace. Pass an existing one with
// NORA_SCREENSHOT_WORKSPACE_ID, or set NORA_SCREENSHOT_TEMP_WORKSPACE=1 to
// have the script create one, capture it, and delete it again.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.NORA_SCREENSHOT_BASE_URL || "http://localhost:8080";
const OUT_DIR =
  process.env.NORA_LOGGING_SCREENSHOT_DIR ||
  path.resolve(__dirname, "../../docs/images/guides/logging");
const EMAIL = process.env.NORA_SCREENSHOT_EMAIL;
const PASSWORD_FILE = process.env.NORA_SCREENSHOT_PASSWORD_FILE;
const AGENT_ID = process.env.NORA_SCREENSHOT_AGENT_ID;
const WORKSPACE_ID = process.env.NORA_SCREENSHOT_WORKSPACE_ID || "";
const USE_TEMP_WORKSPACE = process.env.NORA_SCREENSHOT_TEMP_WORKSPACE === "1";

if (!EMAIL || !PASSWORD_FILE || !AGENT_ID) {
  console.error(
    "Set NORA_SCREENSHOT_EMAIL, NORA_SCREENSHOT_PASSWORD_FILE, and NORA_SCREENSHOT_AGENT_ID.",
  );
  process.exit(1);
}
const PASSWORD = fs.readFileSync(PASSWORD_FILE, "utf8").trim();

const shot = (name) => path.join(OUT_DIR, name);

async function settle(page, ms = 900) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

// These shots go into public docs but are taken as a real account, so swap
// the account's email/name and any IP addresses for placeholders in the
// rendered page before each capture.
async function redact(page) {
  const localPart = EMAIL.split("@")[0];
  await page.evaluate(
    ({ email, localPart }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        if (!text) continue;
        const next = text
          .split(email)
          .join("operator@example.com")
          .split(localPart)
          .join("operator")
          .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "203.0.113.10");
        if (next !== text) node.nodeValue = next;
      }
    },
    { email: EMAIL, localPart },
  );
}

async function capture(page, name, target = page) {
  await redact(page);
  await target.screenshot({ path: shot(name) });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });

  try {
    const res = await context.request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    if (!res.ok()) throw new Error(`login failed: HTTP ${res.status()}`);
    const body = await res.json().catch(() => ({}));
    if (body?.token) {
      await context.addInitScript((token) => {
        window.localStorage.setItem("token", token);
      }, body.token);
    }

    const page = await context.newPage();
    const captured = [];
    const attempt = async (name, fn) => {
      try {
        await fn();
        captured.push(name);
      } catch (error) {
        console.warn(`[logging-shots] ${name} failed: ${error.message}`);
      }
    };

    // 1. Agent Logs → Runtime, for the agent with collected logs.
    await attempt("logs-runtime.png", async () => {
      await page.goto(`${BASE_URL}/app/logs`, { waitUntil: "networkidle" });
      await settle(page);
      await page
        .getByRole("button", { name: /^Agent Logs$/ })
        .first()
        .click();
      await settle(page, 500);
      const agentSelect = page.locator("select").filter({
        has: page.locator(`option[value="${AGENT_ID}"]`),
      });
      if (await agentSelect.count()) {
        await agentSelect.first().selectOption(AGENT_ID);
      }
      await page
        .getByRole("button", { name: /^24h$/ })
        .first()
        .click()
        .catch(() => {});
      await settle(page, 2500);
      await capture(page, "logs-runtime.png");
    });

    // 2. Delete-agent confirmation with the Keep logs / Delete logs choice.
    // Opens the dialog and cancels — never confirms.
    await attempt("agent-delete-logs.png", async () => {
      await page.goto(`${BASE_URL}/app/agents/${AGENT_ID}`, { waitUntil: "networkidle" });
      await settle(page);
      await page
        .getByRole("button", { name: /^Settings$/ })
        .first()
        .click();
      await settle(page, 600);
      await page
        .getByRole("button", { name: /^Delete Agent$/ })
        .last()
        .click();
      // ConfirmDialog has no dialog role; its card is the white panel
      // inside the fixed overlay.
      const card = page
        .locator("div.fixed.inset-0 > div.relative")
        .filter({ hasText: "Keep logs" })
        .first();
      await card.waitFor({ state: "visible", timeout: 5000 });
      await page.waitForTimeout(500);
      // Whole window, so the agent page shows dimmed behind the dialog.
      // Scroll back to the top first so the background is the agent header,
      // then clip to the overlay's box — it stops short of the viewport's
      // bottom edge, which would otherwise leave an undimmed strip.
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelectorAll("main, [class*='overflow-y-auto']").forEach((el) => {
          el.scrollTop = 0;
        });
      });
      await page.waitForTimeout(400);
      const overlay = await page
        .locator("div.fixed.inset-0")
        .filter({ hasText: "Keep logs" })
        .first()
        .boundingBox();
      await redact(page);
      await page.screenshot({ path: shot("agent-delete-logs.png"), clip: overlay });
      await card.getByRole("button", { name: /^Cancel$/ }).click();
      await card.waitFor({ state: "hidden", timeout: 5000 });
    });

    // 3. Admin Settings → Log Storage card.
    await attempt("admin-log-storage.png", async () => {
      await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: "networkidle" });
      await settle(page);
      const card = page.locator("#log-storage");
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await capture(page, "admin-log-storage.png", card);
    });

    // 4. Admin log recovery page.
    await attempt("admin-log-recovery.png", async () => {
      await page.goto(`${BASE_URL}/admin/log-recovery`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: /Log recovery/ }).waitFor({ timeout: 15000 });
      await settle(page);
      await capture(page, "admin-log-recovery.png");
    });

    // 5. Workspace settings → Log retention.
    if (WORKSPACE_ID || USE_TEMP_WORKSPACE) {
      const headers = body?.token ? { Authorization: `Bearer ${body.token}` } : {};
      let workspaceId = WORKSPACE_ID;
      let tempWorkspaceId = "";
      await attempt("workspace-log-settings.png", async () => {
        if (!workspaceId) {
          const created = await context.request.post(`${BASE_URL}/api/workspaces`, {
            headers,
            data: { name: "Production agents" },
          });
          if (!created.ok()) throw new Error(`workspace create failed: HTTP ${created.status()}`);
          tempWorkspaceId = (await created.json()).id;
          workspaceId = tempWorkspaceId;
        }
        await page.goto(`${BASE_URL}/app/workspaces/${workspaceId}/settings`, {
          waitUntil: "networkidle",
        });
        await page.getByRole("heading", { name: "Log retention" }).waitFor({ timeout: 15000 });
        await settle(page, 1200);
        await capture(page, "workspace-log-settings.png");
      });
      if (tempWorkspaceId) {
        const removed = await context.request.delete(
          `${BASE_URL}/api/workspaces/${tempWorkspaceId}`,
          { headers, data: { deleteLogs: true } },
        );
        console.log(
          removed.ok()
            ? `Deleted temporary workspace ${tempWorkspaceId}`
            : `[logging-shots] could not delete temporary workspace ${tempWorkspaceId}: HTTP ${removed.status()}`,
        );
      }
    }

    console.log(`Captured ${captured.length} screenshot(s) to ${OUT_DIR}: ${captured.join(", ")}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
