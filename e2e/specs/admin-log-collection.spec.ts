import { expect, test, type Page, type Route } from "@playwright/test";

import { authenticatePage } from "./support/app";

// Admin dashboard: Settings -> Log Collection, the "not decided yet" banner, and
// the operator Logs page notice. API calls are mocked, so these run without
// agents or collected logs; they check what the UI asks and what it sends.

type JsonRecord = Record<string, any>;

const ADMIN_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin.log-collection@example.com",
  name: "Log Collection Admin",
  role: "admin",
};

const NO_LOGS = {
  segments: 0,
  lines: 0,
  bytes: 0,
  agents: 0,
  spans: 0,
  oldest: null,
  newest: null,
};
const SOME_LOGS = {
  segments: 12,
  lines: 3400,
  bytes: 98765,
  agents: 3,
  spans: 0,
  oldest: "2026-09-01T00:00:00.000Z",
  newest: "2026-10-01T00:00:00.000Z",
};

type MockState = {
  enabled: boolean;
  decided: boolean;
  stats: JsonRecord;
  putBodies: JsonRecord[];
  /** When set, PUT answers with this instead of applying the change. */
  rejectWith: { status: number; body: JsonRecord } | null;
};

function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    enabled: false,
    decided: false,
    stats: NO_LOGS,
    putBodies: [],
    rejectWith: null,
    ...overrides,
  };
}

async function fulfillJson(route: Route, status: number, payload: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function view(state: MockState) {
  return {
    enabled: state.enabled,
    decided: state.decided,
    source: state.decided ? "database" : "default",
    envValue: null,
    stats: state.stats,
    purge: null,
    encryptionKeyProblem: null,
  };
}

async function mockApi(page: Page, state: MockState) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/auth/me") return fulfillJson(route, 200, ADMIN_USER);
    if (pathname === "/api/config/platform") {
      return fulfillJson(route, 200, { mode: "selfhosted", release: null, systemBanner: null });
    }
    if (pathname === "/api/logs/collection-status") {
      return fulfillJson(route, 200, { enabled: state.enabled, decided: state.decided });
    }
    if (pathname === "/api/admin/log-collection" && method === "GET") {
      return fulfillJson(route, 200, view(state));
    }
    if (pathname === "/api/admin/log-collection" && method === "PUT") {
      const body = request.postDataJSON() as JsonRecord;
      state.putBodies.push(body);
      if (state.rejectWith)
        return fulfillJson(route, state.rejectWith.status, state.rejectWith.body);
      // Same rule as the server: turning off while logs exist needs an explicit choice.
      if (
        body.enabled === false &&
        state.stats.segments > 0 &&
        typeof body.deleteExisting !== "boolean"
      ) {
        return fulfillJson(route, 400, {
          code: "delete_existing_required",
          error: "choose keep or delete",
          stats: state.stats,
        });
      }
      state.enabled = body.enabled;
      state.decided = true;
      if (body.enabled === false && body.deleteExisting === true) state.stats = NO_LOGS;
      return fulfillJson(route, 200, view(state));
    }

    return fulfillJson(route, 404, { error: `Unmocked ${method} ${pathname}` });
  });
}

const card = (page: Page) => page.locator("#log-collection");

