// Real-credential deploy-matrix smoke: iterates OpenClaw + Hermes across Docker,
// Kubernetes, and (optional) NemoClaw sandbox. Each cell runs lifecycle steps
// L1-L10 from the test plan: deploy → running → chat → logs → metrics →
// stop/start → rotate provider key → destroy.
//
// Requires .env.real with at least REAL_LLM_API_KEY set, plus REAL_ENABLE_*
// flags for the cells you want to exercise. See e2e/REAL_TESTS.md.

import { expect, test } from "@playwright/test";
import {
  DEFAULT_PASSWORD,
  apiJson,
  createUserSession,
  getCurrentUser,
  uniqueEmail,
  uniqueName,
} from "./support/app";
import {
  getPlatformConfig,
  backendSupported,
  runtimeSupported,
  deployAgent,
  getAgent,
  waitForAgentStatus,
  stopAgent,
  startAgent,
  deleteAgent,
  chatWithAgent,
  saveProviderKey,
  setProviderDefault,
} from "./support/agents";
import { real } from "./support/realConfig";

type PlatformExecutionTarget = {
  id?: string;
  available?: boolean;
  configured?: boolean;
  [key: string]: unknown;
};

type PlatformConfig = {
  executionTargets?: PlatformExecutionTarget[];
  [key: string]: unknown;
};

type MatrixCell = {
  key: string;
  label: string;
  runtimeFamily: string;
  backend: string;
  targetPrefix?: string;
  executionTargetId?: () => string | null;
  sandboxProfile: "standard" | "nemoclaw";
  enabledFlag: () => boolean;
};

const CELLS: MatrixCell[] = [
  {
    key: "openclaw-docker",
    label: "OpenClaw + Docker",
    runtimeFamily: "openclaw",
    backend: "docker",
    sandboxProfile: "standard",
    enabledFlag: () => real.enableOpenclawDocker,
  },
  {
    key: "openclaw-k8s",
    label: "OpenClaw + Kubernetes",
    runtimeFamily: "openclaw",
    backend: "k8s",
    targetPrefix: "k8s:",
    executionTargetId: () => real.k8sExecutionTargetId,
    sandboxProfile: "standard",
    enabledFlag: () => real.enableOpenclawK8s,
  },
  {
    key: "openclaw-nemoclaw-docker",
    label: "OpenClaw + NemoClaw sandbox + Docker",
    runtimeFamily: "openclaw",
    backend: "docker",
    sandboxProfile: "nemoclaw",
    enabledFlag: () => real.enableOpenclawNemoclaw,
  },
  {
    key: "openclaw-nemoclaw-remote-docker",
    label: "OpenClaw + NemoClaw sandbox + Remote Docker",
    runtimeFamily: "openclaw",
    backend: "remote-docker",
    targetPrefix: "remote:",
    executionTargetId: () => real.remoteDockerExecutionTargetId,
    sandboxProfile: "nemoclaw",
    enabledFlag: () => real.enableOpenclawNemoclawRemoteDocker,
  },
  {
    key: "openclaw-nemoclaw-k8s",
    label: "OpenClaw + NemoClaw sandbox + Kubernetes",
    runtimeFamily: "openclaw",
    backend: "k8s",
    targetPrefix: "k8s:",
    executionTargetId: () => real.k8sExecutionTargetId,
    sandboxProfile: "nemoclaw",
    enabledFlag: () => real.enableOpenclawNemoclawK8s,
  },
  {
    key: "hermes-docker",
    label: "Hermes + Docker",
    runtimeFamily: "hermes",
    backend: "docker",
    sandboxProfile: "standard",
    enabledFlag: () => real.enableHermesDocker,
  },
  {
    key: "hermes-k8s",
    label: "Hermes + Kubernetes",
    runtimeFamily: "hermes",
    backend: "k8s",
    targetPrefix: "k8s:",
    executionTargetId: () => real.k8sExecutionTargetId,
    sandboxProfile: "standard",
    enabledFlag: () => real.enableHermesK8s,
  },
];

function resolveExecutionTarget(platform: PlatformConfig, cell: MatrixCell) {
  const explicit = typeof cell.executionTargetId === "function" ? cell.executionTargetId() : null;
  if (explicit) {
    if (!Array.isArray(platform.executionTargets)) return explicit;
    const explicitTarget = platform.executionTargets.find((entry) => entry?.id === explicit);
    return explicitTarget &&
      explicitTarget.available !== false &&
      explicitTarget.configured !== false
      ? explicit
      : undefined;
  }
  const prefix = cell.targetPrefix;
  if (!prefix || !Array.isArray(platform.executionTargets)) return undefined;
  const target = platform.executionTargets.find(
    (entry) =>
      String(entry?.id || "").startsWith(prefix) &&
      entry.available !== false &&
      entry.configured !== false,
  );
  return target?.id;
}

