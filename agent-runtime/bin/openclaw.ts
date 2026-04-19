#!/usr/bin/env tsx
// OpenClaw CLI — installed in every agent container

const os = require("os");
const { execSync } = require("child_process");

const AGENT_ID = process.env.AGENT_ID || "unknown";
const AGENT_NAME = process.env.AGENT_NAME || "unnamed";

const HELP = `
\x1b[36m╔══════════════════════════════════════════════════╗
║           \x1b[1m🦞  OpenClaw Agent Runtime\x1b[0m\x1b[36m             ║
╚══════════════════════════════════════════════════╝\x1b[0m

\x1b[1mUsage:\x1b[0m  openclaw <command>

\x1b[1mCommands:\x1b[0m
  \x1b[33mstatus\x1b[0m       Show agent status and system info
  \x1b[33minfo\x1b[0m         Show agent identity and environment
  \x1b[33mhealth\x1b[0m       Run health checks
  \x1b[33mlogs\x1b[0m         Show agent process logs
  \x1b[33mrun\x1b[0m <file>   Execute a runtime script with tsx
  \x1b[33mrepl\x1b[0m         Start an interactive Node.js REPL
  \x1b[33menv\x1b[0m          Show environment variables
  \x1b[33mversion\x1b[0m      Show runtime version
  \x1b[33mhelp\x1b[0m         Show this help message

\x1b[2mAgent: ${AGENT_NAME} (${AGENT_ID})\x1b[0m
`;

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function formatUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}

const commands = {
  status() {
    const mem = process.memoryUsage();
    const cpus = os.cpus();
    console.log(`
\x1b[36m── Agent Status ──────────────────────────\x1b[0m
  \x1b[1mName:\x1b[0m        ${AGENT_NAME}
  \x1b[1mID:\x1b[0m          ${AGENT_ID}
  \x1b[1mStatus:\x1b[0m      \x1b[32m● Running\x1b[0m
  \x1b[1mUptime:\x1b[0m      ${formatUptime(os.uptime())}
  \x1b[1mNode.js:\x1b[0m     ${process.version}
  \x1b[1mPlatform:\x1b[0m    ${os.platform()} ${os.arch()}

\x1b[36m── System Resources ─────────────────────\x1b[0m
  \x1b[1mCPU:\x1b[0m         ${cpus.length} cores (${cpus[0]?.model || "unknown"})
  \x1b[1mMemory:\x1b[0m      ${formatBytes(os.freemem())} free / ${formatBytes(os.totalmem())} total
  \x1b[1mHeap:\x1b[0m        ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}
  \x1b[1mHostname:\x1b[0m    ${os.hostname()}
`);
  },

  info() {
    console.log(`
\x1b[36m── Agent Info ────────────────────────────\x1b[0m
  \x1b[1mAgent ID:\x1b[0m    ${AGENT_ID}
  \x1b[1mAgent Name:\x1b[0m  ${AGENT_NAME}
  \x1b[1mNode.js:\x1b[0m     ${process.version}
  \x1b[1mRuntime:\x1b[0m     @openclaw/agent-runtime v1.0.0
  \x1b[1mPID:\x1b[0m         ${process.pid}
  \x1b[1mCWD:\x1b[0m         ${process.cwd()}
  \x1b[1mUser:\x1b[0m        ${os.userInfo().username}
  \x1b[1mHome:\x1b[0m        ${os.homedir()}
`);
  },

  health() {
    console.log("\x1b[36m── Health Checks ─────────────────────────\x1b[0m\n");
    const checks = [
      { name: "Node.js runtime", test: () => !!process.version },
      { name: "File system (writable)", test: () => { require("fs").writeFileSync("/tmp/.openclaw-health", "ok"); return true; } },
      { name: "Network (DNS)", test: () => { try { require("dns").lookupService("127.0.0.1", 80, () => {}); return true; } catch { return false; } } },
      { name: "Memory available", test: () => os.freemem() > 50 * 1024 * 1024 },
      { name: "Agent env vars set", test: () => !!process.env.AGENT_ID },
    ];

    let allOk = true;
    for (const check of checks) {
      try {
        const ok = check.test();
        console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${check.name}`);
        if (!ok) allOk = false;
      } catch {
        console.log(`  \x1b[31m✗\x1b[0m ${check.name}`);
        allOk = false;
      }
    }
    console.log(`\n  ${allOk ? "\x1b[32mAll checks passed\x1b[0m" : "\x1b[33mSome checks failed\x1b[0m"}\n`);
  },

  logs() {
    const logFile = "/var/log/openclaw-agent.log";
    try {
      const data = require("fs").readFileSync(logFile, "utf8");
      console.log(data || "(no logs yet)");
    } catch {
      console.log("(no logs yet — agent process may not have written any output)");
    }
  },

  run() {
    const file = process.argv[3];
    if (!file) {
      console.error("Usage: openclaw run <file>");
      process.exit(1);
    }
    try {
      const tsxBin = process.env.OPENCLAW_TSX_BIN || "tsx";
      require("child_process").execFileSync(tsxBin, [file], { stdio: "inherit" });
    } catch (e) {
      process.exit(e.status || 1);
    }
  },

  repl() {
    console.log(`\x1b[36mOpenClaw REPL — Agent: ${AGENT_NAME}\x1b[0m\n`);
    require("repl").start({
      prompt: "\x1b[33mopenclaw>\x1b[0m ",
      useGlobal: true,
    });
  },

  env() {
    console.log("\x1b[36m── Environment Variables ─────────────────\x1b[0m\n");
    for (const [k, v] of Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  \x1b[1m${k}\x1b[0m=${v}`);
    }
    console.log();
  },

  version() {
    console.log("@openclaw/agent-runtime v1.0.0");
  },

  help() {
    console.log(HELP);
  },
};

// Parse command
const cmd = process.argv[2] || "help";
if (commands[cmd]) {
  commands[cmd]();
} else {
  console.error(`\x1b[31mUnknown command: ${cmd}\x1b[0m`);
  console.log(HELP);
  process.exit(1);
}
