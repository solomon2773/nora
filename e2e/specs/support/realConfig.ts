// Load real-credential test config from e2e/.env.real (or REAL_ENV_FILE) and
// expose helpers that let specs skip cleanly when a cred isn't supplied.

import fs from "node:fs";
import path from "node:path";

let loaded = false;

function loadEnvFile() {
  if (loaded) return;
  loaded = true;

  const envPath =
    process.env.REAL_ENV_FILE ||
    (fs.existsSync(path.resolve(process.cwd(), ".env.real"))
      ? path.resolve(process.cwd(), ".env.real")
      : path.resolve(process.cwd(), "e2e", ".env.real"));

  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value || !value.trim()) return null;
  return value.trim();
}

const llmProviderId = requireEnv("REAL_LLM_PROVIDER_ID") || "anthropic";
const nvidiaProviderId = "nvidia";

function providerMatchedLlmKey(providerId: string) {
  const generic = requireEnv("REAL_LLM_API_KEY");
  const normalized = providerId.toLowerCase();

  if (normalized.includes("anthropic") || normalized === "claude") {
    return requireEnv("REAL_ANTHROPIC_API_KEY") || generic;
  }

  if (normalized.includes("openai")) {
    return requireEnv("REAL_OPENAI_API_KEY") || generic;
  }

  if (normalized.includes("google") || normalized.includes("gemini")) {
    return requireEnv("REAL_GOOGLE_API_KEY") || generic;
  }

  if (normalized.includes("nvidia")) {
    return requireEnv("REAL_NVIDIA_API_KEY") || requireEnv("NVIDIA_API_KEY") || generic;
  }

  return (
    generic ||
    requireEnv("REAL_ANTHROPIC_API_KEY") ||
    requireEnv("REAL_OPENAI_API_KEY") ||
    requireEnv("REAL_GOOGLE_API_KEY")
  );
}

const real = {
  // LLM provider — at least one must be set.
  llmProviderId,
  llmApiKey: providerMatchedLlmKey(llmProviderId),
  llmModel: requireEnv("REAL_LLM_MODEL"),
  nvidiaProviderId,
  nvidiaApiKey: requireEnv("REAL_NVIDIA_API_KEY") || requireEnv("NVIDIA_API_KEY"),
  nvidiaModel: requireEnv("REAL_NVIDIA_MODEL") || "nvidia/nemotron-3-super-120b-a12b",

  // Integrations (any subset is fine — each spec skips when its cred is empty)
  githubToken: requireEnv("REAL_GITHUB_TOKEN"),
  slackToken: requireEnv("REAL_SLACK_TOKEN"),
  // Choose one URL-based integration to exercise the SSRF guard
  urlIntegrationProvider: requireEnv("REAL_URL_INTEGRATION_PROVIDER"), // grafana | jenkins | confluence
  urlIntegrationUrl: requireEnv("REAL_URL_INTEGRATION_URL"),
  urlIntegrationToken: requireEnv("REAL_URL_INTEGRATION_TOKEN"),
  urlIntegrationExtra: (() => {
    const raw = requireEnv("REAL_URL_INTEGRATION_CONFIG_JSON");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })(),

  // Channels
  telegramBotToken: requireEnv("REAL_TELEGRAM_BOT_TOKEN"),
  telegramChatId: requireEnv("REAL_TELEGRAM_CHAT_ID"),
  discordWebhookUrl: requireEnv("REAL_DISCORD_WEBHOOK_URL"),
  openclawDiscordConfig: (() => {
    const raw = requireEnv("REAL_OPENCLAW_DISCORD_CONFIG_JSON");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })(),

  // Enable/disable matrix cells explicitly
  enableOpenclawDocker: (requireEnv("REAL_ENABLE_OPENCLAW_DOCKER") || "1") !== "0",
  enableOpenclawK8s: (requireEnv("REAL_ENABLE_OPENCLAW_K8S") || "0") === "1",
  enableOpenclawNemoclaw: (requireEnv("REAL_ENABLE_OPENCLAW_NEMOCLAW") || "0") === "1",
  enableOpenclawNemoclawRemoteDocker:
    (requireEnv("REAL_ENABLE_OPENCLAW_NEMOCLAW_REMOTE_DOCKER") || "0") === "1",
  enableOpenclawNemoclawK8s: (requireEnv("REAL_ENABLE_OPENCLAW_NEMOCLAW_K8S") || "0") === "1",
  enableHermesDocker: (requireEnv("REAL_ENABLE_HERMES_DOCKER") || "0") === "1",
  enableHermesK8s: (requireEnv("REAL_ENABLE_HERMES_K8S") || "0") === "1",
  remoteDockerExecutionTargetId:
    requireEnv("REAL_REMOTE_DOCKER_EXECUTION_TARGET_ID") || "remote:real-smoke",
  k8sExecutionTargetId: requireEnv("REAL_K8S_EXECUTION_TARGET_ID"),

  // Timeouts (ms)
  provisionTimeoutMs: Number.parseInt(requireEnv("REAL_PROVISION_TIMEOUT_MS") || "600000", 10),
  chatTimeoutMs: Number.parseInt(requireEnv("REAL_CHAT_TIMEOUT_MS") || "120000", 10),
};

function skipUnless(
  test: { skip: (condition: boolean, description?: string) => void },
  predicate: () => boolean,
  reason: string,
) {
  test.skip(!predicate(), reason);
}

export { real, skipUnless, requireEnv };
