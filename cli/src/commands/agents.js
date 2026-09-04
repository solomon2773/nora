const api = require("../client");
const table = require("../table");

async function list(args, flags) {
  const rows = await api.get("/api/agents");

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  table(rows, [
    { header: "ID", value: (r) => r.id },
    { header: "NAME", value: (r) => r.name },
    { header: "STATUS", value: (r) => r.status },
    { header: "RUNTIME", value: (r) => `${r.runtime_family || "—"}/${r.deploy_target || "—"}` },
  ]);
}

async function get(args) {
  const id = args[0];
  if (!id) throw new Error("usage: nora agents get <agent-id>");
  const agent = await api.get(`/api/agents/${id}`);
  console.log(JSON.stringify(agent, null, 2));
}

async function action(name) {
  return async (args) => {
    const id = args[0];
    if (!id) throw new Error(`usage: nora agents ${name} <agent-id>`);
    const result = await api.post(`/api/agents/${id}/${name}`);
    console.log(JSON.stringify(result, null, 2));
  };
}

async function versions(args) {
  const id = args[0];
  if (!id) throw new Error("usage: nora agents versions <agent-id>");
  const rows = await api.get(`/api/agents/${id}/versions`);
  table(rows, [
    { header: "VERSION", value: (r) => `v${r.versionNumber}` },
    { header: "SOURCE", value: (r) => r.source },
    { header: "MESSAGE", value: (r) => r.message || "—" },
    { header: "WHEN", value: (r) => new Date(r.createdAt).toISOString() },
  ]);
}

async function rollback(args) {
  const id = args[0];
  const versionId = args[1];
  if (!id || !versionId) throw new Error("usage: nora agents rollback <agent-id> <version-id>");
  const result = await api.post(`/api/agents/${id}/rollback/${versionId}`);
  console.log(`Rolled back to v${result.restored.versionNumber}.`);
  if (result.redeployed) console.log("Redeploy queued.");
}

module.exports = {
  describe: "Inspect and operate agents",
  subcommands: {
    list: { run: list, describe: "List agents you can access" },
    get: { run: get, describe: "Print full JSON for a single agent" },
    start: { run: action("start"), describe: "Start a stopped agent" },
    stop: { run: action("stop"), describe: "Stop a running agent" },
    restart: { run: action("restart"), describe: "Restart an agent" },
    redeploy: { run: action("redeploy"), describe: "Re-queue an agent for deployment" },
    versions: { run: versions, describe: "List configuration versions for an agent" },
    rollback: { run: rollback, describe: "Roll back an agent to a prior version" },
  },
};
