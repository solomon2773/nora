import { expect, test } from "@playwright/test";
import {
  DEMO_ADMIN_EMAIL,
  DEFAULT_PASSWORD,
  apiJson,
  assertJsonRecord,
  ensureUserSession,
  isJsonRecord,
} from "./support/app";
import { deleteAgent, listProviders, waitForAgentStatus } from "./support/agents";

type AgentRecord = Record<string, unknown> & {
  id: string;
  name?: string;
  status?: string;
};

function messageText(payload: Record<string, unknown>) {
  const message = isJsonRecord(payload.message) ? payload.message : null;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return isJsonRecord(part) && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function finalAssistantText(rawSse: string) {
  let latest = "";

  for (const line of rawSse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isJsonRecord(payload)) continue;

    const message = isJsonRecord(payload.message) ? payload.message : null;
    if (message?.role === "user" || message?.role === "human") continue;
    if (payload.state !== "delta" && payload.state !== "final") continue;

    const text = messageText(payload);
    if (text) latest = text;
  }

  return latest;
}

test.describe("Built-in demo activation", () => {
  test("a retry reuses one provider and one worker-backed agent that can chat", async ({
    request,
  }) => {
    test.setTimeout(15 * 60 * 1000);

    const operator = await ensureUserSession(request, {
      email: DEMO_ADMIN_EMAIL,
      password: DEFAULT_PASSWORD,
    });
    let agentId = "";

    try {
      const activate = async () => {
        const { body } = await apiJson<AgentRecord>(request, "/api/agents/activate-demo", {
          method: "POST",
          token: operator.token,
          data: {},
        });
        const agent = assertJsonRecord<AgentRecord>(body, "/api/agents/activate-demo");
        expect(agent.id).toBeTruthy();
        return agent;
      };

      const first = await activate();
      agentId = first.id;
      const retry = await activate();

      expect(retry.id).toBe(first.id);

      const { body: ownedBody } = await apiJson<AgentRecord[]>(request, "/api/agents?scope=owned", {
        token: operator.token,
      });
      const ownedAgents = Array.isArray(ownedBody) ? ownedBody : [];
      expect(ownedAgents.filter((agent) => agent.name === "Demo Agent")).toEqual([
        expect.objectContaining({ id: first.id }),
      ]);

      const providers = await listProviders(request, operator.token);
      expect(providers.filter((provider) => provider?.provider === "demo")).toHaveLength(1);

      const runningAgent = await waitForAgentStatus(request, operator.token, agentId, "running", {
        timeoutMs: 10 * 60 * 1000,
        intervalMs: 1000,
      });
      expect(runningAgent.status).toBe("running");

      // This must be the first gateway request after the control plane publishes
      // final readiness. Do not warm the connection with /gateway/status or retry
      // chat here: either would mask a worker that marks the agent running before
      // its post-deploy auth reconciliation restart has settled.
      const prompt = `demo activation e2e ${Date.now()}`;
      const { response: chatResponse, body: chatBody } = await apiJson<unknown>(
        request,
        `/api/agents/${agentId}/gateway/chat`,
        {
          method: "POST",
          token: operator.token,
          data: { message: prompt, stream: true },
          failOnStatus: false,
        },
      );
      const rawChatBody =
        typeof chatBody === "string" ? chatBody : JSON.stringify(chatBody ?? null);
      expect(chatResponse.status(), `First chat response:\n${rawChatBody}`).toBe(200);
      expect(typeof chatBody).toBe("string");
      const reply = finalAssistantText(rawChatBody);
      expect(reply, `Raw gateway SSE:\n${rawChatBody}`).toContain(
        "Hi! I'm Nora's demo agent, running on a built-in stub model — no API key required.",
      );
      // OpenClaw prepends sender metadata and a timestamp before the user text;
      // assert the unique prompt survives that protocol envelope instead of
      // coupling this worker-backed smoke to OpenClaw's presentation wrapper.
      expect(reply).toContain(prompt);
      expect(reply).toContain(
        "This response is generated locally by your Nora control plane (deterministic, zero cost).",
      );
    } finally {
      if (agentId) {
        await deleteAgent(request, operator.token, agentId);
      }
    }
  });
});
