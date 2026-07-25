import { expect, test, type Page, type Route } from "@playwright/test";

import { authenticatePage } from "./support/app";

type JsonRecord = Record<string, any>;

const ADMIN_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin.user-groups@example.com",
  name: "User Groups Admin",
  role: "admin",
};

const DIRECTORY_USERS = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    email: "alice@example.com",
    name: "Alice Operator",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    email: "bob@example.com",
    name: "Bob Operator",
  },
];

const CREATED_GROUP_ID = "20000000-0000-4000-8000-000000000001";

type MockGroup = {
  id: string;
  name: string;
  memberCount: number;
  membersVersion: number;
};

type MockState = {
  groups: MockGroup[];
  memberIds: string[];
  memberVersion: number;
  createPayloads: JsonRecord[];
  renamePayloads: JsonRecord[];
  memberPayloads: JsonRecord[];
  memberGets: number;
  deleteRequests: number;
  forceMemberConflict: boolean;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fulfillJson(route: Route, status: number, payload: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

function memberSnapshot(state: MockState) {
  return {
    version: state.memberVersion,
    members: DIRECTORY_USERS.filter((user) => state.memberIds.includes(user.id)).map((user) => ({
      userId: user.id,
      email: user.email,
      name: user.name,
    })),
  };
}

async function installUserGroupMocks(page: Page) {
  const state: MockState = {
    groups: [],
    memberIds: [],
    memberVersion: 1,
    createPayloads: [],
    renamePayloads: [],
    memberPayloads: [],
    memberGets: 0,
    deleteRequests: 0,
    forceMemberConflict: false,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/auth/me") {
      return fulfillJson(route, 200, ADMIN_USER);
    }

    if (pathname === "/api/config/platform") {
      return fulfillJson(route, 200, {
        mode: "selfhosted",
        systemBanner: null,
        release: null,
      });
    }

    if (pathname === "/api/admin/users" && method === "GET") {
      return fulfillJson(route, 200, DIRECTORY_USERS);
    }

    if (pathname === "/api/admin/user-groups" && method === "GET") {
      return fulfillJson(route, 200, clone(state.groups));
    }

    if (pathname === "/api/admin/user-groups" && method === "POST") {
      const payload = request.postDataJSON() as JsonRecord;
      state.createPayloads.push(clone(payload));
      const group: MockGroup = {
        id: CREATED_GROUP_ID,
        name: String(payload.name || ""),
        memberCount: 0,
        membersVersion: state.memberVersion,
      };
      state.groups = [group];
      return fulfillJson(route, 201, clone(group));
    }

    const groupMatch = pathname.match(/^\/api\/admin\/user-groups\/([^/]+)(?:\/(members))?$/);
    if (groupMatch) {
      const groupId = decodeURIComponent(groupMatch[1]);
      const action = groupMatch[2] || "detail";
      const group = state.groups.find((entry) => entry.id === groupId);
      if (!group) return fulfillJson(route, 404, { error: "User group not found" });

      if (action === "detail" && method === "PUT") {
        const payload = request.postDataJSON() as JsonRecord;
        state.renamePayloads.push(clone(payload));
        group.name = String(payload.name || group.name);
        return fulfillJson(route, 200, clone(group));
      }

      if (action === "detail" && method === "DELETE") {
        state.deleteRequests += 1;
        state.groups = state.groups.filter((entry) => entry.id !== groupId);
        return fulfillJson(route, 200, { success: true, group: clone(group) });
      }

      if (action === "members" && method === "GET") {
        state.memberGets += 1;
        return fulfillJson(route, 200, memberSnapshot(state));
      }

      if (action === "members" && method === "PUT") {
        const payload = request.postDataJSON() as JsonRecord;
        state.memberPayloads.push(clone(payload));

        if (state.forceMemberConflict) {
          state.forceMemberConflict = false;
          state.memberVersion += 1;
          state.memberIds = [DIRECTORY_USERS[1].id];
          group.memberCount = state.memberIds.length;
          group.membersVersion = state.memberVersion;
          return fulfillJson(route, 409, {
            error: "User group membership changed in another admin session",
            code: "USER_GROUP_MEMBERS_VERSION_CONFLICT",
            currentVersion: state.memberVersion,
          });
        }

        if (payload.expectedVersion !== state.memberVersion) {
          return fulfillJson(route, 409, {
            error: "User group membership changed in another admin session",
            code: "USER_GROUP_MEMBERS_VERSION_CONFLICT",
            currentVersion: state.memberVersion,
          });
        }

        state.memberIds = Array.isArray(payload.users) ? [...payload.users] : [];
        state.memberVersion += 1;
        group.memberCount = state.memberIds.length;
        group.membersVersion = state.memberVersion;
        return fulfillJson(route, 200, memberSnapshot(state));
      }
    }

    return fulfillJson(route, 404, {
      error: `Unhandled Playwright API mock: ${method} ${pathname}`,
    });
  });

  return state;
}

