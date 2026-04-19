// OpenClaw Agent Process — the main long-running process inside agent containers
const os = require("os");
const fs = require("fs");
const { startServer } = require("./server");

const AGENT_ID = process.env.AGENT_ID || "unknown";
const AGENT_NAME = process.env.AGENT_NAME || "unnamed";
const LOG_FILE = "/var/log/openclaw-agent.log";

function log(level, message) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch { /* ignore write errors */ }
}

// Banner
console.log(`
\x1b[36m╔══════════════════════════════════════════════════╗
║           \x1b[1m🦞  OpenClaw Agent Runtime\x1b[0m\x1b[36m             ║
╚══════════════════════════════════════════════════╝\x1b[0m
`);

log("INFO", `Agent starting: ${AGENT_NAME} (${AGENT_ID})`);
log("INFO", `Node.js ${process.version} on ${os.platform()} ${os.arch()}`);
log("INFO", `CPUs: ${os.cpus().length}, Memory: ${Math.round(os.totalmem() / 1024 / 1024)}MB`);
log("INFO", "Agent is ready and listening for tasks");

// Heartbeat — logs system status periodically
const HEARTBEAT_INTERVAL = 60_000; // 1 minute
setInterval(() => {
  const memUsed = os.totalmem() - os.freemem();
  const memPct = ((memUsed / os.totalmem()) * 100).toFixed(1);
  log("INFO", `Heartbeat — uptime: ${Math.floor(os.uptime())}s, memory: ${memPct}%, load: ${os.loadavg()[0].toFixed(2)}`);
}, HEARTBEAT_INTERVAL);

// Graceful shutdown
process.on("SIGTERM", () => {
  log("INFO", "Received SIGTERM — shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("INFO", "Received SIGINT — shutting down");
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();

// Start the HTTP API server on port 9090
startServer();
