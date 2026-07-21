const api = require("../client");
const { load, save } = require("../config");
const table = require("../table");

async function list(args, flags = {}) {
  const rows = await api.get("/api/workspaces");
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const active = load().workspaceId;
  table(rows, [
    { header: "ID", value: (r) => r.id },
    { header: "NAME", value: (r) => r.name },
    { header: "ROLE", value: (r) => r.role || "—" },
    { header: "ACTIVE", value: (r) => (r.id === active ? "✓" : "") },
  ]);
}

async function use(args) {
  const id = args[0];
  if (!id) throw new Error("usage: nora workspaces use <workspace-id>");
  save({ workspaceId: id });
  console.log(`Active workspace set to ${id}`);
}

async function show() {
  const cfg = load();
  if (!cfg.workspaceId) {
    console.log("No active workspace. Run `nora workspaces use <id>`.");
    return;
  }
  console.log(cfg.workspaceId);
}

module.exports = {
  describe: "List, switch, or print the active workspace",
  subcommands: {
    list: { run: list, describe: "List workspaces you can access" },
    use: { run: use, describe: "Set the active workspace (writes ~/.nora/config.json)" },
    show: { run: show, describe: "Print the active workspace id" },
  },
};