test.describe("admin Log Collection", () => {
  test("not decided yet: the banner and card say it is off, and turning it on sends enabled:true", async ({
    page,
  }) => {
    const state = newState();
    await mockApi(page, state);
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await expect(page.getByText("Log collection is off.")).toBeVisible();
    await expect(card(page).getByText("Not decided yet")).toBeVisible();

    await card(page).getByRole("button", { name: "Turn on log collection" }).click();

    await expect(card(page).getByText("Collecting")).toBeVisible();
    expect(state.putBodies).toEqual([{ enabled: true }]);
    await expect(card(page).getByRole("button", { name: "Turn off log collection" })).toBeVisible();
  });

  test("the banner can be dismissed", async ({ page }) => {
    await mockApi(page, newState());
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await expect(page.getByText("Log collection is off.")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).first().click();
    await expect(page.getByText("Log collection is off.")).toBeHidden();
  });

  test("no banner once someone has decided", async ({ page }) => {
    await mockApi(page, newState({ enabled: true, decided: true }));
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await expect(card(page).getByText("Collecting")).toBeVisible();
    await expect(page.getByText("Log collection is off.")).toBeHidden();
  });

  test("turning off with collected logs asks keep or delete; Cancel changes nothing", async ({
    page,
  }) => {
    const state = newState({ enabled: true, decided: true, stats: SOME_LOGS });
    await mockApi(page, state);
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await card(page).getByRole("button", { name: "Turn off log collection" }).click();

    await expect(
      card(page).getByText("What should happen to the logs already collected?"),
    ).toBeVisible();
    await expect(
      card(page)
        .getByText(/3,400 lines/)
        .first(),
    ).toBeVisible();
    await expect(
      card(page).getByText(/cannot be undone, and backups do not contain them/),
    ).toBeVisible();

    await card(page).getByRole("button", { name: "Cancel" }).click();

    expect(state.putBodies).toEqual([]);
    await expect(card(page).getByRole("button", { name: "Turn off log collection" })).toBeVisible();
  });

  test("Keep existing logs sends deleteExisting:false", async ({ page }) => {
    const state = newState({ enabled: true, decided: true, stats: SOME_LOGS });
    await mockApi(page, state);
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await card(page).getByRole("button", { name: "Turn off log collection" }).click();
    await card(page).getByRole("button", { name: "Keep existing logs" }).click();

    await expect(card(page).getByRole("button", { name: "Turn on log collection" })).toBeVisible();
    expect(state.putBodies).toEqual([{ enabled: false, deleteExisting: false }]);
    await expect(card(page).getByText("Collected so far")).toBeVisible();
  });

  test("Delete all logs needs a second confirmation before it sends deleteExisting:true", async ({
    page,
  }) => {
    const state = newState({ enabled: true, decided: true, stats: SOME_LOGS });
    await mockApi(page, state);
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await card(page).getByRole("button", { name: "Turn off log collection" }).click();
    await card(page).getByRole("button", { name: "Delete all logs" }).click();

    // First click only arms it.
    expect(state.putBodies).toEqual([]);
    await card(page).getByRole("button", { name: "Confirm: delete all logs" }).click();

    await expect(card(page).getByRole("button", { name: "Turn on log collection" })).toBeVisible();
    expect(state.putBodies).toEqual([{ enabled: false, deleteExisting: true }]);
    await expect(card(page).getByText("Collected so far")).toBeHidden();
  });

  test("turning off when nothing has been collected does not ask", async ({ page }) => {
    const state = newState({ enabled: true, decided: true, stats: NO_LOGS });
    await mockApi(page, state);
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await card(page).getByRole("button", { name: "Turn off log collection" }).click();

    await expect(card(page).getByRole("button", { name: "Turn on log collection" })).toBeVisible();
    expect(state.putBodies).toEqual([{ enabled: false }]);
  });

  test("a refused request shows the server's reason and leaves collection off", async ({
    page,
  }) => {
    const state = newState({
      rejectWith: {
        status: 409,
        body: {
          code: "local_unsupported_with_k8s",
          error: "Local log storage cannot be used while Kubernetes is an enabled deploy target.",
        },
      },
    });
    await mockApi(page, state);
    await authenticatePage(page, "admin-log-collection-token", "/admin/settings");

    await card(page).getByRole("button", { name: "Turn on log collection" }).click();

    await expect(page.getByText("Local log storage cannot be used while Kubernetes")).toBeVisible();
    await expect(card(page).getByRole("button", { name: "Turn on log collection" })).toBeVisible();
  });
});

test.describe("operator Logs page notice", () => {
  test("Agent Logs says collection is off and links to the admin card with an absolute URL", async ({
    page,
  }) => {
    await mockApi(page, newState({ enabled: false, decided: true }));
    await authenticatePage(page, "operator-log-collection-token", "/app/logs");

    await page.getByRole("button", { name: "Agent Logs" }).click();

    const notice = page.getByRole("status").filter({ hasText: "Log collection is off" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("earlier stay searchable");

    // The app's link localizer would turn a relative /admin link into /app/admin;
    // an absolute URL must reach the admin app unchanged.
    const link = notice.getByRole("link", { name: /Log Collection/ });
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/admin\/settings#log-collection$/,
    );
  });

  test("no notice while collection is on", async ({ page }) => {
    await mockApi(page, newState({ enabled: true, decided: true }));
    await authenticatePage(page, "operator-log-collection-token", "/app/logs");

    await page.getByRole("button", { name: "Agent Logs" }).click();
    // Wait for the Agent Logs view itself, so "no notice" is not just "not loaded yet".
    await expect(page.getByText("Select an agent above to view its runtime logs.")).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Log collection is off" }),
    ).toBeHidden();
  });
});
