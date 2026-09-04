// @ts-nocheck
const express = require("express");
const db = require("../db");
const { getSkillDetail, listSkills, searchSkills } = require("../hermesSkillsClient");
const {
  addHermesSkillJob,
  findInFlightHermesSkillJob,
  getHermesSkillJobStatus,
  hermesSkillsQueue,
} = require("../redisQueue");
const { runContainerCommand } = require("../authSync");
const { requireScope, scopeByMethod } = require("../middleware/auth");
const {
  findAccessibleAgentForRequest,
  isRemoteDockerAgent,
  requireApiKeyAgentScope,
} = require("../middleware/ownership");
const {
  HERMES_SKILLS_LOCK_FILE,
  installedEntriesFromHermesLockData,
  isReservedHermesSkillName,
  isValidHermesSkillName,
  mergeHermesSkillState,
} = require("../../agent-runtime/lib/hermesSkillsReconciliation");

const router = express.Router();
router.use(
  "/agents/:agentId/skills",
  scopeByMethod("agents:read", "agents:write"),
  requireApiKeyAgentScope("agentId"),
);

// Same base64 transport as the worker's readInstalledHermesSkills: exec
// streams can mangle raw JSON, and base64 survives them unchanged.
const HERMES_SKILLS_EMPTY_LOCK_B64 = Buffer.from('{"version":1,"installed":{}}').toString("base64");
const HERMES_SKILLS_LOCK_READ_COMMAND =
  `if [ -f ${JSON.stringify(HERMES_SKILLS_LOCK_FILE)} ]; then ` +
  `base64 < ${JSON.stringify(HERMES_SKILLS_LOCK_FILE)} | tr -d '\\n'; ` +
  `else printf '${HERMES_SKILLS_EMPTY_LOCK_B64}'; fi`;

