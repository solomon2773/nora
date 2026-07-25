// @ts-nocheck
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");
const {
  buildOpenClawAuthProfilesWriteCommand,
  buildOpenClawConfigMergeScript,
  buildOpenClawConfigMergeCommand,
  buildOpenClawManagedCustomProvidersCommand,
  buildOpenClawManagedConfigEnvPruneCommand,
  buildOpenClawManagedDefaultModelCommand,
  buildMcpServersConfig,
  buildOpenClawCustomProviders,
  buildOpenClawInstallCommand,
  buildRuntimeBootstrapCommand,
  buildTemplatePayloadBootstrapFiles,
  mapNoraProviderIdToOpenClaw,
  buildOpenClawModelForProvider,
  FOUNDRY_OPENCLAW_PROVIDER_ID,
  resolveFoundryDeployment,
} = require("../../workers/provisioner/runtimeBootstrap");
const {
  DEFAULT_OPENCLAW_PACKAGE_SPEC,
  DEFAULT_OPENCLAW_VERSION,
} = require("../../agent-runtime/lib/openclawDefaults");
const DockerBackend = require("../../workers/provisioner/backends/docker");
const tar = require(
  require.resolve("tar-stream", {
    paths: [
      path.resolve(__dirname, "../../workers/provisioner"),
      path.resolve(__dirname, ".."),
      path.resolve(__dirname, "../.."),
    ],
  }),
);

async function extractTarEntries(archiveBuffer) {
  const extract = tar.extract();
  const entries = [];

  const done = new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        entries.push({
          name: header.name,
          type: header.type,
          mode: header.mode,
          content: Buffer.concat(chunks).toString("utf8"),
        });
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);
  });

  extract.end(archiveBuffer);
  return done;
}

function seedOpenClawAuthDatabase(agentDir, store, state) {
  fs.mkdirSync(agentDir, { recursive: true });
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES ('primary', ?, ?)",
      )
      .run(JSON.stringify(store), Date.now());
    if (state) {
      database
        .prepare(
          "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?)",
        )
        .run(JSON.stringify(state), Date.now());
    }
  } finally {
    database.close();
  }
}

function readOpenClawAuthDatabase(agentDir) {
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const storeRow = database
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
      .get();
    const stateRow = database
      .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = 'primary'")
      .get();
    return {
      store: storeRow ? JSON.parse(storeRow.store_json) : null,
      state: stateRow ? JSON.parse(stateRow.state_json) : null,
    };
  } finally {
    database.close();
  }
}

