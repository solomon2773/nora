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
// Allocation is idempotent per (agent, host, purpose) so redeploys keep the
// same port while separate runtime surfaces receive distinct reservations.

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

// ── Normalization and range validation ──────────────────────────

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

/**
 * Resolve the configured allocation range inside the proxy's fixed 19000-19999
 * security envelope, rejecting invalid or reversed bounds.
 *
 * @param {Object} options - Explicit bounds or environment override.
 * @returns {Object} Validated minimum and maximum ports.
 */
function resolveGatewayPortRange({ rangeMin, rangeMax, env = process.env } = {}) {
  const parseBoundary = (value, fallback, label) => {
    if (value == null || String(value).trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < DEFAULT_RANGE_MIN || parsed > DEFAULT_RANGE_MAX) {
      throw new Error(
        `${label} must be an integer within ${DEFAULT_RANGE_MIN}-${DEFAULT_RANGE_MAX}.`,
      );
    }
    return parsed;
  };

  const resolvedMin = parseBoundary(
    rangeMin ?? env.DOCKER_AGENT_PORT_RANGE_MIN,
    DEFAULT_RANGE_MIN,
    "DOCKER_AGENT_PORT_RANGE_MIN",
  );
  const resolvedMax = parseBoundary(
    rangeMax ?? env.DOCKER_AGENT_PORT_RANGE_MAX,
    DEFAULT_RANGE_MAX,
    "DOCKER_AGENT_PORT_RANGE_MAX",
  );
  if (resolvedMin > resolvedMax) {
    throw new Error("DOCKER_AGENT_PORT_RANGE_MIN cannot exceed DOCKER_AGENT_PORT_RANGE_MAX.");
  }

  return { rangeMin: resolvedMin, rangeMax: resolvedMax };
}

function normalizeUnavailablePorts(value) {
  const entries = Array.isArray(value) ? value : value instanceof Set ? [...value] : [];
  return [
    ...new Set(
      entries
        .map((entry) => Number(entry))
        .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
    ),
  ].sort((a, b) => a - b);
}

function noFreePortError(hostKey, rangeMin, rangeMax) {
  const error = new Error(
    `No free gateway port available on ${hostKey} (range ${rangeMin}-${rangeMax}).`,
  );
  error.statusCode = 503;
  return error;
}

// ── Allocation operations ───────────────────────────────────────

/**
 * Read one of an agent's allocations without selecting a purpose. A missing
 * pre-migration table is treated as no allocation for rolling-upgrade
 * compatibility.
 *
 * @param {string} agentId - Agent whose reservation is requested.
 * @returns {Promise<Object|null>} Host/port allocation, or null when absent.
 */
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

/**
 * Reserve or reuse the lowest available host port for an agent and purpose.
 * Unique-constraint races retry; exhausted ranges fail with HTTP-style 503.
 *
 * @param {Object} options - Host, agent, purpose, range, and occupied ports.
 * @returns {Promise<number>} Persisted port reservation.
 */
