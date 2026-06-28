// @ts-nocheck
// Gateway host-port allocation — BYOC Phase B (B1).
//
// Replaces the collision-prone deterministic hash (19000 + id % 1000) that
// the docker adapter used to pick a published gateway port. That hash had no
// reservation and no collision detection, so two agents whose ids hashed to the
// same slot would fight over the port on a shared host. Here a port is reserved
// in `gateway_port_allocations` with a UNIQUE(host_key, port) constraint, picked
// atomically as the lowest free port in the range, scoped per host:
//   - host_key "local"      → the local Docker host (all local docker agents).
//   - host_key "remote:<id>" → a specific registered remote host.
// Allocation is idempotent per (agent, host) so redeploys keep the same port.

const db = require("./db");

const DEFAULT_RANGE_MIN = 19000;
const DEFAULT_RANGE_MAX = 19999;
const LOCAL_HOST_KEY = "local";
const MAX_RACE_RETRIES = 5;
// A purpose lets one agent reserve more than one published port on the SAME
// physical host (host_key). Port uniqueness stays per-host (UNIQUE(host_key,
// port)), so a second purpose never collides with the first on that machine.
//   - GATEWAY: the primary published port (OpenClaw gateway / Hermes runtime API).
//   - RUNTIME: the OpenClaw runtime sidecar API when the agent runs on a remote host.
//   - DASHBOARD: the Hermes dashboard UI port, published only for remote hosts.
const GATEWAY_PORT_PURPOSE = "gateway";
const RUNTIME_PORT_PURPOSE = "runtime";
const DASHBOARD_PORT_PURPOSE = "dashboard";

function normalizeHostKey(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return key || LOCAL_HOST_KEY;
}

function normalizePurpose(value) {
  const purpose = String(value || "")
    .trim()
    .toLowerCase();
  return purpose || GATEWAY_PORT_PURPOSE;
}

async function getGatewayPortAllocation(agentId) {
  if (!agentId) return null;
  try {
    const result = await db.query(
      "SELECT host_key, port FROM gateway_port_allocations WHERE agent_id = $1 LIMIT 1",
      [agentId],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === "42P01") return null; // table not migrated yet
    throw error;
  }
}

// Reserve (or reuse) a published gateway port for an agent on a given host.
// Returns the port number. Throws (statusCode 503) when the host's range is
// exhausted.
async function allocateGatewayPort({
  hostKey,
  agentId,
  purpose = GATEWAY_PORT_PURPOSE,
  rangeMin = DEFAULT_RANGE_MIN,
  rangeMax = DEFAULT_RANGE_MAX,
} = {}) {
  if (!agentId) throw new Error("agentId is required to allocate a gateway port");
  const key = normalizeHostKey(hostKey);
  const slot = normalizePurpose(purpose);

  // Idempotent per (agent, host, purpose): a redeploy keeps the same port, and a
  // second purpose on the same host gets its own row rather than reusing the first.
  const existing = await db.query(
    "SELECT port FROM gateway_port_allocations WHERE agent_id = $1 AND host_key = $2 AND purpose = $3",
    [agentId, key, slot],
  );
  if (existing.rows[0]) return existing.rows[0].port;

  for (let attempt = 0; attempt < MAX_RACE_RETRIES; attempt++) {
    try {
      // Claim the lowest free port for this host in one statement. The NOT EXISTS
      // scans ALL purposes on the host so a second purpose never lands on a port
      // already held by another, and UNIQUE(host_key, port) makes concurrent
      // claims race-safe: the loser hits a unique violation and retries.
      const result = await db.query(
        `INSERT INTO gateway_port_allocations (host_key, agent_id, port, purpose)
         SELECT $1, $2, candidate.port, $5
           FROM generate_series($3::integer, $4::integer) AS candidate(port)
          WHERE NOT EXISTS (
            SELECT 1 FROM gateway_port_allocations existing
             WHERE existing.host_key = $1 AND existing.port = candidate.port
          )
          ORDER BY candidate.port
          LIMIT 1
         RETURNING port`,
        [key, agentId, rangeMin, rangeMax, slot],
      );
      if (result.rows[0]) return result.rows[0].port;
      // No row inserted → every port in the range is taken on this host.
      const error = new Error(
        `No free gateway port available on ${key} (range ${rangeMin}-${rangeMax}).`,
      );
      error.statusCode = 503;
      throw error;
    } catch (error) {
      if (error?.code === "23505") continue; // unique_violation — lost the race, retry
      throw error;
    }
  }

  const error = new Error(`Could not allocate a gateway port on ${key} after retries.`);
  error.statusCode = 503;
  throw error;
}

// Release every allocation an agent holds (called on destroy). Idempotent.
async function releaseGatewayPort(agentId) {
  if (!agentId) return;
  try {
    await db.query("DELETE FROM gateway_port_allocations WHERE agent_id = $1", [agentId]);
  } catch (error) {
    if (error?.code === "42P01") return;
    throw error;
  }
}

module.exports = {
  LOCAL_HOST_KEY,
  DEFAULT_RANGE_MIN,
  DEFAULT_RANGE_MAX,
  GATEWAY_PORT_PURPOSE,
  RUNTIME_PORT_PURPOSE,
  DASHBOARD_PORT_PURPOSE,
  allocateGatewayPort,
  releaseGatewayPort,
  getGatewayPortAllocation,
};