describe("OpenClaw bootstrap helpers", () => {
  it("copies the runtime contracts alongside the agent server bundle", () => {
    const cmd = buildRuntimeBootstrapCommand();

    expect(cmd).toContain("/opt/openclaw-runtime/lib/contracts.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/containerCommand.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/openclawDefaults.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/server.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/execEndpoint.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/agent.ts");
  });

  it("verifies the OpenClaw CLI can execute before skipping installation", () => {
    const cmd = buildOpenClawInstallCommand();

    expect(cmd).toContain('OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"');
    expect(cmd).toContain('OPENCLAW_TSX_BIN="${OPENCLAW_TSX_BIN:-/usr/local/bin/tsx}"');
    expect(cmd).toContain('DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"');
    expect(cmd).toContain('DETECTED_OPENCLAW_TSX_BIN="$(command -v tsx 2>/dev/null || true)"');
    expect(cmd).toContain('[ -x "$OPENCLAW_BIN" ]');
    expect(cmd).toContain(`EXPECTED_OPENCLAW_VERSION='${DEFAULT_OPENCLAW_VERSION}'`);
    expect(cmd).toContain("OPENCLAW_VERSION_OK=1");
    expect(cmd).toContain('"$OPENCLAW_TSX_BIN" --version >/dev/null 2>&1');
    expect(cmd).toContain("npm uninstall -g openclaw tsx >/dev/null 2>&1 || true");
    expect(cmd).toContain(
      `npm install -g ${DEFAULT_OPENCLAW_PACKAGE_SPEC} tsx@4.21.0 >/tmp/openclaw-install.log 2>&1`,
    );
    expect(cmd).toContain("Installed OpenClaw version does not match");
    expect(cmd).toContain("hash -r 2>/dev/null || true");
    expect(cmd).toContain('export OPENCLAW_CLI_PATH="$OPENCLAW_BIN"');
    expect(cmd).toContain('export OPENCLAW_TSX_BIN="$OPENCLAW_TSX_BIN"');
  });

  it("imports API-key auth profiles into OpenClaw's per-agent store", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-auth-"));
    try {
      const fakeOpenClaw = path.join(tmpDir, "openclaw");
      const argsLog = path.join(tmpDir, "args.log");
      const stdinLog = path.join(tmpDir, "stdin.log");
      fs.writeFileSync(
        fakeOpenClaw,
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OPENCLAW_ARGS_LOG"\ncat >> "$OPENCLAW_STDIN_LOG"\n',
        { mode: 0o755 },
      );

      const command = buildOpenClawAuthProfilesWriteCommand(
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "sk-openai" },
            "microsoft-foundry:default": {
              type: "api_key",
              provider: "microsoft-foundry",
              key: "ms-key",
            },
          },
        },
        { authPath: path.join(tmpDir, "auth-profiles.json") },
      );
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLI_PATH: fakeOpenClaw,
          OPENCLAW_ARGS_LOG: argsLog,
          OPENCLAW_STDIN_LOG: stdinLog,
        },
      });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(argsLog, "utf8")).toContain(
        "models auth --agent main paste-api-key --provider openai --profile-id openai:default",
      );
      // Custom providers are imported under their OpenClaw id — the embedded
      // agent resolves auth from the per-agent SQLite store only, so skipping
      // Foundry here left agents failing with missing-provider-auth.
      expect(fs.readFileSync(argsLog, "utf8")).toContain(
        "models auth --agent main paste-api-key --provider azure-openai-responses --profile-id azure-openai-responses:default",
      );
      expect(fs.readFileSync(argsLog, "utf8")).not.toContain("microsoft-foundry");
      expect(fs.readFileSync(stdinLog, "utf8")).toBe("sk-openai\nms-key\n");
      const writtenAuth = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "auth-profiles.json"), "utf8"),
      );
      expect(writtenAuth.profiles).toEqual({
        "openai:default": { type: "api_key", provider: "openai", key: "sk-openai" },
        "azure-openai-responses:default": {
          type: "api_key",
          provider: "azure-openai-responses",
          key: "ms-key",
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps builtin-provider imports when a custom-provider paste fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-auth-"));
    try {
      const fakeOpenClaw = path.join(tmpDir, "openclaw");
      const argsLog = path.join(tmpDir, "args.log");
      // Fail only the azure-openai-responses paste (provider not registered),
      // as happens when a Foundry key is saved without a base URL.
      fs.writeFileSync(
        fakeOpenClaw,
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OPENCLAW_ARGS_LOG"\ncat > /dev/null\ncase "$*" in *azure-openai-responses*) exit 1 ;; esac\n',
        { mode: 0o755 },
      );

      const command = buildOpenClawAuthProfilesWriteCommand(
        {
          version: 1,
          profiles: {
            "microsoft-foundry:default": {
              type: "api_key",
              provider: "microsoft-foundry",
              key: "ms-key",
            },
            "openai:default": { type: "api_key", provider: "openai", key: "sk-openai" },
          },
        },
        { authPath: path.join(tmpDir, "auth-profiles.json") },
      );
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLI_PATH: fakeOpenClaw,
          OPENCLAW_ARGS_LOG: argsLog,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("auth import skipped for azure-openai-responses");
      expect(fs.readFileSync(argsLog, "utf8")).toContain(
        "models auth --agent main paste-api-key --provider openai --profile-id openai:default",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses normalized auth-profiles.json when pinned OpenClaw lacks paste-api-key", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-auth-compat-"));
    try {
      const fakeOpenClaw = path.join(tmpDir, "openclaw");
      const argsLog = path.join(tmpDir, "args.log");
      fs.writeFileSync(
        fakeOpenClaw,
        `#!/bin/sh
printf '%s\n' "$*" >> "$OPENCLAW_ARGS_LOG"
cat > /dev/null
case " $* " in
  *" paste-api-key "*)
    echo "error: unknown option '--provider'" >&2
    exit 1
    ;;
esac
exit 2
`,
        { mode: 0o755 },
      );

      const command = buildOpenClawAuthProfilesWriteCommand(
        {
          version: 1,
          profiles: {
            "demo:default": { type: "api_key", provider: "demo", key: "demo-key" },
          },
          order: { demo: ["demo:default"] },
          lastGood: { demo: "demo:default" },
        },
        { authPath: path.join(tmpDir, "auth-profiles.json") },
      );
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLI_PATH: fakeOpenClaw,
          OPENCLAW_ARGS_LOG: argsLog,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("auth CLI import unavailable for nora-demo");
      const calls = fs.readFileSync(argsLog, "utf8");
      expect(calls).toContain(
        "models auth --agent main paste-api-key --provider nora-demo --profile-id nora-demo:default",
      );
      expect(calls).not.toContain("paste-token");
      expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "auth-profiles.json"), "utf8"))).toEqual({
        version: 1,
        profiles: {
          "nora-demo:default": {
            type: "api_key",
            provider: "nora-demo",
            key: "demo-key",
          },
        },
        order: { "nora-demo": ["nora-demo:default"] },
        lastGood: { "nora-demo": "nora-demo:default" },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reconciles Nora-owned SQLite auth profiles exactly while preserving manual profiles", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-auth-exact-"));
    try {
      const authPath = path.join(tmpDir, "auth-profiles.json");
      const fakeOpenClaw = path.join(tmpDir, "openclaw");
      fs.writeFileSync(
        fakeOpenClaw,
        `#!/bin/sh
cat > /dev/null
echo "error: unknown option '--provider'" >&2
exit 1
`,
        { mode: 0o755 },
      );
      seedOpenClawAuthDatabase(
        tmpDir,
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "stale-openai" },
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "stale-anthropic",
            },
            "microsoft-foundry:default": {
              type: "api_key",
              provider: "microsoft-foundry",
              key: "stale-foundry",
            },
            "openai:manual": { type: "api_key", provider: "openai", key: "manual-openai" },
            "manual-provider:default": {
              type: "api_key",
              provider: "manual-provider",
              key: "manual-provider-key",
            },
          },
          order: {
            openai: ["openai:manual", "openai:default"],
            anthropic: ["anthropic:default"],
            "microsoft-foundry": ["microsoft-foundry:default"],
            "manual-provider": ["manual-provider:default"],
          },
          lastGood: {
            openai: "openai:default",
            anthropic: "anthropic:default",
            "microsoft-foundry": "microsoft-foundry:default",
            "manual-provider": "manual-provider:default",
          },
          usageStats: {
            "openai:default": { lastUsed: 1 },
            "openai:manual": { lastUsed: 2 },
            "anthropic:default": { lastUsed: 3 },
            "microsoft-foundry:default": { lastUsed: 4 },
          },
          extensionState: { keep: true },
        },
        {
          version: 1,
          order: {
            openai: ["openai:manual", "openai:default"],
            anthropic: ["anthropic:default"],
            "microsoft-foundry": ["microsoft-foundry:default"],
            "manual-provider": ["manual-provider:default"],
          },
          lastGood: {
            openai: "openai:manual",
            anthropic: "anthropic:default",
            "microsoft-foundry": "microsoft-foundry:default",
            "manual-provider": "manual-provider:default",
          },
          usageStats: {
            "openai:default": { lastUsed: 4 },
            "openai:manual": { lastUsed: 5 },
            "anthropic:default": { lastUsed: 6 },
            "microsoft-foundry:default": { lastUsed: 7 },
          },
          extensionState: { keep: true },
        },
      );

      const command = buildOpenClawAuthProfilesWriteCommand(
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "current-openai" },
          },
          order: { openai: ["openai:default"] },
          lastGood: { openai: "openai:default" },
        },
        {
          authPath,
          managedProfileIds: [
            "openai:default",
            "anthropic:default",
            "azure-openai-responses:default",
          ],
        },
      );
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_CLI_PATH: fakeOpenClaw },
      });

      expect(result.status).toBe(0);
      const { store, state } = readOpenClawAuthDatabase(tmpDir);
      expect(store.profiles).toEqual({
        "openai:default": { type: "api_key", provider: "openai", key: "current-openai" },
        "openai:manual": { type: "api_key", provider: "openai", key: "manual-openai" },
        "manual-provider:default": {
          type: "api_key",
          provider: "manual-provider",
          key: "manual-provider-key",
        },
      });
      expect(store.order).toEqual({
        openai: ["openai:manual"],
        "manual-provider": ["manual-provider:default"],
      });
      expect(store.lastGood).toEqual({ "manual-provider": "manual-provider:default" });
      expect(store.usageStats).toEqual({ "openai:manual": { lastUsed: 2 } });
      expect(store.extensionState).toEqual({ keep: true });
      expect(state).toEqual({
        version: 1,
        order: {
          openai: ["openai:default", "openai:manual"],
          "manual-provider": ["manual-provider:default"],
        },
        lastGood: {
          openai: "openai:manual",
          "manual-provider": "manual-provider:default",
        },
        usageStats: { "openai:manual": { lastUsed: 5 } },
        extensionState: { keep: true },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes the final Nora-managed SQLite profile when desired auth is empty", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-auth-empty-"));
    try {
      const authPath = path.join(tmpDir, "auth-profiles.json");
      seedOpenClawAuthDatabase(
        tmpDir,
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "stale-openai" },
            "openai:manual": { type: "api_key", provider: "openai", key: "manual-openai" },
          },
        },
        {
          version: 1,
          order: { openai: ["openai:default", "openai:manual"] },
          lastGood: { openai: "openai:default" },
          usageStats: {
            "openai:default": { lastUsed: 1 },
            "openai:manual": { lastUsed: 2 },
          },
        },
      );

      const command = buildOpenClawAuthProfilesWriteCommand(
        { version: 1, profiles: {} },
        { authPath, managedProfileIds: ["openai:default"] },
      );
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_CLI_PATH: path.join(tmpDir, "missing-openclaw") },
      });

      expect(result.status).toBe(0);
      expect(readOpenClawAuthDatabase(tmpDir)).toEqual({
        store: {
          version: 1,
          profiles: {
            "openai:manual": { type: "api_key", provider: "openai", key: "manual-openai" },
          },
        },
        state: {
          version: 1,
          order: { openai: ["openai:manual"] },
          usageStats: { "openai:manual": { lastUsed: 2 } },
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reconciles only Nora-managed custom providers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-providers-"));
    try {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { bind: "lan" },
          models: {
            mode: "merge",
            providers: {
              "azure-openai-responses": { api: "stale-foundry" },
              "nora-demo": { api: "stale-demo" },
              "manual-provider": { api: "manual", apiKey: "manual-key" },
            },
          },
        }),
      );

      const command = buildOpenClawManagedCustomProvidersCommand(
        {
          "azure-openai-responses": {
            api: "azure-openai-responses",
            baseUrl: "https://example.openai.azure.com/openai/v1",
          },
        },
        { configPath },
      );
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        gateway: { bind: "lan" },
        models: {
          mode: "merge",
          providers: {
            "azure-openai-responses": {
              api: "azure-openai-responses",
              baseUrl: "https://example.openai.azure.com/openai/v1",
            },
            "manual-provider": { api: "manual", apiKey: "manual-key" },
          },
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prunes stopped-runtime credential names from persisted OpenClaw config env", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-config-env-"));
    try {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { bind: "lan" },
          env: {
            OLD_PROVIDER_API_KEY: "provider-secret",
            OLD_INTEGRATION_TOKEN: "integration-secret",
            OPERATOR_SETTING: "preserve-me",
          },
        }),
      );
      const stateEnvName = "NORA_K8S_MANAGED_ENV_B64";
      const managedState = Buffer.from(
        JSON.stringify({ managedNames: ["OLD_INTEGRATION_TOKEN"], values: {} }),
        "utf8",
      ).toString("base64");
      const command = buildOpenClawManagedConfigEnvPruneCommand(["OLD_PROVIDER_API_KEY"], {
        configPath,
        managedStateEnvName: stateEnvName,
      });
      const result = require("child_process").spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, [stateEnvName]: managedState },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        gateway: { bind: "lan" },
        env: { OPERATOR_SETTING: "preserve-me" },
      });
      expect(command).toContain("__NORA_PRUNE_MANAGED_OPENCLAW_CONFIG_ENV__");
      expect(command).not.toContain("provider-secret");
      expect(command).not.toContain("integration-secret");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves unmarked defaults and clears only marker-owned Nora defaults", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nora-openclaw-default-model-"));
    try {
      const configPath = path.join(tmpDir, "openclaw.json");
      const markerPath = path.join(tmpDir, ".nora-managed-default-model");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { bind: "lan" },
          agents: {
            defaults: {
              model: {
                primary: "azure-openai-responses/stale-deployment",
                fallbacks: ["manual-provider/manual-model"],
              },
              models: {
                "azure-openai-responses/stale-deployment": { alias: "stale" },
                "manual-provider/manual-model": { alias: "manual" },
              },
              workspace: "/root/.openclaw/workspace",
            },
          },
        }),
      );
      const managedProviderIds = ["azure-openai-responses", "nora-demo"];

      const clearLegacy = buildOpenClawManagedDefaultModelCommand("", {
        configPath,
        markerPath,
        managedProviderIds,
      });
      let result = require("child_process").spawnSync("/bin/sh", ["-c", clearLegacy], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      let config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.agents.defaults.model).toEqual({
        primary: "azure-openai-responses/stale-deployment",
        fallbacks: ["manual-provider/manual-model"],
      });
      expect(config.agents.defaults.models).toEqual({
        "azure-openai-responses/stale-deployment": { alias: "stale" },
        "manual-provider/manual-model": { alias: "manual" },
      });
      expect(config.agents.defaults.workspace).toBe("/root/.openclaw/workspace");
      expect(config.gateway).toEqual({ bind: "lan" });

      const setManaged = buildOpenClawManagedDefaultModelCommand("nora-demo/nora-demo-1", {
        configPath,
        markerPath,
        managedProviderIds,
      });
      result = require("child_process").spawnSync("/bin/sh", ["-c", setManaged], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.agents.defaults.model.primary).toBe("nora-demo/nora-demo-1");
      expect(config.agents.defaults.models).toEqual({
        "azure-openai-responses/stale-deployment": { alias: "stale" },
        "manual-provider/manual-model": { alias: "manual" },
        "nora-demo/nora-demo-1": {},
      });
      expect(fs.readFileSync(markerPath, "utf8")).toBe("nora-demo/nora-demo-1\n");

      const clearManaged = buildOpenClawManagedDefaultModelCommand(null, {
        configPath,
        markerPath,
        managedProviderIds,
      });
      result = require("child_process").spawnSync("/bin/sh", ["-c", clearManaged], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.agents.defaults.model).toEqual({
        fallbacks: ["manual-provider/manual-model"],
      });
      expect(config.agents.defaults.models).toEqual({
        "azure-openai-responses/stale-deployment": { alias: "stale" },
        "manual-provider/manual-model": { alias: "manual" },
      });
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disables Bonjour in managed runtime environments by default", () => {
    const previous = process.env.OPENCLAW_DISABLE_BONJOUR;
    delete process.env.OPENCLAW_DISABLE_BONJOUR;
    jest.resetModules();
    try {
      const runtimeBootstrap = require("../../agent-runtime/lib/runtimeBootstrap");

      expect(runtimeBootstrap.buildRuntimeEnv()).toEqual(
        expect.objectContaining({
          OPENCLAW_DISABLE_BONJOUR: "1",
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DISABLE_BONJOUR;
      } else {
        process.env.OPENCLAW_DISABLE_BONJOUR = previous;
      }
    }
  });

  it("lets host-level runtime env explicitly force Bonjour back on", () => {
    const previous = process.env.OPENCLAW_DISABLE_BONJOUR;
    jest.resetModules();
    process.env.OPENCLAW_DISABLE_BONJOUR = "0";
    try {
      const runtimeBootstrap = require("../../agent-runtime/lib/runtimeBootstrap");

      expect(runtimeBootstrap.buildRuntimeEnv()).toEqual(
        expect.objectContaining({
          OPENCLAW_DISABLE_BONJOUR: "0",
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DISABLE_BONJOUR;
      } else {
        process.env.OPENCLAW_DISABLE_BONJOUR = previous;
      }
    }
  });

  it("mirrors template files into both the workspace root and the legacy agent root", () => {
    const files = buildTemplatePayloadBootstrapFiles({
      files: [{ path: "AGENTS.md", content: "# Agent\n" }],
      memoryFiles: [],
    });

    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "root/.openclaw/workspace/AGENTS.md",
        }),
        expect.objectContaining({
          name: "root/.openclaw/agents/main/agent/AGENTS.md",
        }),
      ]),
    );
  });

  it("seeds Nora integration pointers before the gateway starts", () => {
    const files = buildTemplatePayloadBootstrapFiles({
      files: [{ path: "TOOLS.md", content: "## Tools\n\n- Existing tool note.\n" }],
      memoryFiles: [],
    });
    const workspaceTools = files.find((file) => file.name === "root/.openclaw/workspace/TOOLS.md");
    const agentTools = files.find(
      (file) => file.name === "root/.openclaw/agents/main/agent/TOOLS.md",
    );
    const skill = files.find(
      (file) => file.name === "root/.openclaw/workspace/skills/nora-integrations/SKILL.md",
    );

    expect(files.map((file) => file.name)).toEqual(
      expect.arrayContaining([
        "root/.openclaw/workspace/integrations/integrations.json",
        "root/.openclaw/workspace/integrations/NORA_INTEGRATIONS.md",
        "root/.openclaw/workspace/skills/nora-integrations/SKILL.md",
      ]),
    );
    expect(workspaceTools.content.toString("utf8")).toContain("NORA_INTEGRATIONS_BEGIN");
    expect(agentTools.content.toString("utf8")).toContain("NORA_INTEGRATIONS_BEGIN");
    expect(skill.content.toString("utf8")).toContain("name: nora-integrations");
  });

  describe("buildOpenClawCustomProviders", () => {
    it("returns no providers when MICROSOFT_FOUNDRY_API_KEY is missing", () => {
      expect(buildOpenClawCustomProviders({})).toEqual({});
      expect(
        buildOpenClawCustomProviders({
          MICROSOFT_FOUNDRY_BASE_URL: "https://r.openai.azure.com/openai/v1/",
        }),
      ).toEqual({});
    });

    it("returns no providers when MICROSOFT_FOUNDRY_BASE_URL is missing", () => {
      // No catalog default for Foundry — without baseUrl, skip registration so
      // failures surface as "Unknown model" (clearer than a silent 401 against
      // the wrong endpoint).
      expect(buildOpenClawCustomProviders({ MICROSOFT_FOUNDRY_API_KEY: "ms-key" })).toEqual({});
    });

    it("registers Foundry to route through pi-ai's azure-openai-responses API", () => {
      // pi-ai (the inference SDK OpenClaw uses) ships a dedicated
      // `azure-openai-responses` API that wraps the AzureOpenAI npm client.
      // That client natively sends the `api-key` header Azure requires, so
      // we don't need the authHeader:false + manual headers["api-key"]
      // workaround the Microsoft community blog showed.
      //
      // Critical checks:
      // - Provider id key is `azure-openai-responses`
      // - api is `azure-openai-responses` (routes to streamAzureOpenAIResponses)
      // - baseUrl is preserved (works for both `.openai.azure.com` and
      //   `.cognitiveservices.azure.com` Foundry endpoints)
      // - apiKey is the decrypted value (AzureOpenAI consumes it directly)
      // - Each model has `compat.supportsStore: false` so OpenClaw strips
      //   `store: true` from the Responses payload (Azure rejects it).
      const result = buildOpenClawCustomProviders({
        MICROSOFT_FOUNDRY_API_KEY: "ms-key",
        MICROSOFT_FOUNDRY_BASE_URL: "https://st-eastus2.cognitiveservices.azure.com/openai/v1/",
      });
      expect(Object.keys(result)).toEqual(["azure-openai-responses"]);
      const foundry = result["azure-openai-responses"];
      expect(foundry).toEqual(
        expect.objectContaining({
          api: "azure-openai-responses",
          baseUrl: "https://st-eastus2.cognitiveservices.azure.com/openai/v1",
          apiKey: "ms-key",
        }),
      );
      // Should NOT include the obsolete workaround fields.
      expect(foundry).not.toHaveProperty("authHeader");
      expect(foundry).not.toHaveProperty("headers");
      expect(Array.isArray(foundry.models)).toBe(true);
      expect(foundry.models.length).toBeGreaterThan(0);
      for (const model of foundry.models) {
        expect(model.api).toBe("azure-openai-responses");
        expect(model.compat).toEqual(expect.objectContaining({ supportsStore: false }));
      }
    });

    it("adds the saved Foundry deployment name as an OpenClaw model", () => {
      const result = buildOpenClawCustomProviders({
        MICROSOFT_FOUNDRY_API_KEY: "ms-key",
        MICROSOFT_FOUNDRY_BASE_URL: "https://st-eastus2.openai.azure.com/openai/v1/",
        MICROSOFT_FOUNDRY_DEPLOYMENT: "gpt-5.5-1",
      });

      expect(result["azure-openai-responses"].models[0]).toEqual(
        expect.objectContaining({
          id: "gpt-5.5-1",
          name: "gpt-5.5-1 (Azure deployment)",
          api: "azure-openai-responses",
        }),
      );
    });
  });

  describe("mapNoraProviderIdToOpenClaw", () => {
    it("translates microsoft-foundry to azure-openai-responses", () => {
      expect(mapNoraProviderIdToOpenClaw("microsoft-foundry")).toBe("azure-openai-responses");
      expect(FOUNDRY_OPENCLAW_PROVIDER_ID).toBe("azure-openai-responses");
    });

    it("passes other provider ids through unchanged", () => {
      expect(mapNoraProviderIdToOpenClaw("anthropic")).toBe("anthropic");
      expect(mapNoraProviderIdToOpenClaw("openai")).toBe("openai");
      expect(mapNoraProviderIdToOpenClaw("nvidia")).toBe("nvidia");
    });

    it("handles missing input safely", () => {
      expect(mapNoraProviderIdToOpenClaw(undefined)).toBe(undefined);
      expect(mapNoraProviderIdToOpenClaw(null)).toBe(null);
      expect(mapNoraProviderIdToOpenClaw("")).toBe("");
    });
  });

  describe("buildOpenClawModelForProvider", () => {
    it("rewrites prefixed Foundry deployment strings to OpenClaw's Azure provider id", () => {
      expect(buildOpenClawModelForProvider("microsoft-foundry", "gpt-5.5-1")).toBe(
        "azure-openai-responses/gpt-5.5-1",
      );
      expect(buildOpenClawModelForProvider("microsoft-foundry", "openai/gpt-5.5-1")).toBe(
        "azure-openai-responses/gpt-5.5-1",
      );
      expect(
        buildOpenClawModelForProvider("microsoft-foundry", "microsoft-foundry/gpt-5.5-1"),
      ).toBe("azure-openai-responses/gpt-5.5-1");
      expect(
        buildOpenClawModelForProvider("microsoft-foundry", "azure-openai-responses/gpt-5.5-1"),
      ).toBe("azure-openai-responses/gpt-5.5-1");
    });

    it("preserves normal prefixed models for non-Foundry providers", () => {
      expect(buildOpenClawModelForProvider("openai", "openai/gpt-5.5-1")).toBe("openai/gpt-5.5-1");
      expect(buildOpenClawModelForProvider("anthropic", "claude-sonnet-4-5")).toBe(
        "anthropic/claude-sonnet-4-5",
      );
    });
  });

  describe("resolveFoundryDeployment", () => {
    it("accepts legacy OpenAI-prefixed Foundry model values as deployment names", () => {
      expect(resolveFoundryDeployment({ MICROSOFT_FOUNDRY_DEPLOYMENT: "openai/gpt-5.5-1" })).toBe(
        "gpt-5.5-1",
      );
      expect(resolveFoundryDeployment({ NORA_DEFAULT_OPENCLAW_MODEL: "openai/gpt-5.5-1" })).toBe(
        "gpt-5.5-1",
      );
    });
  });

  describe("buildOpenClawConfigMergeCommand", () => {
    it("returns a single-string shell command equivalent to the merge script", () => {
      const command = buildOpenClawConfigMergeCommand({
        models: { providers: { "azure-openai-responses": { api: "openai-responses" } } },
      });
      expect(typeof command).toBe("string");
      expect(command).toContain("/tmp/nora-managed-openclaw.json");
      expect(command).toContain("const configPath = '/root/.openclaw/openclaw.json';");
      expect(command).toContain("azure-openai-responses");
      expect(command).toContain("openai-responses");
    });
  });

  it("merges managed OpenClaw config without replacing runtime-owned sections", () => {
    const script = buildOpenClawConfigMergeScript({
      gateway: { bind: "lan", mode: "local" },
    }).join("\n");

    expect(script).toContain("/tmp/nora-managed-openclaw.json");
    expect(script).toContain("const configPath = '/root/.openclaw/openclaw.json';");
    expect(script).toContain("mergeConfig(current, managed)");
    expect(script).not.toContain("> ~/.openclaw/openclaw.json");
  });
});