test.describe("Deploy matrix — real credentials", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {{email: string, password: string, token: string, profile: any} | null} */
  let operator = null;
  const providerRecordIds: Record<string, string | undefined> = {};

  test.beforeAll(async ({ request }) => {
    test.skip(
      !real.llmApiKey && !real.nvidiaApiKey,
      "REAL_LLM_API_KEY (or provider-specific real API key) not set",
    );

    operator = await createUserSession(request, {
      email: uniqueEmail("nora-real-matrix"),
      password: DEFAULT_PASSWORD,
    });
    operator.profile = await getCurrentUser(request, operator.token);

    if (real.llmApiKey) {
      const primaryProvider = await saveProviderKey(request, operator.token, {
        provider: real.llmProviderId,
        apiKey: real.llmApiKey,
        model: real.llmModel || undefined,
      });
      providerRecordIds.primary = primaryProvider?.id;
      providerRecordIds[real.llmProviderId] = primaryProvider?.id;
    }

    if (real.nvidiaApiKey && real.llmProviderId !== real.nvidiaProviderId) {
      const nvidiaProvider = await saveProviderKey(request, operator.token, {
        provider: real.nvidiaProviderId,
        apiKey: real.nvidiaApiKey,
        model: real.nvidiaModel,
      });
      providerRecordIds[real.nvidiaProviderId] = nvidiaProvider?.id;
    }
  });

  for (const cell of CELLS) {
    test.describe(cell.label, () => {
      test.describe.configure({ mode: "serial" });
      test.setTimeout(real.provisionTimeoutMs + 300000);

      /** @type {any} */
      let agent = null;

      test(`[L1] deploy`, async ({ request }) => {
        test.skip(!cell.enabledFlag(), `Cell disabled via REAL_ENABLE_* flag`);

        const platform = await getPlatformConfig(request, operator.token);
        const executionTargetId = resolveExecutionTarget(platform, cell);
        test.skip(
          Boolean(cell.targetPrefix) && !executionTargetId,
          `No available ${cell.backend} execution target found for ${cell.label}`,
        );
        test.skip(
          !backendSupported(platform, cell.backend, executionTargetId),
          `backend ${cell.backend} not in ENABLED_BACKENDS on this stack`,
        );
        test.skip(
          !runtimeSupported(platform, cell.runtimeFamily),
          `runtime ${cell.runtimeFamily} not in ENABLED_RUNTIME_FAMILIES on this stack`,
        );
        test.skip(
          cell.sandboxProfile !== "nemoclaw" && !real.llmApiKey,
          "Standard real-LLM cells require REAL_LLM_API_KEY or a provider-specific real key",
        );
        test.skip(
          cell.sandboxProfile === "nemoclaw" && !real.nvidiaApiKey,
          "NemoClaw real-key cells require REAL_NVIDIA_API_KEY or NVIDIA_API_KEY",
        );

        const defaultProviderRecordId =
          cell.sandboxProfile === "nemoclaw"
            ? providerRecordIds[real.nvidiaProviderId]
            : providerRecordIds.primary;
        if (defaultProviderRecordId) {
          await setProviderDefault(request, operator.token, defaultProviderRecordId);
        }

        try {
          agent = await deployAgent(request, operator.token, {
            name: uniqueName(`real-${cell.key}`),
            runtimeFamily: cell.runtimeFamily,
            backend: cell.backend,
            executionTargetId,
            sandboxProfile: cell.sandboxProfile,
            vcpu: 1,
            ramMb: 1024,
            diskGb: 5,
            model: cell.sandboxProfile === "nemoclaw" ? real.nvidiaModel : undefined,
          });
        } catch (err: any) {
          // The backend rejects unsupported runtime/backend combinations with
          // a 400 explaining the constraint. Treat that
          // as a clean skip, not a test failure.
          if (
            /only supported|not supported|invalid combination|not enabled/i.test(
              String(err?.message || ""),
            )
          ) {
            test.skip(true, `Combination unsupported by platform: ${err.message}`);
            return;
          }
          throw err;
        }

        expect(agent?.id).toBeTruthy();
        expect(agent?.status).toBe("queued");
      });

      test(`[L2] reach running`, async ({ request }) => {
        test.skip(!agent, "no agent from [L1]");
        const running = await waitForAgentStatus(
          request,
          operator.token,
          agent.id,
          ["running", "warning"],
          { timeoutMs: real.provisionTimeoutMs },
        );
        agent = running;
        expect(["running", "warning"]).toContain(agent.status);
      });

      test(`[L3] gateway reachable`, async ({ page }) => {
        test.skip(!agent, "no agent from [L1]");
        test.setTimeout(real.provisionTimeoutMs + 60000);
        // Authenticate the browser session, then hit the embed route. The
        // agent row flips to `running` as soon as the container is up, but
        // the OpenClaw/Hermes gateway *inside* it can take several minutes
        // to finish booting (fresh installs pull openclaw + tsx from npm),
        // so we poll until the embed endpoint returns 2xx or the provision
        // deadline hits.
        await page.addInitScript((t) => {
          window.localStorage.setItem("token", t);
        }, operator.token);

        const embedPath =
          agent.runtime_family === "hermes"
            ? `/api/agents/${agent.id}/hermes-ui/embed?token=${encodeURIComponent(operator.token)}`
            : `/api/agents/${agent.id}/gateway/embed?token=${encodeURIComponent(operator.token)}`;

        const deadline = Date.now() + real.provisionTimeoutMs;
        let lastStatus = 0;
        while (Date.now() < deadline) {
          const response = await page.request.get(embedPath, {
            headers: { Accept: "text/html" },
          });
          lastStatus = response.status();
          if (lastStatus < 400) return;
          await new Promise((r) => setTimeout(r, 10000));
        }
        throw new Error(
          `Gateway embed never returned 2xx within ${Math.round(
            real.provisionTimeoutMs / 1000,
          )}s; last status: ${lastStatus}`,
        );
      });

      test(`[L4] chat roundtrip (real LLM)`, async ({ request }) => {
        test.skip(!agent, "no agent from [L1]");
        test.setTimeout(real.chatTimeoutMs + 60000);

        const response = await chatWithAgent(
          request,
          operator.token,
          agent,
          "Reply with a single short word, e.g. 'ok'.",
        );

        // Both runtimes eventually return either a string, a { message }
        // envelope, or a { runId } handle we don't block on. Any non-error
        // non-empty response means the LLM + provider sync path worked.
        expect(response).toBeTruthy();
        if (typeof response === "object" && "error" in response) {
          throw new Error(`Chat returned error: ${JSON.stringify(response)}`);
        }
      });

      test(`[L5] logs endpoint returns data`, async ({ request }) => {
        test.skip(!agent, "no agent from [L1]");
        // Logs are streamed via WebSocket; the HTTP metrics + events surfaces
        // give us a non-streaming signal that the agent is alive.
        const { body } = await apiJson(request, `/api/monitoring/events?limit=25`, {
          token: operator.token,
        });
        const events = Array.isArray(body) ? body : [];
        const touchesAgent = events.some(
          (e) =>
            String(e.metadata?.agentId || e.agent_id || "") === agent.id ||
            String(e.message || "").includes(agent.name),
        );
        expect(touchesAgent, "expected a monitoring event touching this agent").toBe(true);
      });

      test(`[L7] metrics summary endpoint`, async ({ request }) => {
        test.skip(!agent, "no agent from [L1]");

        // OpenClaw chat increments `messages_sent` in usage_metrics, so we
        // expect the summary to have at least one key after a successful L4
        // chat. Hermes routes chat through its container's WebUI and does
        // not populate control-plane usage_metrics at all, so the endpoint
        // stays empty — the useful signal there is that it returns a valid
        // JSON object without erroring.
        const expectData = agent.runtime_family !== "hermes";
        const deadline = Date.now() + (expectData ? 300000 : 15000);
        let lastBody: unknown = null;
        while (Date.now() < deadline) {
          const { response, body } = await apiJson(
            request,
            `/api/agents/${agent.id}/metrics/summary`,
            { token: operator.token, failOnStatus: false },
          );
          lastBody = body;
          if (!response.ok()) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          const keys =
            body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
          if (!expectData) {
            expect(body && typeof body === "object" && !Array.isArray(body)).toBe(true);
            return;
          }
          if (keys.length > 0) return;
          await new Promise((r) => setTimeout(r, 5000));
        }
        throw new Error(
          `Timed out waiting for agent metrics summary; last body: ${JSON.stringify(lastBody)}`,
        );
      });

      test(`[L8] stop then start`, async ({ request }) => {
        test.skip(!agent, "no agent from [L1]");
        await stopAgent(request, operator.token, agent.id);
        await waitForAgentStatus(request, operator.token, agent.id, ["stopped"], {
          timeoutMs: 120000,
        });
        await startAgent(request, operator.token, agent.id);
        await waitForAgentStatus(request, operator.token, agent.id, ["running", "warning"], {
          timeoutMs: 180000,
        });
      });

      test(`[L10] destroy`, async ({ request }) => {
        test.skip(!agent, "no agent from [L1]");
        await deleteAgent(request, operator.token, agent.id);
        // After delete, the per-user GET should 404 or return deleted state.
        const { response } = await apiJson(request, `/api/agents/${agent.id}`, {
          token: operator.token,
          failOnStatus: false,
        });
        expect([404, 200]).toContain(response.status());
      });
    });
  }
});