function groupCard(page: Page, name: string) {
  return page.getByRole("heading", { name, exact: true }).locator("xpath=ancestor::article[1]");
}

test("platform admin manages versioned user-group membership atomically", async ({ page }) => {
  const state = await installUserGroupMocks(page);
  await authenticatePage(page, "admin-user-groups-token", "/admin/user-groups");

  await expect(page.getByRole("heading", { name: "User groups", exact: true })).toBeVisible();
  await expect(page.getByText("No user groups exist yet.", { exact: true })).toBeVisible();

  await page.getByLabel("Group name", { exact: true }).fill("Platform Engineering");
  await page.getByRole("button", { name: "Create user group", exact: true }).click();
  await expect.poll(() => state.createPayloads.at(-1)).toEqual({ name: "Platform Engineering" });

  let card = groupCard(page, "Platform Engineering");
  await expect(card).toContainText("0 members");
  await card.getByRole("button", { name: "Rename", exact: true }).click();
  await page
    .getByLabel("Group name for Platform Engineering", { exact: true })
    .fill("Edge Operators");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect.poll(() => state.renamePayloads.at(-1)).toEqual({ name: "Edge Operators" });

  card = groupCard(page, "Edge Operators");
  expect(state.memberGets).toBe(0);
  await card.getByRole("button", { name: "Manage members", exact: true }).click();
  await expect.poll(() => state.memberGets).toBe(1);

  const alice = card.getByRole("checkbox", { name: /Alice Operator/i });
  const bob = card.getByRole("checkbox", { name: /Bob Operator/i });
  await expect(alice).not.toBeChecked();
  await expect(bob).not.toBeChecked();
  await alice.check();
  await bob.check();
  await card.getByRole("button", { name: "Save members", exact: true }).click();

  await expect
    .poll(() => state.memberPayloads.at(-1))
    .toEqual({
      expectedVersion: 1,
      users: [DIRECTORY_USERS[0].id, DIRECTORY_USERS[1].id],
    });
  await expect(card).toContainText("2 members");
  await expect(alice).toBeChecked();
  await expect(bob).toBeChecked();

  await bob.uncheck();
  state.forceMemberConflict = true;
  const memberGetsBeforeConflict = state.memberGets;
  await card.getByRole("button", { name: "Save members", exact: true }).click();

  await expect.poll(() => state.memberPayloads.at(-1)?.expectedVersion).toBe(2);
  await expect.poll(() => state.memberGets).toBe(memberGetsBeforeConflict + 1);
  await expect(card.getByRole("status")).toContainText(/changed|reload|stale/i);
  await expect(alice).not.toBeChecked();
  await expect(bob).toBeChecked();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Edge Operators");
    await dialog.accept();
  });
  await card.getByRole("button", { name: "Delete group", exact: true }).click();
  await expect.poll(() => state.deleteRequests).toBe(1);
  await expect(page.getByRole("heading", { name: "Edge Operators", exact: true })).toHaveCount(0);
});