describe("Provisioner backends", () => {
  it("initializes managed state without rereading stopped container files", async () => {
    const dockerBackend = new DockerBackend();
    const container = {};
    dockerBackend.docker = { getContainer: jest.fn(() => container) };
    dockerBackend._readManagedEnvState = jest.fn().mockRejectedValue(new Error("unexpected read"));
    dockerBackend._readContainerFile = jest.fn().mockRejectedValue(new Error("unexpected read"));
    dockerBackend._putBootstrapFiles = jest.fn().mockResolvedValue(undefined);

    await dockerBackend.updateEnv(
      "container-1",
      {
        OPENAI_API_KEY: "provider-secret-sentinel",
        OPENCLAW_GATEWAY_TOKEN: "gateway-secret-sentinel",
      },
      {
        managedEnvNames: ["OPENAI_API_KEY"],
        replaceManagedState: true,
        initializeManagedState: true,
        runtimeFamily: "openclaw",
      },
    );

    expect(dockerBackend._readManagedEnvState).not.toHaveBeenCalled();
    expect(dockerBackend._readContainerFile).not.toHaveBeenCalled();
    const files = dockerBackend._putBootstrapFiles.mock.calls[0][1];
    const stateFile = files.find((file) => file.name === "opt/nora-managed-env/state.json");
    const reconcileFile = files.find(
      (file) => file.name === "opt/nora-managed-env/reconcile-openclaw.sh",
    );
    expect(stateFile.mode).toBe(0o600);
    expect(JSON.parse(stateFile.content)).toEqual({
      version: 1,
      managedNames: ["OPENAI_API_KEY"],
      values: {
        OPENAI_API_KEY: "provider-secret-sentinel",
        OPENCLAW_GATEWAY_TOKEN: "gateway-secret-sentinel",
      },
    });
    expect(reconcileFile.content).toContain("__NORA_PRUNE_MANAGED_OPENCLAW_CONFIG_ENV__");
    expect(reconcileFile.content).not.toContain("provider-secret-sentinel");
    expect(reconcileFile.content).not.toContain("gateway-secret-sentinel");
    expect(files.some((file) => file.name === "opt/openclaw-runtime/start.sh")).toBe(false);
  });

  it("keeps Docker creation metadata and generated bootstrap scripts credential-free", async () => {
    const dockerBackend = new DockerBackend();
    const createdContainer = {
      id: "container-secret-regression",
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        NetworkSettings: { IPAddress: "172.18.0.20", Networks: {}, Ports: {} },
      }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    dockerBackend._ensureDefaultAgentImage = jest.fn().mockResolvedValue(undefined);
    dockerBackend._findComposeNetwork = jest.fn().mockResolvedValue(null);
    dockerBackend._putBootstrapFiles = jest.fn().mockResolvedValue(undefined);
    dockerBackend.docker = {
      getContainer: jest.fn((id) =>
        id === createdContainer.id
          ? createdContainer
          : { inspect: jest.fn().mockRejectedValue(new Error("not found")) },
      ),
      createVolume: jest.fn().mockResolvedValue(undefined),
      createContainer: jest.fn().mockResolvedValue(createdContainer),
      getNetwork: jest.fn(() => ({ connect: jest.fn().mockResolvedValue(undefined) })),
    };

    const sentinels = {
      OPENAI_API_KEY: "provider-secret-sentinel",
      GITHUB_TOKEN: "integration-secret-sentinel",
      NORA_MCP_GITLAB_TOKEN_ALIAS: "mcp-secret-sentinel",
    };
    await dockerBackend.create({
      id: "secret-regression",
      name: "Secret Regression",
      gatewayHostPort: 19444,
      credentialManagedEnvNames: Object.keys(sentinels),
      env: sentinels,
    });

    const createConfig = dockerBackend.docker.createContainer.mock.calls[0][0];
    const [bootstrapFiles, managedFiles] = dockerBackend._putBootstrapFiles.mock.calls.map(
      (call) => call[1],
    );
    const stateFile = managedFiles.find((file) => file.name === "opt/nora-managed-env/state.json");
    const state = JSON.parse(stateFile.content);
    const immutableArtifacts = JSON.stringify({ createConfig, bootstrapFiles });

    for (const secret of [...Object.values(sentinels), state.values.OPENCLAW_GATEWAY_TOKEN]) {
      expect(immutableArtifacts).not.toContain(secret);
    }
    expect(state.values).toEqual(
      expect.objectContaining({
        ...sentinels,
        OPENCLAW_GATEWAY_TOKEN: expect.any(String),
      }),
    );
    expect(stateFile.mode).toBe(0o600);
    expect(createdContainer.start).toHaveBeenCalledTimes(1);
  });

  it("demuxes non-TTY Docker exec output before command consumers read it", async () => {
    const dockerBackend = new DockerBackend();
    const rawStream = new PassThrough();
    const payload = Buffer.from(`${'{"status":"ok"}'.padEnd(67, " ")}\n`);
    const frame = Buffer.alloc(8 + payload.length);
    frame[0] = 1;
    frame.writeUInt32BE(payload.length, 4);
    payload.copy(frame, 8);
    const execInstance = {
      start: jest.fn(async () => {
        setImmediate(() => rawStream.end(frame));
        return rawStream;
      }),
    };
    dockerBackend.docker.getContainer = jest.fn(() => ({
      exec: jest.fn(async () => execInstance),
    }));

    const result = await dockerBackend.exec("container-1", {
      cmd: ["/bin/sh", "-lc", "printf json"],
      tty: false,
    });
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(Buffer.concat(chunks).toString("utf8")).toBe(payload.toString("utf8"));
    expect(execInstance.start).toHaveBeenCalledWith({ hijack: true, stdin: true, Tty: false });
  });

  it("builds a Docker startup script with the executable guard and runtime bootstrap", () => {
    const dockerBackend = new DockerBackend();
    const files = dockerBackend._buildBootstrapFiles({
      gatewayConfig: { gateway: { bind: "lan", mode: "local" } },
      pairedJson: '{"device":"paired"}',
      buildAuthScript: 'console.log("build auth");',
    });
    const runtimeNames = files.map((file) => file.name);
    const startupScript = files.find((file) => file.name === "opt/openclaw-runtime/start.sh");

    expect(runtimeNames).toEqual(
      expect.arrayContaining([
        "opt/openclaw-runtime/lib/contracts.ts",
        "opt/openclaw-runtime/lib/containerCommand.ts",
        "opt/openclaw-runtime/lib/openclawDefaults.ts",
        "opt/openclaw-runtime/lib/server.ts",
        "opt/openclaw-runtime/lib/execEndpoint.ts",
        "opt/openclaw-runtime/lib/agent.ts",
        "opt/openclaw-runtime/lib/build-auth.js",
        "usr/local/bin/nora-integration-tool",
        "usr/local/bin/nora-mcp-server",
        "opt/openclaw-runtime/start.sh",
      ]),
    );
    expect(startupScript).toBeTruthy();
    expect(startupScript.mode).toBe(0o755);
    expect(files.find((file) => file.name === "usr/local/bin/nora-integration-tool")).toEqual(
      expect.objectContaining({
        mode: 0o755,
      }),
    );
    expect(startupScript.content).toContain(
      'DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"',
    );
    expect(startupScript.content).toContain(DEFAULT_OPENCLAW_PACKAGE_SPEC);
    expect(startupScript.content).toContain('export OPENCLAW_CLI_PATH="$OPENCLAW_BIN"');
    expect(startupScript.content).toContain(
      "mkdir -p /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent",
    );
    expect(startupScript.content).toContain("__NORA_MERGE_OPENCLAW_CONFIG__");
    expect(startupScript.content).toContain("__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__");
    expect(startupScript.content).toContain("paste-api-key");
    expect(startupScript.content).toContain(
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 &',
    );
    expect(startupScript.content).toContain('exec "$OPENCLAW_BIN" gateway --port 18789');
  });

  it("packages Docker bootstrap files into a tar archive before container start", async () => {
    const dockerBackend = new DockerBackend();
    const files = dockerBackend._buildBootstrapFiles({
      gatewayConfig: { gateway: { bind: "lan", mode: "local" } },
      pairedJson: '{"device":"paired"}',
      buildAuthScript: 'console.log("build auth");',
    });
    let archive = null;
    let options = null;
    const fakeContainer = {
      putArchive: jest.fn(async (receivedArchive, receivedOptions) => {
        archive = receivedArchive;
        options = receivedOptions;
      }),
    };

    await dockerBackend._putBootstrapFiles(fakeContainer, files);

    expect(fakeContainer.putArchive).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ path: "/" });
    expect(Buffer.isBuffer(archive)).toBe(true);

    const entries = await extractTarEntries(archive);
    const entryNames = entries.map((entry) => entry.name);
    const startupScript = entries.find((entry) => entry.name === "opt/openclaw-runtime/start.sh");

    expect(entryNames).toEqual(
      expect.arrayContaining([
        "opt",
        "opt/openclaw-runtime",
        "opt/openclaw-runtime/lib",
        "opt/openclaw-runtime/lib/contracts.ts",
        "opt/openclaw-runtime/lib/containerCommand.ts",
        "opt/openclaw-runtime/lib/server.ts",
        "opt/openclaw-runtime/lib/execEndpoint.ts",
        "opt/openclaw-runtime/lib/agent.ts",
        "opt/openclaw-runtime/lib/build-auth.js",
        "usr/local/bin/nora-integration-tool",
        "usr/local/bin/nora-mcp-server",
        "opt/openclaw-runtime/start.sh",
      ]),
    );
    expect(startupScript).toBeTruthy();
    expect(startupScript.mode).toBe(0o755);
    expect(startupScript.content).toContain('exec "$OPENCLAW_BIN" gateway --port 18789');
  });

  it("keeps Foundry provider registration secret-free in the startup merge script", () => {
    const dockerBackend = new DockerBackend();
    const files = dockerBackend._buildBootstrapFiles({
      gatewayConfig: {
        gateway: { bind: "lan", mode: "local" },
        models: {
          providers: {
            "azure-openai-responses": {
              api: "azure-openai-responses",
              baseUrl: "https://r.openai.azure.com/openai/v1",
              apiKey: "ms-key",
            },
          },
        },
      },
      pairedJson: '{"device":"paired"}',
      buildAuthScript: 'console.log("build auth");',
    });
    const startupScript = files.find((file) => file.name === "opt/openclaw-runtime/start.sh");
    expect(startupScript.content).toContain("azure-openai-responses");
    expect(startupScript.content).toContain("https://r.openai.azure.com/openai/v1");
    expect(startupScript.content).not.toContain('"apiKey"');
    expect(startupScript.content).not.toContain("ms-key");
  });

  it("embeds only secret-free MCP wrapper configuration into the startup merge script", () => {
    const dockerBackend = new DockerBackend();
    const mcpServers = buildMcpServersConfig([
      {
        name: "gitlab",
        npmPackage: "@modelcontextprotocol/server-gitlab",
        env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-secret" },
      },
    ]);
    const files = dockerBackend._buildBootstrapFiles({
      gatewayConfig: { gateway: { bind: "lan", mode: "local" }, mcpServers },
      pairedJson: '{"device":"paired"}',
      buildAuthScript: 'console.log("build auth");',
    });
    const startupScript = files.find((file) => file.name === "opt/openclaw-runtime/start.sh");
    const encodedWrapperConfig = mcpServers.gitlab.args[0];
    expect(startupScript.content).toContain('"mcpServers"');
    expect(startupScript.content).toContain("/usr/local/bin/nora-mcp-server");
    expect(startupScript.content).toContain(encodedWrapperConfig);
    expect(startupScript.content).not.toContain("@modelcontextprotocol/server-gitlab");
    expect(startupScript.content).not.toContain("GITLAB_PERSONAL_ACCESS_TOKEN");
    expect(startupScript.content).not.toContain("glpat-secret");
  });

  it("wires the executable guard into OpenClaw startup paths", () => {
    const k8sSource = fs.readFileSync(
      path.resolve(__dirname, "../../workers/provisioner/backends/k8s.ts"),
      "utf8",
    );
    const nemoclawSource = fs.readFileSync(
      path.resolve(__dirname, "../../workers/provisioner/backends/nemoclaw.ts"),
      "utf8",
    );

    expect(k8sSource).toContain("buildOpenClawInstallCommand(");
    // k8s shares the docker package spec (OPENCLAW_DOCKER_PACKAGE env) so a
    // fleet can be pinned with one knob instead of hardcoding @latest.
    expect(k8sSource).toContain("getStandardDockerPackageSpec()");
    expect(k8sSource).toContain('"nemoclaw@latest"');
    expect(nemoclawSource).toContain("buildOpenClawInstallCommand([");
    expect(nemoclawSource).toContain("getStandardDockerPackageSpec()");

    expect(k8sSource).toContain("ensureOpenClawCmd +");
    expect(nemoclawSource).toContain('Cmd: ["/opt/openclaw-runtime/start.sh"]');
    expect(nemoclawSource).toContain("await this._putBootstrapFiles(container, bootstrapFiles)");

    expect(k8sSource).toContain('"$OPENCLAW_BIN" gateway');
    expect(nemoclawSource).toContain('"$OPENCLAW_BIN" gateway');
  });
});

// Every module runtimeBootstrap.ts (and the other shipped runtime files)
// require()s relatively must itself be in RUNTIME_FILES — otherwise the
// in-container runtime server crashes at load with MODULE_NOT_FOUND (this
// happened with mcpServersConfig). Walk the shipped sources and assert closure.
describe("runtime bundle closure", () => {
  it("ships every relatively-required module into the container", () => {
    const runtimeBootstrap = require("../../agent-runtime/lib/runtimeBootstrap");
    const shipped = runtimeBootstrap.buildRuntimeBootstrapFiles();
    const shippedNames = new Set(shipped.map((f) => f.relPath));
    const missing = [];
    for (const file of shipped) {
      const requires = [...file.source.matchAll(/require\(["']\.\/([A-Za-z0-9_-]+)["']\)/g)];
      for (const [, mod] of requires) {
        if (!shippedNames.has(`${mod}.ts`) && !shippedNames.has(`${mod}.js`)) {
          missing.push(`${file.relPath} requires ./${mod}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
