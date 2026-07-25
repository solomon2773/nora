import { describe, expect, it } from "vitest";

import * as mcpServersConfig from "../lib/mcpServersConfig.ts";

const {
  MCP_SERVER_WRAPPER_COMMAND,
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServersConfig,
} = mcpServersConfig;

describe("buildMcpServersConfig", () => {
  it("emits a secret-free wrapper entry and stages credentials under managed aliases", () => {
    const entries = [
      {
        name: "gitlab",
        npmPackage: "@modelcontextprotocol/server-gitlab",
        env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-xxx" },
      },
    ];
    const config = buildMcpServersConfig([...entries]);
    expect(config.gitlab.command).toBe(MCP_SERVER_WRAPPER_COMMAND);
    expect(config.gitlab).not.toHaveProperty("env");
    expect(JSON.stringify(config)).not.toContain("glpat-xxx");
    const payload = JSON.parse(Buffer.from(config.gitlab.args[0], "base64").toString("utf8"));
    expect(payload.npmPackage).toBe("@modelcontextprotocol/server-gitlab");
    expect(payload.envAliases.GITLAB_PERSONAL_ACCESS_TOKEN).toMatch(/^NORA_MCP_GITLAB_/);
    expect(buildMcpManagedEnv(entries)).toEqual({
      [payload.envAliases.GITLAB_PERSONAL_ACCESS_TOKEN]: "glpat-xxx",
    });
    expect(buildMcpManagedEnvNames(entries)).toEqual([
      payload.envAliases.GITLAB_PERSONAL_ACCESS_TOKEN,
    ]);
  });

  it("appends extra args and drops empty/nullish env values", () => {
    const config = buildMcpServersConfig([
      {
        name: "supabase",
        npmPackage: "@supabase/mcp-server-supabase",
        args: ["--read-only"],
        env: { SUPABASE_ACCESS_TOKEN: "sbp", EMPTY: "", MISSING: null },
      },
    ]);
    const payload = JSON.parse(Buffer.from(config.supabase.args[0], "base64").toString("utf8"));
    expect(payload.args).toEqual(["--read-only"]);
    expect(payload.envAliases).toHaveProperty("SUPABASE_ACCESS_TOKEN");
    expect(payload.envAliases).not.toHaveProperty("EMPTY");
    expect(payload.envAliases).not.toHaveProperty("MISSING");
    expect(JSON.stringify(config)).not.toContain("sbp");
  });

  it("omits the env key entirely when there are no usable values", () => {
    const config = buildMcpServersConfig([{ name: "x", npmPackage: "@x/y", env: { A: "" } }]);
    expect(config.x.command).toBe(MCP_SERVER_WRAPPER_COMMAND);
    expect("env" in config.x).toBe(false);
  });

  it("skips malformed entries and tolerates non-array input", () => {
    expect(buildMcpServersConfig([{ name: "no-pkg" }, { npmPackage: "no-name" }, null])).toEqual(
      {},
    );
    expect(buildMcpServersConfig(undefined)).toEqual({});
  });
});
