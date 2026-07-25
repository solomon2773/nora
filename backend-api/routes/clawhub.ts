// @ts-nocheck
const express = require("express");
const { getSkillDetail, listSkills, searchSkills } = require("../clawhubClient");
const { addClawhubJob, findInFlightClawhubJob, getClawhubJobStatus } = require("../redisQueue");
const { runContainerCommand } = require("../authSync");
const { requireScope, scopeByMethod } = require("../middleware/auth");
const {
  findAgentForRequest,
  isRemoteDockerAgent,
  requireApiKeyAgentScope,
} = require("../middleware/ownership");
const {
  mergeClawhubSkillState,
  normalizeSavedSkillEntry,
} = require("../../agent-runtime/lib/clawhubReconciliation");

const router = express.Router();
router.use(
  "/agents/:agentId/skills",
  scopeByMethod("agents:read", "agents:write"),
  requireApiKeyAgentScope("agentId"),
);
const OPENCLAW_WORKSPACE_PATH = "/root/.openclaw/workspace";
const CLAWHUB_LOCKFILE_PATH = `${OPENCLAW_WORKSPACE_PATH}/.clawhub/lock.json`;
const CLAWHUB_INSTALL_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.CLAWHUB_INSTALL_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : 300000;
})();

function parseLimit(value, fallback = 20) {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(50, Math.max(1, parsed));
}

function sendClawhubError(res, error) {
  if (error?.statusCode === 404) {
    return res.status(404).json({
      error: "skill_not_found",
      message: error.message || "No skill found with slug: unknown",
    });
  }

  if (error?.statusCode === 400 && error?.code === "missing_query") {
    return res.status(400).json({
      error: "missing_query",
      message: error.message || "q is required.",
    });
  }

  if (error?.statusCode === 502 || error?.code === "clawhub_unavailable") {
    return res.status(502).json({
      error: "clawhub_unavailable",
      message: "Could not reach ClawHub registry.",
    });
  }

  const statusCode = error?.statusCode || 500;
  return res.status(statusCode).json({
    error: error?.code || error?.message || "Unexpected error",
    message: error?.message || "Unexpected error",
  });
}

function normalizeInstalledSkillsLockfile(parsed) {
  const skills = parsed?.skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) {
    return [];
  }

  return Object.entries(skills)
    .map(([slug, entry]) => ({
      slug,
      version:
        entry && typeof entry === "object" && typeof entry.version === "string"
          ? entry.version
          : "",
    }))
    .filter((entry) => entry.slug && entry.version);
}

/**
 * Require an OpenClaw agent with recorded running/warning status and a container
 * ID; this check does not probe the runtime.
 *
 * @param {Object|null} agent - Agent selected for a ClawHub operation.
 * @returns {void}
 */
function validateClawhubMutableAgent(agent) {
  if (!agent) {
    const error = new Error("agent_not_found");
    error.statusCode = 404;
    error.code = "agent_not_found";
    throw error;
  }

  if (agent.runtime_family !== "openclaw") {
    const error = new Error("ClawHub mutations are only available for OpenClaw agents.");
    error.statusCode = 409;
    error.code = "unsupported_runtime";
    throw error;
  }

  if (agent.status !== "running" && agent.status !== "warning") {
    const error = new Error("Start the agent before managing ClawHub skills.");
    error.statusCode = 409;
    error.code = "container_not_running";
    throw error;
  }

  if (!agent.container_id) {
    const error = new Error("Start the agent before managing ClawHub skills.");
    error.statusCode = 409;
    error.code = "container_not_running";
    throw error;
  }
}

function sendClawhubMutationError(res, error) {
  if (error?.statusCode === 404 || error?.code === "agent_not_found") {
    return res.status(404).json({ error: "agent_not_found" });
  }

  if (error?.code === "container_not_running") {
    return res.status(409).json({
      error: "container_not_running",
      message: "Start the agent before managing ClawHub skills.",
    });
  }

  if (error?.code === "unsupported_runtime") {
    return res.status(409).json({
      error: "unsupported_runtime",
      message: "ClawHub mutations are only available for OpenClaw agents.",
    });
  }

  if (error?.code === "npm_unavailable") {
    return res.status(422).json({
      error: "npm_unavailable",
      message: "The clawhub CLI could not be installed. Ensure Node.js is in your base image.",
    });
  }

  return res.status(error?.statusCode || 500).json({
    error: error?.code || "clawhub_mutation_failed",
    message: error?.message || "Unexpected error",
  });
}

/**
 * Load an agent authorized for the current session or scoped API key request.
 *
 * @param {Object} req - Request carrying session or API-key authorization context.
 * @param {string} agentId - Agent to load.
 * @returns {Promise<Object|null>} Request-accessible agent row, or `null`.
 */
async function loadOwnedAgent(req, agentId) {
  return findAgentForRequest(req, agentId);
}

// Public registry queries

router.get("/skills", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 20);
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.trim()
        ? req.query.cursor.trim()
        : null;
    res.json(await listSkills({ limit, cursor }));
  } catch (error) {
    sendClawhubError(res, error);
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

    const limit = parseLimit(req.query.limit, 20);
    res.json(await searchSkills({ q, limit }));
  } catch (error) {
    sendClawhubError(res, error);
  }
});

