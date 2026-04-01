const fs = require("fs");
const path = require("path");
const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
} = require("../../agent-runtime/lib/contracts");

function runtimeSourcePath(relPath) {
  return path.resolve(__dirname, "../../agent-runtime/lib", relPath);
}

function readRuntimeSource(relPath) {
  return fs.readFileSync(runtimeSourcePath(relPath), "utf8");
}

const SERVER_SOURCE_B64 = Buffer.from(readRuntimeSource("server.js")).toString("base64");
const AGENT_SOURCE_B64 = Buffer.from(readRuntimeSource("agent.js")).toString("base64");

function buildRuntimeBootstrapCommand() {
  return [
    "mkdir -p /opt/openclaw-runtime/lib /var/log && ",
    `printf '%s' '${SERVER_SOURCE_B64}' | base64 -d > /opt/openclaw-runtime/lib/server.js && `,
    `printf '%s' '${AGENT_SOURCE_B64}' | base64 -d > /opt/openclaw-runtime/lib/agent.js && `,
    "touch /var/log/openclaw-agent.log && ",
    "node /opt/openclaw-runtime/lib/agent.js >> /var/log/openclaw-agent.log 2>&1 & ",
  ].join("");
}

function buildRuntimeEnv() {
  return {
    AGENT_HTTP_PORT: String(AGENT_RUNTIME_PORT),
    OPENCLAW_GATEWAY_PORT: String(OPENCLAW_GATEWAY_PORT),
    BACKEND_API_URL:
      process.env.AGENT_RUNTIME_BACKEND_API_URL ||
      process.env.BACKEND_API_URL ||
      "http://backend-api:4000",
  };
}

module.exports = {
  buildRuntimeBootstrapCommand,
  buildRuntimeEnv,
};
