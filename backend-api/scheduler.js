// DB-backed node scheduler — selects the least-loaded node name.
//
// Node names are read from SCHEDULER_NODES env var (comma-separated).
// If no explicit scheduler nodes are configured, we fall back to the requested
// backend label so agents still get a stable node identifier in single-host
// or per-backend deployments.

const db = require("./db");

function configuredNodeNames() {
  return String(process.env.SCHEDULER_NODES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function selectNode(options = {}) {
  const fallbackName = String(options.fallback || options.backend || "docker").trim() || "docker";
  const nodeNames = configuredNodeNames();
  const candidates = nodeNames.length > 0 ? nodeNames : [fallbackName];

  // Query current agent distribution across nodes
  const result = await db.query(
    "SELECT node, COUNT(*)::int AS agent_count FROM agents WHERE status NOT IN ('error', 'deleted') GROUP BY node"
  );
  const counts = {};
  result.rows.forEach((r) => {
    counts[r.node] = r.agent_count;
  });

  // Pick the node with fewest active agents
  let minCount = Infinity;
  let selected = candidates[0];
  for (const name of candidates) {
    const count = counts[name] || 0;
    if (count < minCount) {
      minCount = count;
      selected = name;
    }
  }

  return { name: selected, agentCount: minCount };
}

module.exports = { selectNode };
