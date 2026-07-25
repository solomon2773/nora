import assert from "node:assert/strict";
import { chmod, copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test(
  "starts through an npm-style symlinked bin",
  {
    timeout: 10_000,
    skip:
      process.platform === "win32"
        ? "npm uses command shims instead of symlinks on Windows"
        : false,
  },
  async (t) => {
    const installRoot = await mkdtemp(path.join(tmpdir(), "nora-mcp-entrypoint-"));
    t.after(() => rm(installRoot, { recursive: true, force: true }));

    const binDirectory = path.join(installRoot, "node_modules", ".bin");
    const binPath = path.join(binDirectory, "nora-mcp");
    const installedPackage = path.join(installRoot, "node_modules", "@noraai", "mcp-server");
    const entrypointPath = path.join(installedPackage, "src", "index.js");
    await mkdir(installedPackage, { recursive: true });
    await cp(path.join(packageRoot, "src"), path.join(installedPackage, "src"), {
      recursive: true,
    });
    await copyFile(
      path.join(packageRoot, "package.json"),
      path.join(installedPackage, "package.json"),
    );
    await symlink(
      path.join(packageRoot, "node_modules"),
      path.join(installedPackage, "node_modules"),
      "dir",
    );
    await chmod(entrypointPath, 0o755);
    await mkdir(binDirectory, { recursive: true });
    await symlink(path.relative(binDirectory, entrypointPath), binPath);

    const transport = new StdioClientTransport({
      command: binPath,
      env: {
        ...process.env,
        NORA_API_URL: "https://nora.invalid",
        NORA_API_KEY: "nora_test",
      },
    });
    const client = new Client({ name: "entrypoint-regression", version: "0.0.0" });
    t.after(() => client.close());

    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, "0.1.4");

    const result = await client.listTools();

    assert.ok(result.tools.some((tool) => tool.name === "list_agents"));
  },
);
