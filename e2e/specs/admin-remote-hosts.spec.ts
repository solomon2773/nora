import { expect, test, type Page, type Route } from "@playwright/test";

import { authenticatePage } from "./support/app";

type JsonRecord = Record<string, any>;

const ADMIN_USER = {
  id: "admin-remote-hosts",
  email: "admin.remote-hosts@example.com",
  name: "Remote Hosts Admin",
  role: "admin",
};

const DIRECT_USER = {
  id: "user-direct",
  email: "direct.user@example.com",
  name: "Direct User",
};

const USERS = [
  DIRECT_USER,
  { id: "user-other", email: "other.user@example.com", name: "Other User" },
];

const GROUPS = [{ id: "group-gpu", name: "GPU Operators", memberCount: 2 }];
const WORKSPACES = [{ id: "workspace-research", name: "Research Workspace" }];

const PERSONAL_HOST = {
  id: "personal-build-host",
  label: "Personal Build Host",
  executionTargetId: "remote:personal-build-host",
  managementScope: "user",
  ownerUserId: "personal-owner",
  ownerEmail: "personal.owner@example.com",
  ownerName: "Personal Owner",
  enabled: true,
  connected: true,
  configured: true,
  available: true,
  lastTestStatus: "ok",
  lastTestedAt: "2026-07-18T10:00:00.000Z",
  operationalMetadataRedacted: true,
};

