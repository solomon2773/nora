// @ts-nocheck
const express = require("express");
const { getSkillDetail, listSkills, searchSkills } = require("../clawhubClient");
const {
  addClawhubInstallJob,
  findInFlightClawhubInstallJob,
  getClawhubInstallJobStatus,
} = require("../redisQueue");
const db = require("../db");
const { runContainerCommand } = require("../authSync");

const router = express.Router();
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

function validateInstallableAgent(agent) {
  if (!agent) {
    const error = new Error("agent_not_found");
    error.statusCode = 404;
    error.code = "agent_not_found";
    throw error;
  }

  if (agent.backend_type !== "docker" || agent.runtime_family !== "openclaw") {
    const error = new Error(
      "ClawHub installs are only available for Docker-backed OpenClaw agents.",
    );
    error.statusCode = 409;
    error.code = "unsupported_runtime";
    throw error;
  }

  if (agent.status !== "running" && agent.status !== "warning") {
    const error = new Error("Start the agent before installing skills.");
    error.statusCode = 409;
    error.code = "container_not_running";
    throw error;
  }

  if (!agent.container_id) {
    const error = new Error("Start the agent before installing skills.");
    error.statusCode = 409;
    error.code = "container_not_running";
    throw error;
  }
}

function normalizeSavedSkillEntry(slug, input = {}) {
  const installSlug = typeof slug === "string" ? slug.trim() : "";
  if (!installSlug) return null;

  const author = typeof input.author === "string" ? input.author.trim() : "";
  const pagePath =
    typeof input.pagePath === "string" && input.pagePath.trim()
      ? input.pagePath.trim()
      : author
        ? `${author}/${installSlug}`
        : installSlug;
  const installedAtRaw = typeof input.installedAt === "string" ? input.installedAt.trim() : "";
  const installedAt =
    installedAtRaw && !Number.isNaN(new Date(installedAtRaw).getTime())
      ? new Date(installedAtRaw).toISOString()
      : new Date().toISOString();

  return {
    source: "clawhub",
    installSlug,
    author,
    pagePath,
    installedAt,
  };
}

function sendInstallError(res, error) {
  if (error?.statusCode === 404 || error?.code === "agent_not_found") {
    return res.status(404).json({ error: "agent_not_found" });
  }

  if (error?.code === "container_not_running") {
    return res.status(409).json({
      error: "container_not_running",
      message: "Start the agent before installing skills.",
    });
  }

  if (error?.code === "unsupported_runtime") {
    return res.status(409).json({
      error: "unsupported_runtime",
      message: "ClawHub installs are only available for Docker-backed OpenClaw agents.",
    });
  }

  if (error?.code === "npm_unavailable") {
    return res.status(422).json({
      error: "npm_unavailable",
      message: "The clawhub CLI could not be installed. Ensure Node.js is in your base image.",
    });
  }

  return res.status(error?.statusCode || 500).json({
    error: error?.code || "install_failed",
    message: error?.message || "Unexpected error",
  });
}

async function loadOwnedAgent(agentId, userId) {
  const result = await db.query(
    `SELECT id, user_id, name, status, host, container_id, backend_type, runtime_family,
            deploy_target, sandbox_profile, clawhub_skills
       FROM agents
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [agentId, userId],
  );
  return result.rows[0] || null;
}

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

router.get("/agents/:agentId/skills", async (req, res) => {
  try {
    const agent = await loadOwnedAgent(req.params.agentId, req.user.id);
    validateInstallableAgent(agent);
    const { output } = await runContainerCommand(
      agent,
      `if [ -f ${JSON.stringify(CLAWHUB_LOCKFILE_PATH)} ]; then cat ${JSON.stringify(
        CLAWHUB_LOCKFILE_PATH,
      )}; else printf '{"version":1,"skills":{}}'; fi`,
    );
    const parsed = JSON.parse(output || '{"version":1,"skills":{}}');
    return res.json({
      skills: normalizeInstalledSkillsLockfile(parsed),
    });
  } catch (error) {
    return sendInstallError(res, error);
  }
});

router.post("/agents/:agentId/skills/:slug/install", async (req, res) => {
  try {
    const agent = await loadOwnedAgent(req.params.agentId, req.user.id);
    validateInstallableAgent(agent);
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

    const existingJob = await findInFlightClawhubInstallJob(agent.id, slug);
    if (existingJob) {
      const existingStatus = await getClawhubInstallJobStatus(existingJob.id);
      return res.status(202).json({
        jobId: String(existingJob.id),
        agentId: agent.id,
        slug,
        status: existingStatus?.status || "pending",
      });
    }

    const job = await addClawhubInstallJob({
      agentId: agent.id,
      slug,
      skillEntry,
      persistOnSuccess: !existingSaved,
    });

    return res.status(202).json({
      jobId: String(job.id),
      agentId: agent.id,
      slug,
      status: "pending",
    });
  } catch (error) {
    return sendInstallError(res, error);
  }
});

router.get("/jobs/:jobId", async (req, res) => {
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId.trim() : "";
  if (!jobId) {
    return res.status(404).json({ error: "job_not_found" });
  }

  const status = await getClawhubInstallJobStatus(jobId);
  if (!status) {
    return res.status(404).json({ error: "job_not_found" });
  }

  return res.json(status);
});

module.exports = router;
