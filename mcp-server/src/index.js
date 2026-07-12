#!/usr/bin/env node
// Nora MCP server — operate a Nora agent fleet from any MCP client.
//
// Stdio transport: stdout belongs to the protocol. Anything human-facing goes
// to stderr; never console.log in this process.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApi } from "./client.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerMonitoringTools } from "./tools/monitoring.js";

export const SERVER_INFO = { name: "nora", version: "0.1.4" };

export function createServer({ api, env = process.env } = {}) {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Tools for operating a Nora self-hosted agent ops control plane: list, deploy, start/stop, and inspect agent runtimes (OpenClaw, Hermes), and read fleet metrics, events, and per-agent cost. Mutating tools require an API key with the agents:write scope; reads require agents:read / monitoring:read.",
  });
  const client = api || createApi();
  const allowDestructive = String(env.NORA_MCP_ALLOW_DESTRUCTIVE || "").toLowerCase() === "true";
  registerAgentTools(server, client, { allowDestructive });
  registerMonitoringTools(server, client);
  return server;
}

export async function main() {
  let server;
  try {
    server = createServer();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Nora MCP server ready (stdio)");
}

function isDirectRun() {
  const entrypointPath = process.argv[1];
  const modulePath = fileURLToPath(import.meta.url);
  if (!entrypointPath || !fs.existsSync(entrypointPath) || !fs.existsSync(modulePath)) {
    return false;
  }

  try {
    return fs.realpathSync(entrypointPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
