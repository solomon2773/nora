import { expect, test } from "@playwright/test";
import {
  DEMO_ADMIN_EMAIL,
  DEFAULT_PASSWORD,
  apiJson,
  assertJsonRecord,
  ensureUserSession,
  extractIdFromUrl,
  uniqueEmail,
} from "./support/app";
import { deleteAgent, listProviders, waitForAgentStatus } from "./support/agents";

type AgentRecord = Record<string, unknown> & {
  id: string;
  name?: string;
  status?: string;
};

test.describe("Built-in demo activation", () => {
  test("signup launches one reusable worker-backed demo and completes first chat", async ({
    page,
    context,
  }) => {
    test.setTimeout(15 * 60 * 1000);

    const browserRequest = context.request;
    await ensureUserSession(browserRequest, {
      email: DEMO_ADMIN_EMAIL,
      password: DEFAULT_PASSWORD,
    });
    const operatorEmail = uniqueEmail(`nora-demo-browser-r${test.info().retry}`);
    let agentId = "";

    try {
      // Keep the chat send as the first request that reaches the runtime
      // gateway. The agent page and chat panel probe sessions/status as they
      // render; abort those browser-side so they cannot hide a worker that
      // reports `running` before its post-deploy restart has settled.
      await page.route(/\/api\/agents\/[^/]+\/gateway\/(?!chat(?:[/?#]|$))/, async (route) =>
        route.abort(),
      );

      await page.goto("/signup?intent=demo");
      await page.getByLabel(/email address/i).fill(operatorEmail);
      await page.getByLabel(/^password$/i).fill(DEFAULT_PASSWORD);
      await page.getByRole("button", { name: /create account/i }).click();

      await page.waitForURL(/\/app\/(?:[a-z]{2}\/)?getting-started$/, { timeout: 30_000 });
      const authCookie = (await context.cookies()).find((cookie) => cookie.name === "nora_auth");
      expect(authCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
      expect(await page.evaluate(() => localStorage.getItem("token"))).toBeNull();

      const launchDemo = page.getByRole("button", {
        name: "Launch local Docker demo — no API key",
      });
      await expect(launchDemo).toBeEnabled();
      await launchDemo.click();
      await page.waitForURL(/\/app\/(?:[a-z]{2}\/)?agents\/[^/?#]+$/, { timeout: 60_000 });
      agentId = extractIdFromUrl(page.url(), "/agents/");

      const { body: retryBody } = await apiJson<AgentRecord>(
        browserRequest,
        "/api/agents/activate-demo",
        { method: "POST", data: {} },
      );
      const retry = assertJsonRecord<AgentRecord>(retryBody, "/api/agents/activate-demo retry");
      expect(retry.id).toBe(agentId);

      const { body: ownedBody } = await apiJson<AgentRecord[]>(
        browserRequest,
        "/api/agents?scope=owned",
      );
      const ownedAgents = Array.isArray(ownedBody) ? ownedBody : [];
      expect(ownedAgents.filter((agent) => agent.name === "Demo Agent")).toEqual([
        expect.objectContaining({ id: agentId }),
      ]);

      const providers = await listProviders(browserRequest, "");
      expect(providers.filter((provider) => provider?.provider === "demo")).toHaveLength(1);

      const runningAgent = await waitForAgentStatus(browserRequest, "", agentId, "running", {
        timeoutMs: 10 * 60 * 1000,
        intervalMs: 1000,
      });
      expect(runningAgent.status).toBe("running");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Demo Agent" })).toBeVisible();
      await expect(page.getByText("running", { exact: true }).first()).toBeVisible();

      await page.getByRole("button", { name: "OpenClaw", exact: true }).last().click();
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const chatInput = page.getByPlaceholder("Type a message...");
      await expect(chatInput).toBeVisible();

      const prompt = `demo activation browser e2e ${Date.now()}`;
      await chatInput.fill(prompt);
      await chatInput.press("Enter");

      await expect(page.getByText(prompt, { exact: true })).toBeVisible();
      // The demo persona intro ("Hi! I'm Nora's demo agent…") prefixes BOTH the
      // welcome message and every reply, so asserting it directly is ambiguous —
      // strict mode matches 2 elements (one hidden) whenever the welcome bubble
      // has rendered, which is a timing race. Wait on the reply's unique echo of
      // this run's prompt instead; it appears only in the response bubble.
      await expect(page.getByText(`You said: "${prompt}"`)).toBeVisible({ timeout: 120_000 });
      await expect(
        page.getByText(
          /This response is generated locally by your Nora control plane \(deterministic, zero cost\)\./,
        ),
      ).toBeVisible();
    } finally {
      if (agentId) {
        await deleteAgent(browserRequest, "", agentId);
      }
    }
  });
});
