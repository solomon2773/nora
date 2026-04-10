#!/usr/bin/env node

const {
  NORA_INTEGRATION_TOOL_COMMAND,
  buildIntegrationToolExecutionMetadata,
  executeIntegrationToolInvocation,
  loadSyncedIntegrations,
  normalizeIntegrationToolInput,
} = require("./integrationTools");

function printHelp() {
  process.stdout.write(
    [
      `${NORA_INTEGRATION_TOOL_COMMAND} <tool_name> '<json input>'`,
      "",
      "Options:",
      "  --list      List executable Nora integration tools synced to this agent",
      "  --help      Show this help message",
      "",
      "Examples:",
      `  ${NORA_INTEGRATION_TOOL_COMMAND} --list`,
      `  ${NORA_INTEGRATION_TOOL_COMMAND} github_list_repositories '{"owner":"openai","per_page":10}'`,
      `  ${NORA_INTEGRATION_TOOL_COMMAND} github_get_file_contents '{"owner":"openai","repo":"openai-node","path":"README.md"}'`,
      "",
    ].join("\n")
  );
}

function readJsonArgument(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) return {};

  try {
    return normalizeIntegrationToolInput(JSON.parse(value));
  } catch {
    throw new Error("Input must be a valid JSON object");
  }
}

function listExecutableTools() {
  const integrations = loadSyncedIntegrations();
  const tools = [];

  for (const integration of integrations) {
    const toolSpecs = Array.isArray(integration.toolSpecs)
      ? integration.toolSpecs
      : [];

    for (const spec of toolSpecs) {
      const execution = buildIntegrationToolExecutionMetadata(integration, spec);
      if (!execution.executable) continue;
      tools.push({
        provider: integration.provider,
        providerName: integration.name || integration.provider,
        toolName: execution.runtimeToolName,
        description: spec.description || "",
        operation: spec.operation || null,
        invokeCommand: execution.invokeCommand,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const firstArg = args[0] || "";

  if (!firstArg || firstArg === "--help" || firstArg === "-h") {
    printHelp();
    return;
  }

  if (firstArg === "--list") {
    listExecutableTools();
    return;
  }

  const toolName = firstArg;
  const input = readJsonArgument(args[1]);
  const result = await executeIntegrationToolInvocation({
    toolName,
    input,
    integrations: loadSyncedIntegrations(),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