const IN_FLIGHT_JOB_STATES = ["active", "waiting", "waiting-children", "delayed", "prioritized"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIBRARY_COLUMNS = "id, ref, name, description, added_by_user_id, created_at";

function parseLimit(value, fallback = 50) {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(50, Math.max(1, parsed));
}

function sendHermesSkillsError(res, error) {
  if (error?.statusCode === 404) {
    return res.status(404).json({
      error: "skill_not_found",
      message: error.message || "No skill found with ref: unknown",
    });
  }

  if (error?.statusCode === 400 && error?.code === "missing_query") {
    return res.status(400).json({
      error: "missing_query",
      message: error.message || "q is required.",
    });
  }

  if (error?.statusCode === 502 || error?.code === "hermes_registry_unavailable") {
    return res.status(502).json({
      error: "hermes_registry_unavailable",
      message: "Could not reach the Hermes skills registry.",
    });
  }

  const statusCode = error?.statusCode || 500;
  return res.status(statusCode).json({
    error: error?.code || error?.message || "Unexpected error",
    message: error?.message || "Unexpected error",
  });
}

/**
 * Require a Hermes agent with recorded running/warning status and a container
 * ID; this check does not probe the runtime.
 *
 * @param {Object|null} agent - Agent selected for a Hermes skill operation.
 * @returns {void}
 */
function validateHermesMutableAgent(agent) {
  if (!agent) {
    const error = new Error("agent_not_found");
    error.statusCode = 404;
    error.code = "agent_not_found";
    throw error;
  }

  if (agent.runtime_family !== "hermes") {
    const error = new Error("Hermes skills are only available for Hermes agents.");
    error.statusCode = 409;
    error.code = "unsupported_runtime";
    throw error;
  }

  if (agent.status !== "running" && agent.status !== "warning") {
    const error = new Error("Start the agent before managing Hermes skills.");
    error.statusCode = 409;
    error.code = "container_not_running";
    throw error;
  }

  if (!agent.container_id) {
    const error = new Error("Start the agent before managing Hermes skills.");
    error.statusCode = 409;
    error.code = "container_not_running";
    throw error;
  }
}

function sendHermesSkillsMutationError(res, error) {
  if (error?.statusCode === 404 || error?.code === "agent_not_found") {
    return res.status(404).json({ error: "agent_not_found" });
  }

  if (error?.code === "container_not_running") {
    return res.status(409).json({
      error: "container_not_running",
      message: "Start the agent before managing Hermes skills.",
    });
  }

  if (error?.code === "unsupported_runtime") {
    return res.status(409).json({
      error: "unsupported_runtime",
      message: "Hermes skills are only available for Hermes agents.",
    });
  }

  return res.status(error?.statusCode || 500).json({
    error: error?.code || "hermes_skills_mutation_failed",
    message: error?.message || "Unexpected error",
  });
}

/**
 * Validate a request-supplied skill name at the route boundary. The name is
 * the reconciliation identity and later reaches shell commands in the worker,
 * so reject invalid charsets and Nora-managed reserved names up front.
 *
 * @param {Object} res - Express response used to send the 400.
 * @param {string} name - Requested skill name.
 * @param {string} action - Verb for the reserved-name message ("installed"...).
 * @returns {boolean} `true` when a 400 response was sent.
 */
function sendSkillNameValidationError(res, name, action) {
  if (!isValidHermesSkillName(name)) {
    res.status(400).json({
      error: "invalid_name",
      message:
        "name is required and must start with a letter or digit and contain only letters, digits, dots, hyphens, or underscores.",
    });
    return true;
  }

  if (isReservedHermesSkillName(name)) {
    res.status(400).json({
      error: "reserved_skill",
      message: `Skill "${name}" is managed by Nora and cannot be ${action}.`,
    });
    return true;
  }

  return false;
}

/**
 * Load an agent authorized for the current session or scoped API key request.
 *
 * The Skills panel is one sub-tab of the Hermes WebUI, so it resolves access the
 * same way its siblings do (routes/agents.ts → loadHermesUiAgent): the agent's
 * owner, or a member of a workspace the agent is shared into who meets the
 * route's minimum role. Reads take `viewer`, mutations take `editor`. An
 * insufficient role resolves to no agent, which the callers surface as
 * `agent_not_found` — matching the sibling routes rather than advertising the
 * role gap. API-key requests keep their exact workspace binding via
 * findAccessibleAgentForRequest's key branch.
 *
 * @param {Object} req - Request carrying session or API-key authorization context.
 * @param {string} agentId - Agent to load.
 * @param {string} [requiredRole="viewer"] - Minimum workspace role.
 * @returns {Promise<Object|null>} Request-accessible agent row, or `null`.
 */
async function loadAccessibleAgent(req, agentId, requiredRole = "viewer") {
  return findAccessibleAgentForRequest(req, agentId, requiredRole);
}

/**
 * Collect in-flight skill jobs for one agent so merged skill state can show
 * pending_install / pending_delete transitions.
 *
 * @param {string} agentId - Agent whose queue jobs should be surfaced.
 * @returns {Promise<Array<{name: string, operation: string}>>} Pending jobs.
 */
async function listPendingHermesSkillJobs(agentId) {
  const jobs = await hermesSkillsQueue.getJobs(IN_FLIGHT_JOB_STATES);
  const normalizedAgentId = String(agentId);
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => String(job?.data?.agentId || "") === normalizedAgentId)
    .map((job) => ({
      name: String(job?.data?.name || "").trim(),
      operation: String(job?.data?.operation || "").trim() || "install",
    }))
    .filter((entry) => entry.name);
}

// Public registry queries

router.get("/skills", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50);
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.trim()
        ? req.query.cursor.trim()
        : null;
    res.json(await listSkills({ limit, cursor }));
  } catch (error) {
    sendHermesSkillsError(res, error);
  }
});

router.get("/skills/search", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.status(400).json({
        error: "missing_query",
        message: "q is required.",
      });
    }

    const limit = parseLimit(req.query.limit, 50);
    res.json(await searchSkills({ q, limit }));
  } catch (error) {
    sendHermesSkillsError(res, error);
  }
});