type MockState = {
  platformHost: JsonRecord | null;
  accessVersion: number;
  access: {
    availableToAll: boolean;
    userIds: string[];
    groupIds: string[];
    workspaceIds: string[];
  };
  createPayload: JsonRecord | null;
  updatePayloads: JsonRecord[];
  accessPayloads: JsonRecord[];
  accessGets: number;
  forceAccessConflict: boolean;
  resetPayloads: JsonRecord[];
  testRequests: number;
  deleteAttempts: number;
  retiredHostIds: Set<string>;
  retiredCreateAttempts: number;
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

function expandedAccess(state: MockState) {
  return {
    version: state.accessVersion,
    availableToAll: state.access.availableToAll,
    users: USERS.filter((user) => state.access.userIds.includes(user.id)).map((user) => ({
      userId: user.id,
      email: user.email,
      name: user.name,
    })),
    groups: GROUPS.filter((group) => state.access.groupIds.includes(group.id)).map((group) => ({
      groupId: group.id,
      name: group.name,
    })),
    workspaces: WORKSPACES.filter((workspace) =>
      state.access.workspaceIds.includes(workspace.id),
    ).map((workspace) => ({
      workspaceId: workspace.id,
      name: workspace.name,
    })),
  };
}

async function installAdminRemoteHostMocks(page: Page) {
  const state: MockState = {
    platformHost: null,
    accessVersion: 1,
    access: {
      availableToAll: false,
      userIds: [],
      groupIds: [],
      workspaceIds: [],
    },
    createPayload: null,
    updatePayloads: [],
    accessPayloads: [],
    accessGets: 0,
    forceAccessConflict: false,
    resetPayloads: [],
    testRequests: 0,
    deleteAttempts: 0,
    retiredHostIds: new Set(),
    retiredCreateAttempts: 0,
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
        deploymentDefaults: { vcpu: 1, ram_mb: 1024, disk_gb: 10 },
      });
    }

    if (pathname === "/api/admin/users" && method === "GET") {
      return fulfillJson(route, 200, USERS);
    }

    if (pathname === "/api/admin/workspaces" && method === "GET") {
      return fulfillJson(route, 200, WORKSPACES);
    }

    if (pathname === "/api/admin/user-groups" && method === "GET") {
      return fulfillJson(route, 200, GROUPS);
    }

    if (pathname === "/api/admin/remote-hosts" && method === "GET") {
      return fulfillJson(
        route,
        200,
        state.platformHost
          ? [clone(state.platformHost), clone(PERSONAL_HOST)]
          : [clone(PERSONAL_HOST)],
      );
    }

    if (pathname === "/api/admin/remote-hosts" && method === "POST") {
      const payload = request.postDataJSON() as JsonRecord;
      state.createPayload = clone(payload);
      if (state.retiredHostIds.has(String(payload.id || ""))) {
        state.retiredCreateAttempts += 1;
        return fulfillJson(route, 409, {
          error: `Remote host id "${payload.id}" was permanently retired after deletion; choose a new id`,
          code: "REMOTE_HOST_ID_RETIRED",
        });
      }
      state.platformHost = {
        id: payload.id,
        label: payload.label,
        executionTargetId: `remote:${payload.id}`,
        managementScope: "platform",
        createdByUserId: ADMIN_USER.id,
        createdByEmail: ADMIN_USER.email,
        createdByName: ADMIN_USER.name,
        availableToAll: false,
        accessVersion: state.accessVersion,
        enabled: payload.enabled !== false,
        connected: false,
        configured: true,
        available: false,
        sshHost: payload.sshHost,
        sshPort: payload.sshPort,
        sshUser: payload.sshUser,
        sshAuthMode: payload.sshAuthMode,
        gatewayHost: payload.gatewayHost || payload.sshHost,
        hasSshPrivateKey: Boolean(payload.sshPrivateKey),
        hasSshPassword: Boolean(payload.sshPassword),
        hasSshPassphrase: Boolean(payload.sshPassphrase),
        sshHostKey: null,
        lastTestStatus: null,
        lastTestMessage: null,
        lastTestedAt: null,
        createdAt: "2026-07-18T11:00:00.000Z",
        updatedAt: "2026-07-18T11:00:00.000Z",
      };
      return fulfillJson(route, 201, clone(state.platformHost));
    }

    const hostMatch = pathname.match(
      /^\/api\/admin\/remote-hosts\/([^/]+)(?:\/(test|reset-host-key|access))?$/,
    );
    if (hostMatch) {
      const hostId = decodeURIComponent(hostMatch[1]);
      const action = hostMatch[2] || "detail";
      if (!state.platformHost || state.platformHost.id !== hostId) {
        return fulfillJson(route, 404, { error: "Remote host not found" });
      }

      if (action === "detail" && method === "GET") {
        return fulfillJson(route, 200, clone(state.platformHost));
      }

      if (action === "detail" && method === "PUT") {
        const payload = request.postDataJSON() as JsonRecord;
        state.updatePayloads.push(clone(payload));
        state.platformHost = {
          ...state.platformHost,
          ...payload,
          gatewayHost: payload.gatewayHost || payload.sshHost || state.platformHost.gatewayHost,
          hasSshPrivateKey:
            "sshPrivateKey" in payload
              ? Boolean(payload.sshPrivateKey)
              : state.platformHost.hasSshPrivateKey,
          hasSshPassword:
            "sshPassword" in payload
              ? Boolean(payload.sshPassword)
              : state.platformHost.hasSshPassword,
          hasSshPassphrase:
            "sshPassphrase" in payload
              ? Boolean(payload.sshPassphrase)
              : state.platformHost.hasSshPassphrase,
          updatedAt: "2026-07-18T11:05:00.000Z",
        };
        return fulfillJson(route, 200, clone(state.platformHost));
      }

      if (action === "test" && method === "POST") {
        state.testRequests += 1;
        state.platformHost = {
          ...state.platformHost,
          connected: true,
          available: true,
          sshHostKey: "SHA256:playwright-platform-host",
          lastTestStatus: "ok",
          lastTestMessage: "Docker is reachable over SSH.",
          lastTestedAt: "2026-07-18T11:10:00.000Z",
        };
        return fulfillJson(route, 200, clone(state.platformHost));
      }

      if (action === "reset-host-key" && method === "POST") {
        const payload = request.postDataJSON() as JsonRecord;
        state.resetPayloads.push(clone(payload));
        state.platformHost = {
          ...state.platformHost,
          connected: false,
          available: false,
          sshHostKey: null,
          lastTestStatus: null,
          lastTestMessage: null,
          lastTestedAt: null,
        };
        return fulfillJson(route, 200, clone(state.platformHost));
      }

      if (action === "access" && method === "GET") {
        state.accessGets += 1;
        return fulfillJson(route, 200, expandedAccess(state));
      }

      if (action === "access" && method === "PUT") {
        const payload = request.postDataJSON() as JsonRecord;
        state.accessPayloads.push(clone(payload));

        if (state.forceAccessConflict) {
          state.forceAccessConflict = false;
          state.accessVersion += 1;
          state.platformHost = {
            ...state.platformHost,
            accessVersion: state.accessVersion,
          };
          return fulfillJson(route, 409, {
            error: "Remote Host access changed in another admin session",
            code: "REMOTE_HOST_ACCESS_VERSION_CONFLICT",
            currentVersion: state.accessVersion,
          });
        }

        if (payload.expectedVersion !== state.accessVersion) {
          return fulfillJson(route, 409, {
            error: "Remote Host access changed in another admin session",
            code: "REMOTE_HOST_ACCESS_VERSION_CONFLICT",
            currentVersion: state.accessVersion,
          });
        }

        state.access = {
          availableToAll: payload.availableToAll === true,
          userIds: Array.isArray(payload.users) ? [...payload.users] : [],
          groupIds: Array.isArray(payload.groups) ? [...payload.groups] : [],
          workspaceIds: Array.isArray(payload.workspaces) ? [...payload.workspaces] : [],
        };
        state.accessVersion += 1;
        state.platformHost = {
          ...state.platformHost,
          availableToAll: state.access.availableToAll,
          accessVersion: state.accessVersion,
        };
        return fulfillJson(route, 200, expandedAccess(state));
      }

      if (action === "detail" && method === "DELETE") {
        state.deleteAttempts += 1;
        if (state.deleteAttempts === 1) {
          return fulfillJson(route, 409, {
            error: "Cannot delete a remote host while agents still reference it",
            code: "REMOTE_HOST_IN_USE",
          });
        }
        const deleted = clone(state.platformHost);
        state.retiredHostIds.add(String(state.platformHost.id));
        state.platformHost = null;
        return fulfillJson(route, 200, { success: true, host: deleted });
      }
    }

    return fulfillJson(route, 404, {
      error: `Unhandled Playwright API mock: ${method} ${pathname}`,
    });
  });

  return state;
}

