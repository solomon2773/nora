#!/usr/bin/env node
// Nora CLI entrypoint. Routes argv to a command (or subcommand) defined in
// src/commands/. Auth + transport is centralized in src/client.js.

const { parseArgs } = require("./args");
const { version } = require("../package.json");

const commands = {
  login: require("./commands/login"),
  workspaces: require("./commands/workspaces"),
  agents: require("./commands/agents"),
  monitoring: require("./commands/monitoring"),
  mcp: require("./commands/mcp"),
  doctor: require("./commands/doctor"),
};

function printRootHelp() {
  console.log("Usage: nora <command> [args]\n");
  console.log("Commands:");
  for (const [name, cmd] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(14)} ${cmd.describe || ""}`);
  }
  console.log("\nGlobal:");
  console.log("  --help          Show help");
  console.log("  --version       Show version");
  console.log("\nEnv:");
  console.log("  NORA_HOST       Override host from config (e.g. https://nora.example.com)");
  console.log("  NORA_TOKEN      Override token (e.g. nora_…)");
  console.log("  NORA_WORKSPACE_ID  Override active workspace");
  console.log("\nRepository: https://github.com/solomon2773/nora");
  console.log(
    "If Nora is useful to you, consider starring it—it helps other operators discover the project.",
  );
}

function printSubcommandHelp(name, cmd) {
  console.log(`Usage: nora ${name} <subcommand> [args]\n`);
  if (cmd.describe) console.log(cmd.describe + "\n");
  console.log("Subcommands:");
  for (const [sub, def] of Object.entries(cmd.subcommands || {})) {
    console.log(`  ${sub.padEnd(14)} ${def.describe || ""}`);
  }
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.version) {
    console.log(version);
    return 0;
  }
  if (flags.help && positional.length === 0) {
    printRootHelp();
    return 0;
  }
  if (positional.length === 0) {
    printRootHelp();
    return positional.length === 0 ? 1 : 0;
  }

  const [name, ...rest] = positional;
  const cmd = commands[name];
  if (!cmd) {
    console.error(`Unknown command: ${name}`);
    printRootHelp();
    return 1;
  }

  if (cmd.subcommands) {
    if (rest.length === 0 || flags.help) {
      printSubcommandHelp(name, cmd);
      return rest.length === 0 ? 1 : 0;
    }
    const [sub, ...subArgs] = rest;
    const def = cmd.subcommands[sub];
    if (!def) {
      console.error(`Unknown subcommand: ${name} ${sub}`);
      printSubcommandHelp(name, cmd);
      return 1;
    }
    await def.run(subArgs, flags);
    return 0;
  }

  // Commands may return a process exit code (e.g. doctor returns non-zero when
  // the control plane is unhealthy); default to 0 when they return nothing.
  return (await cmd.run(rest, flags)) || 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    if (err && typeof err.status === "number") {
      console.error(`Error (${err.status}): ${err.message}`);
      if (err.code) console.error(`Code: ${err.code}`);
    } else {
      console.error(`Error: ${err && err.message ? err.message : String(err)}`);
    }
    process.exit(1);
  });
