// @ts-nocheck
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildOpenClawAuthProfilesWriteCommand,
  buildOpenClawConfigMergeScript,
  buildOpenClawConfigMergeCommand,
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

describe("OpenClaw bootstrap helpers", () => {
  it("copies the runtime contracts alongside the agent server bundle", () => {
    const cmd = buildRuntimeBootstrapCommand();

    expect(cmd).toContain("/opt/openclaw-runtime/lib/contracts.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/containerCommand.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/server.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/execEndpoint.ts");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/agent.ts");
  });

  it("verifies the OpenClaw CLI can execute before skipping installation", () => {
    const cmd = buildOpenClawInstallCommand(["openclaw@latest"]);

    expect(cmd).toContain('OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"');
    expect(cmd).toContain('OPENCLAW_TSX_BIN="${OPENCLAW_TSX_BIN:-/usr/local/bin/tsx}"');
    expect(cmd).toContain('DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"');
    expect(cmd).toContain('DETECTED_OPENCLAW_TSX_BIN="$(command -v tsx 2>/dev/null || true)"');
    expect(cmd).toContain('[ -x "$OPENCLAW_BIN" ]');
    expect(cmd).toContain('"$OPENCLAW_BIN" --version >/dev/null 2>&1');
    expect(cmd).toContain('"$OPENCLAW_TSX_BIN" --version >/dev/null 2>&1');
    expect(cmd).toContain("npm uninstall -g openclaw tsx >/dev/null 2>&1 || true");
    expect(cmd).toContain(
      "npm install -g openclaw@latest tsx@4.21.0 >/tmp/openclaw-install.log 2>&1",
    );
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
      expect(fs.readFileSync(argsLog, "utf8")).not.toContain("microsoft-foundry");
      expect(fs.readFileSync(stdinLog, "utf8")).toBe("sk-openai\n");
      expect(fs.existsSync(path.join(tmpDir, "auth-profiles.json"))).toBe(true);
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
        "opt/openclaw-runtime/lib/server.ts",
        "opt/openclaw-runtime/lib/execEndpoint.ts",
        "opt/openclaw-runtime/lib/agent.ts",
        "opt/openclaw-runtime/lib/build-auth.js",
        "usr/local/bin/nora-integration-tool",
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
        "opt/openclaw-runtime/start.sh",
      ]),
    );
    expect(startupScript).toBeTruthy();
    expect(startupScript.mode).toBe(0o755);
    expect(startupScript.content).toContain('exec "$OPENCLAW_BIN" gateway --port 18789');
  });

  it("embeds the Foundry provider registration into the startup merge script", () => {
    // End-to-end check: when _buildBootstrapFiles receives a gatewayConfig
    // with models.providers["azure-openai-responses"], the generated start.sh
    // ships those fields verbatim into the openclaw.json deep-merge.
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
    expect(startupScript.content).toContain('"apiKey": "ms-key"');
  });

  it("embeds a per-agent mcpServers block into the startup merge script", () => {
    // buildMcpServersConfig produces the openclaw.json mcpServers shape; when it
    // is placed on the gatewayConfig, _buildBootstrapFiles ships it verbatim
    // into the deep-merge so OpenClaw spawns the stdio server with its creds.
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
    expect(startupScript.content).toContain('"mcpServers"');
    expect(startupScript.content).toContain("@modelcontextprotocol/server-gitlab");
    expect(startupScript.content).toContain('"GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-secret"');
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
    expect(k8sSource).toContain('["openclaw@latest"]');
    expect(k8sSource).toContain('"nemoclaw@latest"');
    expect(nemoclawSource).toContain("buildOpenClawInstallCommand([");

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