function sectionForHeading(page: Page, name: string) {
  return page.getByRole("heading", { name, exact: true }).locator("xpath=ancestor::section[1]");
}

test("self-hosted platform admin manages Remote Hosts without exposing stored secrets", async ({
  page,
}) => {
  const state = await installAdminRemoteHostMocks(page);
  await authenticatePage(page, "admin-remote-hosts-token", "/admin/remote-hosts");

  await expect(page.getByRole("heading", { name: "Remote Hosts", exact: true })).toBeVisible();
  const personalRow = page.getByRole("row", { name: /Personal Build Host/i });
  await expect(personalRow).toContainText("Masked operator credential");
  await expect(personalRow).toContainText("Read only");
  await expect(personalRow.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Add platform host", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/remote-hosts\/new$/);
  await page.getByLabel("Host label", { exact: true }).fill("Platform Edge");
  await page.getByLabel(/^Platform host id/i).fill("platform-edge");
  await page.getByLabel(/^SSH host/i).fill("edge.internal");
  await page.getByLabel("SSH port", { exact: true }).fill("2222");
  await page.getByLabel("SSH username", { exact: true }).fill("nora");
  await page.getByLabel(/^Gateway host/i).fill("gateway.internal");
  await page
    .getByLabel(/^SSH private key/i)
    .fill(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nplaywright-fixture-only\n-----END OPENSSH PRIVATE KEY-----",
    );
  await page.getByLabel(/^Key passphrase/i).fill("fixture-passphrase");
  await page.getByRole("button", { name: "Create platform host", exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/remote-hosts\/platform-edge$/);
  await expect
    .poll(() => state.createPayload)
    .toMatchObject({
      id: "platform-edge",
      label: "Platform Edge",
      sshHost: "edge.internal",
      sshPort: 2222,
      sshUser: "nora",
      sshAuthMode: "key",
      gatewayHost: "gateway.internal",
    });

  // count() does not auto-wait. Guarding the click on it meant that if the tab
  // bar had not rendered yet — the previous step awaits an API response, not the
  // UI — the click was silently skipped and the assertions below ran against the
  // Overview tab, where "SSH private key" exists only as a paragraph and no form
  // field is present. That produced a confusing "element(s) not found" pointing
  // at the field rather than at the missed tab switch. The tab is rendered
  // unconditionally, so click() and let it auto-wait.
  const configTab = page.getByRole("button", { name: /host configuration|configuration/i });
  await configTab.first().click();
  await expect(page.getByLabel(/^SSH private key/i)).toHaveValue("");
  await expect(page.getByLabel(/^Key passphrase/i)).toHaveValue("");
  await expect(
    page.getByText(/leave blank to preserve the encrypted value/i).first(),
  ).toBeVisible();

  await page.getByLabel("Host label", { exact: true }).fill("Platform Edge Updated");
  await page.getByRole("button", { name: /save/i }).click();
  await expect.poll(() => state.updatePayloads.length).toBe(1);
  expect(state.updatePayloads[0]).not.toHaveProperty("sshPrivateKey");
  expect(state.updatePayloads[0]).not.toHaveProperty("sshPassphrase");
  expect(state.updatePayloads[0]).not.toHaveProperty("sshPassword");

  await page.getByRole("button", { name: "Platform access", exact: true }).click();
  const allAccounts = sectionForHeading(page, "Available to all accounts");
  await allAccounts.getByRole("checkbox").check();
  await expect.poll(() => state.accessPayloads.at(-1)?.availableToAll).toBe(true);
  await expect(allAccounts.getByRole("checkbox")).toBeChecked();
  await allAccounts.getByRole("checkbox").uncheck();
  await expect.poll(() => state.accessPayloads.at(-1)?.availableToAll).toBe(false);
  await expect(allAccounts.getByRole("checkbox")).not.toBeChecked();

  const directUserGrant = sectionForHeading(page, "Direct users").getByRole("checkbox", {
    name: /Direct User/i,
  });
  state.forceAccessConflict = true;
  const accessGetsBeforeConflict = state.accessGets;
  await directUserGrant.check();
  await expect.poll(() => state.accessPayloads.at(-1)?.expectedVersion).toBe(3);
  await expect.poll(() => state.accessGets).toBe(accessGetsBeforeConflict + 1);
  await expect(page.getByRole("main").getByRole("status")).toContainText(/changed|reload|stale/i);
  await expect(directUserGrant).not.toBeChecked();

  await directUserGrant.check();
  await expect(directUserGrant).toBeChecked();
  const groupGrant = sectionForHeading(page, "User groups").getByRole("checkbox", {
    name: /GPU Operators/i,
  });
  await groupGrant.check();
  await expect(groupGrant).toBeChecked();
  const workspaceGrant = sectionForHeading(page, "Workspaces").getByRole("checkbox", {
    name: /Research Workspace/i,
  });
  await workspaceGrant.check();
  await expect(workspaceGrant).toBeChecked();
  await expect
    .poll(() => state.accessPayloads.at(-1))
    .toMatchObject({
      expectedVersion: 6,
      availableToAll: false,
      users: [DIRECT_USER.id],
      groups: [GROUPS[0].id],
      workspaces: [WORKSPACES[0].id],
    });

  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect.poll(() => state.testRequests).toBe(1);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Reset SSH pin", exact: true }).click();
  const resetPanel = page
    .getByRole("heading", { name: "Reset the pinned SSH host key?", exact: true })
    .locator("xpath=ancestor::form[1]");
  const resetConfirmation = resetPanel.getByLabel(/type .* to confirm/i);
  await resetConfirmation.fill("wrong-host");
  await expect(
    resetPanel.getByRole("button", { name: "Confirm reset", exact: true }),
  ).toBeDisabled();
  await resetConfirmation.fill("platform-edge");
  await resetPanel.getByRole("button", { name: "Confirm reset", exact: true }).click();
  await expect.poll(() => state.resetPayloads.at(-1)).toEqual({ confirmation: "platform-edge" });
  await expect(page.getByText("Untested", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete host", exact: true }).click();
  const deletePanel = page
    .getByRole("heading", { name: "Delete this platform host?", exact: true })
    .locator("xpath=ancestor::form[1]");
  const deleteConfirmation = deletePanel.getByLabel(/type .* to confirm/i);
  await deleteConfirmation.fill("platform-edge");
  await deletePanel.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /agents still reference it/i,
  );
  await expect.poll(() => state.deleteAttempts).toBe(1);

  await deletePanel.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/remote-hosts$/);
  await expect.poll(() => state.deleteAttempts).toBe(2);
  await expect(page.getByRole("row", { name: /Personal Build Host/i })).toContainText("Read only");

  await page.getByRole("link", { name: "Add platform host", exact: true }).click();
  await page.getByLabel("Host label", { exact: true }).fill("Replacement Edge");
  await page.getByLabel(/^Platform host id/i).fill("platform-edge");
  await page.getByLabel(/^SSH host/i).fill("replacement.internal");
  await page.getByLabel("SSH username", { exact: true }).fill("nora");
  await page
    .getByLabel(/^SSH private key/i)
    .fill(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nreplacement-fixture-only\n-----END OPENSSH PRIVATE KEY-----",
    );
  await page.getByRole("button", { name: "Create platform host", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /permanently retired.*choose a new id/i,
  );
  await expect.poll(() => state.retiredCreateAttempts).toBe(1);
});