// Detail takes the ref as a query parameter because Hermes registry
// identifiers contain slashes (e.g. official/security/1password).
router.get("/skills/detail", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref.trim() : "";
    if (!ref) {
      return res.status(404).json({
        error: "skill_not_found",
        message: "No skill found with ref: unknown",
      });
    }

    res.json(await getSkillDetail(ref));
  } catch (error) {
    sendHermesSkillsError(res, error);
  }
});

// Authorized agent skill state and mutations

router.get("/agents/:agentId/skills", async (req, res) => {
  try {
    const agent = await loadAccessibleAgent(req, req.params.agentId);
    validateHermesMutableAgent(agent);
    const { output } = await runContainerCommand(agent, HERMES_SKILLS_LOCK_READ_COMMAND);
    const decoded = Buffer.from(
      String(output || HERMES_SKILLS_EMPTY_LOCK_B64).trim(),
      "base64",
    ).toString("utf8");
    const installedSkills = installedEntriesFromHermesLockData(
      JSON.parse(decoded || '{"version":1,"installed":{}}'),
    );
    const pendingJobs = await listPendingHermesSkillJobs(agent.id);
    return res.json({
      skills: mergeHermesSkillState(
        Array.isArray(agent.hermes_skills) ? agent.hermes_skills : [],
        installedSkills,
        pendingJobs,
      ),
    });
  } catch (error) {
    return sendHermesSkillsMutationError(res, error);
  }
});

router.post("/agents/:agentId/skills/install", async (req, res) => {
  try {
    const agent = await loadAccessibleAgent(req, req.params.agentId, "editor");
    validateHermesMutableAgent(agent);
    const ref = typeof req.body?.ref === "string" ? req.body.ref.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!ref) {
      return res.status(400).json({
        error: "missing_ref",
        message: "ref is required.",
      });
    }
    if (sendSkillNameValidationError(res, name, "installed")) {
      return;
    }

    const existingJob = await findInFlightHermesSkillJob(agent.id, name);
    if (existingJob) {
      const existingStatus = await getHermesSkillJobStatus(existingJob.id);
      if (existingStatus?.operation === "delete") {
        return res.status(409).json({
          error: "conflicting_job",
          message: "A Hermes skill delete job is already in progress for this skill.",
          jobId: String(existingJob.id),
          operation: "delete",
        });
      }
      return res.status(202).json({
        jobId: String(existingJob.id),
        agentId: agent.id,
        name,
        operation: "install",
        status: existingStatus?.status || "pending",
      });
    }

    const job = await addHermesSkillJob({
      agentId: agent.id,
      name,
      ref,
      operation: "install",
      skillEntry: {
        source: "hermes-hub",
        ref,
        name,
        installMode: "cli",
        installedAt: new Date().toISOString(),
      },
      persistOnSuccess: true,
    });

    return res.status(202).json({
      jobId: String(job.id),
      agentId: agent.id,
      name,
      operation: "install",
      status: "pending",
    });
  } catch (error) {
    return sendHermesSkillsMutationError(res, error);
  }
});

router.post("/agents/:agentId/skills/delete", async (req, res) => {
  try {
    const agent = await loadAccessibleAgent(req, req.params.agentId, "editor");
    validateHermesMutableAgent(agent);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (sendSkillNameValidationError(res, name, "removed")) {
      return;
    }

    const existingJob = await findInFlightHermesSkillJob(agent.id, name);
    if (existingJob) {
      const existingStatus = await getHermesSkillJobStatus(existingJob.id);
      if (existingStatus?.operation === "delete") {
        return res.status(202).json({
          jobId: String(existingJob.id),
          agentId: agent.id,
          name,
          operation: "delete",
          status: existingStatus?.status || "pending",
        });
      }
      return res.status(409).json({
        error: "conflicting_job",
        message: "A Hermes skill install job is already in progress for this skill.",
        jobId: String(existingJob.id),
        operation: "install",
      });
    }

    const job = await addHermesSkillJob({
      agentId: agent.id,
      name,
      operation: "delete",
      removeSavedEntryOnSuccess: true,
    });

    return res.status(202).json({
      jobId: String(job.id),
      agentId: agent.id,
      name,
      operation: "delete",
      status: "pending",
    });
  } catch (error) {
    return sendHermesSkillsMutationError(res, error);
  }
});