async function allocateGatewayPort({
  hostKey,
  agentId,
  purpose = GATEWAY_PORT_PURPOSE,
  rangeMin,
  rangeMax,
  unavailablePorts = [],
} = {}) {
  if (!agentId) throw new Error("agentId is required to allocate a gateway port");
  const key = normalizeHostKey(hostKey);
  const slot = normalizePurpose(purpose);
  const resolvedRange = resolveGatewayPortRange({ rangeMin, rangeMax });
  const blockedPorts = normalizeUnavailablePorts(unavailablePorts);

  // Idempotent per (agent, host, purpose): a redeploy keeps the same port, and a
  // second purpose on the same host gets its own row rather than reusing the first.
  const existing = await db.query(
    "SELECT port FROM gateway_port_allocations WHERE agent_id = $1 AND host_key = $2 AND purpose = $3",
    [agentId, key, slot],
  );
  if (existing.rows[0]) {
    const existingPort = Number(existing.rows[0].port);
    if (!blockedPorts.includes(existingPort)) return existing.rows[0].port;
    return reallocateGatewayPort({
      hostKey: key,
      agentId,
      purpose: slot,
      previousPort: existingPort,
      rangeMin: resolvedRange.rangeMin,
      rangeMax: resolvedRange.rangeMax,
      unavailablePorts: blockedPorts,
    });
  }

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
          WHERE NOT (candidate.port = ANY($6::integer[]))
            AND NOT EXISTS (
            SELECT 1 FROM gateway_port_allocations existing
             WHERE existing.host_key = $1 AND existing.port = candidate.port
          )
          ORDER BY candidate.port
         LIMIT 1
         RETURNING port`,
        [key, agentId, resolvedRange.rangeMin, resolvedRange.rangeMax, slot, blockedPorts],
      );
      if (result.rows[0]) return result.rows[0].port;
      // No row inserted → every port in the range is taken on this host.
      throw noFreePortError(key, resolvedRange.rangeMin, resolvedRange.rangeMax);
    } catch (error) {
      if (error?.code === "23505") continue; // unique_violation — lost the race, retry
      throw error;
    }
  }

  const error = new Error(`Could not allocate a gateway port on ${key} after retries.`);
  error.statusCode = 503;
  throw error;
}

/**
 * Compare-and-swap an occupied reservation to another free port while preserving
 * its row. Concurrent same-agent moves are accepted after a refreshed lookup.
 *
 * @param {Object} options - Reservation identity, prior port, range, and occupied
 * ports.
 * @returns {Promise<number>} Replacement port reservation.
 */
async function reallocateGatewayPort({
  hostKey,
  agentId,
  purpose = GATEWAY_PORT_PURPOSE,
  previousPort,
  rangeMin,
  rangeMax,
  unavailablePorts = [],
} = {}) {
  if (!agentId) throw new Error("agentId is required to reallocate a gateway port");
  const key = normalizeHostKey(hostKey);
  const slot = normalizePurpose(purpose);
  const resolvedRange = resolveGatewayPortRange({ rangeMin, rangeMax });
  const blockedPorts = normalizeUnavailablePorts([
    ...normalizeUnavailablePorts(unavailablePorts),
    previousPort,
  ]);

  const existing = await db.query(
    "SELECT port FROM gateway_port_allocations WHERE agent_id = $1 AND host_key = $2 AND purpose = $3",
    [agentId, key, slot],
  );
  if (!existing.rows[0]) {
    return allocateGatewayPort({
      hostKey: key,
      agentId,
      purpose: slot,
      rangeMin: resolvedRange.rangeMin,
      rangeMax: resolvedRange.rangeMax,
      unavailablePorts: blockedPorts,
    });
  }

  const currentPort = Number(existing.rows[0].port);
  if (!blockedPorts.includes(currentPort)) return existing.rows[0].port;

  for (let attempt = 0; attempt < MAX_RACE_RETRIES; attempt++) {
    try {
      const result = await db.query(
        `WITH candidate AS (
           SELECT candidate.port
             FROM generate_series($4::integer, $5::integer) AS candidate(port)
            WHERE NOT (candidate.port = ANY($6::integer[]))
              AND NOT EXISTS (
                SELECT 1 FROM gateway_port_allocations occupied
                 WHERE occupied.host_key = $1 AND occupied.port = candidate.port
              )
            ORDER BY candidate.port
            LIMIT 1
         )
         UPDATE gateway_port_allocations allocation
            SET port = candidate.port
           FROM candidate
          WHERE allocation.host_key = $1
            AND allocation.agent_id = $2
            AND allocation.purpose = $3
            AND allocation.port = $7
         RETURNING allocation.port`,
        [
          key,
          agentId,
          slot,
          resolvedRange.rangeMin,
          resolvedRange.rangeMax,
          blockedPorts,
          currentPort,
        ],
      );
      if (result.rows[0]) return result.rows[0].port;

      // Another same-agent caller may have moved the row after our SELECT but
      // before this compare-and-swap UPDATE. Treat its valid replacement as
      // success instead of misreporting the whole range as exhausted.
      const refreshed = await db.query(
        "SELECT port FROM gateway_port_allocations WHERE agent_id = $1 AND host_key = $2 AND purpose = $3",
        [agentId, key, slot],
      );
      const refreshedPort = Number(refreshed.rows[0]?.port);
      if (Number.isInteger(refreshedPort) && !blockedPorts.includes(refreshedPort)) {
        return refreshed.rows[0].port;
      }
      throw noFreePortError(key, resolvedRange.rangeMin, resolvedRange.rangeMax);
    } catch (error) {
      if (error?.code === "23505") continue;
      throw error;
    }
  }

  const error = new Error(`Could not reallocate a gateway port on ${key} after retries.`);
  error.statusCode = 503;
  throw error;
}

/**
 * Idempotently release every purpose allocation held by an agent. A missing
 * pre-migration table is ignored for rolling-upgrade compatibility.
 *
 * @param {string} agentId - Agent whose reservations should be released.
 * @returns {Promise<void>}
 */
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
  reallocateGatewayPort,
  releaseGatewayPort,
  getGatewayPortAllocation,
  resolveGatewayPortRange,
};
