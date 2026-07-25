// Converts a list of synced integrations into OpenClaw-compatible tool
// catalog entries that the LLM gateway merges into its tool list. Pure
// transformation — no I/O, no DB. The runtime-side `integrationTools`
// helpers supply per-integration execution metadata and tool-spec lookup.

const {
  buildIntegrationToolExecutionMetadata,
  getIntegrationToolSpecs,
} = require("../../../agent-runtime/lib/integrationTools");

import type { ToolCatalogEntry } from "../types/integration";

export interface BuildToolCatalogOptions {
  reservedNames?: Set<string>;
}

function normalizeToolName(rawName: unknown, fallback: string): string {
  const candidate = String(rawName || fallback || "tool")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return candidate || "tool";
}

function ensureUniqueToolName(baseName: string, reservedNames: Set<string>): string {
  let nextName = baseName;
  let suffix = 2;
  while (reservedNames.has(nextName)) {
    nextName = `${baseName}_${suffix}`;
    suffix += 1;
  }
  reservedNames.add(nextName);
  return nextName;
}

function normalizeToolParameterSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return schema as Record<string, unknown>;
}

/**
 * Convert synced integration manifests into collision-free runtime tool declarations.
 *
 * @param {Object[]} [integrations=[]] - Synced integrations with declared tool specs.
 * @param {Object} [options={}] - Names already reserved by other tool sources.
 * @returns {Array} Executable and manifest-backed tool catalog entries.
 */
export function buildIntegrationToolCatalogEntries(
  integrations: any[] = [],
  options: BuildToolCatalogOptions = {},
): ToolCatalogEntry[] {
  const reservedNames =
    options.reservedNames instanceof Set ? new Set(options.reservedNames) : new Set<string>();
  const tools: ToolCatalogEntry[] = [];

  for (const integration of Array.isArray(integrations) ? integrations : []) {
    const toolSpecs = getIntegrationToolSpecs(integration);

    for (let index = 0; index < toolSpecs.length; index += 1) {
      const spec = toolSpecs[index] || {};
      const uniqueName = ensureUniqueToolName(
        normalizeToolName(spec.name, `${integration.provider}_${index + 1}`),
        reservedNames,
      );
      const execution = buildIntegrationToolExecutionMetadata(integration, spec);

      tools.push({
        type: "function",
        function: {
          name: uniqueName,
          description:
            String(spec.description || "").trim() ||
            `Declared ${integration.name || integration.provider} integration capability.`,
          parameters: normalizeToolParameterSchema(spec.inputSchema || spec.parameters),
        },
        nora: {
          source: "integration-manifest",
          executable: execution.executable,
          executionState: execution.executionState,
          executionSurface: execution.executionSurface,
          executor: execution.executor,
          provider: integration.provider,
          providerName: integration.name || integration.provider,
          integrationId: integration.id,
          operation: spec.operation || null,
          runtimeToolName: execution.runtimeToolName,
          invokeCommand: execution.invokeCommand,
          exampleInput: execution.exampleInput,
          authType: integration.authType || null,
          capabilities: Array.isArray(integration.capabilities) ? integration.capabilities : [],
          api: integration.api || null,
          mcp: integration.mcp || null,
          usageHints: Array.isArray(integration.usageHints) ? integration.usageHints : [],
          config: integration.redactedConfig || {},
        } as any,
      });
    }
  }

  return tools;
}