// Request-scoped asynchronous job status

router.get("/jobs/:jobId", requireScope("agents:read"), async (req, res) => {
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId.trim() : "";
  if (!jobId) {
    return res.status(404).json({ error: "job_not_found" });
  }

  const status = await getHermesSkillJobStatus(jobId);
  if (!status) {
    return res.status(404).json({ error: "job_not_found" });
  }

  let agent;
  try {
    agent = await loadAccessibleAgent(req, status.agentId);
  } catch (error) {
    if (error?.statusCode === 403 || error?.code === "session_required") {
      return res.status(404).json({ error: "job_not_found" });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!agent || (req.apiKey && isRemoteDockerAgent(agent))) {
    return res.status(404).json({ error: "job_not_found" });
  }

  return res.json(status);
});

// Skills Library — instance-curated pinned refs. Purely a UX curation layer:
// agents and bundles store full skill entries, never library references, so
// any authed user (session or workspace API key) may add or remove pins.

function serializeLibraryEntry(row) {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    description: row.description || "",
    addedByUserId: row.added_by_user_id || null,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null,
  };
}

function sendLibraryError(res, error) {
  return res.status(error?.statusCode || 500).json({
    error: error?.code || "hermes_skills_library_failed",
    message: error?.message || "Unexpected error",
  });
}

router.get("/library", async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT ${LIBRARY_COLUMNS} FROM hermes_skills_library ORDER BY created_at DESC, ref ASC`,
    );
    return res.json({ skills: result.rows.map((row) => serializeLibraryEntry(row)) });
  } catch (error) {
    return sendLibraryError(res, error);
  }
});

router.post("/library", async (req, res) => {
  try {
    const ref = typeof req.body?.ref === "string" ? req.body.ref.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description =
      typeof req.body?.description === "string" ? req.body.description.trim() : "";
    if (!ref) {
      return res.status(400).json({
        error: "missing_ref",
        message: "ref is required.",
      });
    }
    if (sendSkillNameValidationError(res, name, "added to the library")) {
      return;
    }

    // Insert-or-return-existing keyed on ref: DO NOTHING (rather than an
    // update) keeps a re-add from clobbering the original name/description.
    const inserted = await db.query(
      `INSERT INTO hermes_skills_library (ref, name, description, added_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ref) DO NOTHING
         RETURNING ${LIBRARY_COLUMNS}`,
      [ref, name, description, req.user?.id || null],
    );
    if (inserted.rows[0]) {
      return res.status(201).json(serializeLibraryEntry(inserted.rows[0]));
    }

    const existing = await db.query(
      `SELECT ${LIBRARY_COLUMNS} FROM hermes_skills_library WHERE ref = $1 LIMIT 1`,
      [ref],
    );
    if (existing.rows[0]) {
      return res.status(200).json(serializeLibraryEntry(existing.rows[0]));
    }
    // The conflicting row vanished between the two statements; surface it as a
    // retryable failure rather than pretending an entry exists.
    return sendLibraryError(res, new Error("Library entry changed concurrently; retry."));
  } catch (error) {
    return sendLibraryError(res, error);
  }
});

router.delete("/library/:id", async (req, res) => {
  try {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!UUID_RE.test(id)) {
      return res.status(404).json({ error: "library_entry_not_found" });
    }

    const result = await db.query("DELETE FROM hermes_skills_library WHERE id = $1 RETURNING id", [
      id,
    ]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: "library_entry_not_found" });
    }
    return res.status(204).send();
  } catch (error) {
    return sendLibraryError(res, error);
  }
});

module.exports = router;
