const fs = require("fs");
const path = require("path");
const {
  buildOpenClawInstallCommand,
  buildRuntimeBootstrapCommand,
  buildTemplatePayloadBootstrapFiles,
} = require("../../workers/provisioner/runtimeBootstrap");
const DockerBackend = require("../../workers/provisioner/backends/docker");
const tar = require(
  require.resolve("tar-stream", {
    paths: [path.resolve(__dirname, "../../workers/provisioner")],
  })
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

    expect(cmd).toContain("/opt/openclaw-runtime/lib/contracts.js");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/server.js");
    expect(cmd).toContain("/opt/openclaw-runtime/lib/agent.js");
  });

  it("verifies the OpenClaw CLI can execute before skipping installation", () => {
    const cmd = buildOpenClawInstallCommand(["openclaw@latest"]);

    expect(cmd).toContain('OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"');
    expect(cmd).toContain('DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"');
    expect(cmd).toContain('[ -x "$OPENCLAW_BIN" ]');
    expect(cmd).toContain('"$OPENCLAW_BIN" --version >/dev/null 2>&1');
    expect(cmd).toContain("npm uninstall -g openclaw >/dev/null 2>&1 || true");
    expect(cmd).toContain("npm install -g openclaw@latest >/tmp/openclaw-install.log 2>&1");
    expect(cmd).toContain("hash -r 2>/dev/null || true");
    expect(cmd).toContain('export OPENCLAW_CLI_PATH="$OPENCLAW_BIN"');
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
      ])
    );
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
        "opt/openclaw-runtime/lib/contracts.js",
        "opt/openclaw-runtime/lib/server.js",
        "opt/openclaw-runtime/lib/agent.js",
        "opt/openclaw-runtime/lib/build-auth.js",
        "opt/openclaw-runtime/start.sh",
      ])
    );
    expect(startupScript).toBeTruthy();
    expect(startupScript.mode).toBe(0o755);
    expect(startupScript.content).toContain('DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"');
    expect(startupScript.content).toContain('export OPENCLAW_CLI_PATH="$OPENCLAW_BIN"');
    expect(startupScript.content).toContain("mkdir -p /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent");
    expect(startupScript.content).toContain('node /opt/openclaw-runtime/lib/agent.js >> /var/log/openclaw-agent.log 2>&1 &');
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
        "opt/openclaw-runtime/lib/contracts.js",
        "opt/openclaw-runtime/lib/server.js",
        "opt/openclaw-runtime/lib/agent.js",
        "opt/openclaw-runtime/lib/build-auth.js",
        "opt/openclaw-runtime/start.sh",
      ])
    );
    expect(startupScript).toBeTruthy();
    expect(startupScript.mode).toBe(0o755);
    expect(startupScript.content).toContain('exec "$OPENCLAW_BIN" gateway --port 18789');
  });

  it("wire the executable guard into every inline OpenClaw startup path", () => {
    const k8sSource = fs.readFileSync(
      path.resolve(__dirname, "../../workers/provisioner/backends/k8s.js"),
      "utf8"
    );
    const nemoclawSource = fs.readFileSync(
      path.resolve(__dirname, "../../workers/provisioner/backends/nemoclaw.js"),
      "utf8"
    );

    expect(k8sSource).toContain('buildOpenClawInstallCommand(["openclaw@latest"])');
    expect(nemoclawSource).toContain("buildOpenClawInstallCommand([");

    expect(k8sSource).toContain("ensureOpenClawCmd +");
    expect(nemoclawSource).toContain("ensureOpenClawCmd +");

    expect(k8sSource).toContain('"$OPENCLAW_BIN" gateway');
    expect(nemoclawSource).toContain('"$OPENCLAW_BIN" gateway');
  });
});
