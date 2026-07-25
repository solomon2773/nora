// @ts-nocheck
const crypto = require("crypto");

const MCP_SERVER_WRAPPER_COMMAND = "/usr/local/bin/nora-mcp-server";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildMcpServerEnvAlias(serverName, envName) {
  const rawServer = String(serverName || "").trim();
  const rawEnv = String(envName || "").trim();
  if (!rawServer || !ENV_NAME_RE.test(rawEnv)) {
    throw new Error("MCP server name and environment variable name are required");
  }
  const serverSegment = rawServer
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  const envSegment = rawEnv.slice(0, 32);
  const digest = crypto
    .createHash("sha256")
    .update(`${rawServer}\0${rawEnv}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `NORA_MCP_${serverSegment || "SERVER"}_${envSegment}_${digest}`;
}

function normalizeMcpEntry(entry) {
  if (!entry || !entry.name || !entry.npmPackage) return null;
  const name = String(entry.name).trim();
  const npmPackage = String(entry.npmPackage).trim();
  if (!name || !npmPackage) return null;
  const args = (Array.isArray(entry.args) ? entry.args : []).map((value) => String(value));
  const envAliases = {};
  for (const [rawEnvName, rawValue] of Object.entries(entry.env || {})) {
    const envName = String(rawEnvName || "").trim();
    if (!ENV_NAME_RE.test(envName) || rawValue == null || rawValue === "") continue;
    envAliases[envName] = buildMcpServerEnvAlias(name, envName);
  }
  for (const [rawEnvName, rawAlias] of Object.entries(entry.envAliases || {})) {
    const envName = String(rawEnvName || "").trim();
    const alias = String(rawAlias || "").trim();
    if (!ENV_NAME_RE.test(envName) || !ENV_NAME_RE.test(alias)) continue;
    envAliases[envName] = alias;
  }
  return { name, npmPackage, args, envAliases };
}

function buildMcpManagedEnv(entries = []) {
  const env = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeMcpEntry(entry);
    if (!normalized) continue;
    for (const [envName, value] of Object.entries(entry.env || {})) {
      if (value == null || value === "" || !ENV_NAME_RE.test(String(envName || ""))) continue;
      env[normalized.envAliases[envName] || buildMcpServerEnvAlias(normalized.name, envName)] =
        String(value);
    }
  }
  return env;
}

function buildMcpManagedEnvNames(entries = []) {
  const names = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeMcpEntry(entry);
    if (!normalized) continue;
    for (const alias of Object.values(normalized.envAliases)) names.add(alias);
  }
  return [...names].sort();
}

// OpenClaw launches each entry as a stdio MCP client. Credentials never enter
// openclaw.json: the config points at a fixed wrapper and carries only alias
// names. The wrapper copies the owner-only managed alias values into the child
// process's provider-specific environment immediately before spawning npx.
function buildMcpServersConfig(entries = []) {
  const servers = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeMcpEntry(entry);
    if (!normalized) continue;
    const payload = Buffer.from(
      JSON.stringify({
        npmPackage: normalized.npmPackage,
        args: normalized.args,
        envAliases: normalized.envAliases,
      }),
      "utf8",
    ).toString("base64");
    servers[normalized.name] = {
      command: MCP_SERVER_WRAPPER_COMMAND,
      args: [payload],
    };
  }
  return servers;
}

module.exports = {
  MCP_SERVER_WRAPPER_COMMAND,
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServerEnvAlias,
  buildMcpServersConfig,
};