router.get("/skills/:slug", async (req, res) => {
  try {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      return res.status(404).json({
        error: "skill_not_found",
        message: "No skill found with slug: unknown",
      });
    }

    res.json(await getSkillDetail(slug));
  } catch (error) {
    sendClawhubError(res, error);
  }
});

// Authorized agent skill state and mutations

router.get("/agents/:agentId/skills", async (req, res) => {
  try {
    const agent = await loadOwnedAgent(req, req.params.agentId);
    validateClawhubMutableAgent(agent);
    const { output } = await runContainerCommand(
      agent,
      `if [ -f ${JSON.stringify(CLAWHUB_LOCKFILE_PATH)} ]; then cat ${JSON.stringify(
        CLAWHUB_LOCKFILE_PATH,
      )}; else printf '{"version":1,"skills":{}}'; fi`,
    );
    const parsed = JSON.parse(output || '{"version":1,"skills":{}}');
    return res.json({
      skills: mergeClawhubSkillState(
        Array.isArray(agent.clawhub_skills) ? agent.clawhub_skills : [],
        normalizeInstalledSkillsLockfile(parsed),
      ),
    });
  } catch (error) {
    return sendClawhubMutationError(res, error);
  }
});

router.post("/agents/:agentId/skills/:slug/install", async (req, res) => {
  try {
    const agent = await loadOwnedAgent(req, req.params.agentId);
    validateClawhubMutableAgent(agent);
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      return res.status(404).json({
        error: "skill_not_found",
        message: "No skill found with slug: unknown",
      });
    }

    const skillEntry = normalizeSavedSkillEntry(slug, req.body || {});
    const existingSavedSkills = Array.isArray(agent.clawhub_skills) ? agent.clawhub_skills : [];
    const existingSaved = existingSavedSkills.some((entry) => {
      const savedSlug = typeof entry?.installSlug === "string" ? entry.installSlug : entry?.slug;
      return String(savedSlug || "").trim() === slug;
    });

    try {
      await runContainerCommand(
        agent,
        "if command -v clawhub >/dev/null 2>&1; then exit 0; fi; " +
          "if ! command -v npm >/dev/null 2>&1; then exit 42; fi; " +
          "npm install -g clawhub",
        { timeout: CLAWHUB_INSTALL_TIMEOUT_MS },
      );
    } catch (error) {
      if (String(error?.message || "").includes("exit 42")) {
        const npmError = new Error(
          "The clawhub CLI could not be installed. Ensure Node.js is in your base image.",
        );
        npmError.statusCode = 422;
        npmError.code = "npm_unavailable";
        throw npmError;
      }
      throw error;
    }

    const existingJob = await findInFlightClawhubJob(agent.id, slug);
    if (existingJob) {
      const existingStatus = await getClawhubJobStatus(existingJob.id);
      if (existingStatus?.operation === "delete") {
        return res.status(409).json({
          error: "conflicting_job",
          message: "A ClawHub delete job is already in progress for this skill.",
          jobId: String(existingJob.id),
          operation: "delete",
        });
      }
      return res.status(202).json({
        jobId: String(existingJob.id),
        agentId: agent.id,
        slug,
        operation: "install",
        status: existingStatus?.status || "pending",
      });
    }

    const job = await addClawhubJob({
      agentId: agent.id,
      slug,
      operation: "install",
      skillEntry,
      persistOnSuccess: !existingSaved,
    });

    return res.status(202).json({
      jobId: String(job.id),
      agentId: agent.id,
      slug,
      operation: "install",
      status: "pending",
    });
  } catch (error) {
    return sendClawhubMutationError(res, error);
  }
});

router.post("/agents/:agentId/skills/:slug/delete", async (req, res) => {
  try {
    const agent = await loadOwnedAgent(req, req.params.agentId);
    validateClawhubMutableAgent(agent);
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) {
      return res.status(404).json({
        error: "skill_not_found",
        message: "No skill found with slug: unknown",
      });
    }

    const skillEntry = normalizeSavedSkillEntry(slug, req.body || {});
    const existingJob = await findInFlightClawhubJob(agent.id, slug);
    if (existingJob) {
      const existingStatus = await getClawhubJobStatus(existingJob.id);
      if (existingStatus?.operation === "delete") {
        return res.status(202).json({
          jobId: String(existingJob.id),
          agentId: agent.id,
          slug,
          operation: "delete",
          status: existingStatus?.status || "pending",
        });
      }
      return res.status(409).json({
        error: "conflicting_job",
        message: "A ClawHub install job is already in progress for this skill.",
        jobId: String(existingJob.id),
        operation: "install",
      });
    }

    const job = await addClawhubJob({
      agentId: agent.id,
      slug,
      operation: "delete",
      skillEntry,
      removeSavedEntryOnSuccess: true,
    });

    return res.status(202).json({
      jobId: String(job.id),
      agentId: agent.id,
      slug,
      operation: "delete",
      status: "pending",
    });
  } catch (error) {
    return sendClawhubMutationError(res, error);
  }
});

// Request-scoped asynchronous job status

router.get("/jobs/:jobId", requireScope("agents:read"), async (req, res) => {
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId.trim() : "";
  if (!jobId) {
    return res.status(404).json({ error: "job_not_found" });
  }

  const status = await getClawhubJobStatus(jobId);
  if (!status) {
    return res.status(404).json({ error: "job_not_found" });
  }

  let agent;
  try {
    agent = await loadOwnedAgent(req, status.agentId);
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

module.exports = router;
