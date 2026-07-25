// @ts-nocheck
const path = require("path");
const express = require("express");

const {
  createDirectory,
  deletePath,
  downloadPath,
  listFiles,
  movePath,
  normalizeRelativePath,
  readFile,
  rootsForAgent,
  writeFile,
} = require("../agentFiles");
const { buildMigrationManifestFromAgent, packMigrationBundle } = require("../agentMigrations");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireSession } = require("../middleware/auth");
const { findAgentForRequest } = require("../middleware/ownership");
const { createMutationFailureAuditMiddleware } = require("../auditLog");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("agent_files"));
// Runtime roots include provider credentials, gateway secrets, paired-device
// state, and session data. Scope the session guard to this router's paths so
// later /agents routers can still enforce their own API-key contracts.
router.use("/:id/files", requireSession);

/**
 * Load an agent only for its direct owner, responding with 404 when ownership
 * does not match so file routes never expose cross-workspace runtime contents.
 *
 * @param {Object} req - Express request containing agent and user identifiers.
 * @param {Object} res - Express response used for the not-found result.
 * @returns {Promise<Object|null>} Owned agent row, or `null` after responding.
 */
async function loadOwnedAgent(req, res) {
  const agent = await findAgentForRequest(req, req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  return agent;
}

function filenameFromHeader(req) {
  return String(req.get("x-file-name") || req.get("x-upload-filename") || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
}

// Agent export and filesystem reads

router.get(
  "/:id/export",
  requireSession,
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const manifest = await buildMigrationManifestFromAgent(agent, {
      userId: req.user.id,
    });
    const bundle = await packMigrationBundle(manifest);
    const filenameSeed = (agent.name || "nora-agent")
      .replace(/[^a-z0-9-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filenameSeed || "nora-agent"}.nora-migration.tgz"`,
    );
    res.send(bundle);
  }),
);

router.get(
  "/:id/files/roots",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;
    res.json({ roots: rootsForAgent(agent) });
  }),
);

router.get(
  "/:id/files/tree",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const payload = await listFiles(
      agent,
      req.query.root,
      typeof req.query.path === "string" ? req.query.path : "",
    );
    res.json(payload);
  }),
);

router.get(
  "/:id/files/content",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const payload = await readFile(
      agent,
      req.query.root,
      typeof req.query.path === "string" ? req.query.path : "",
    );
    res.json(payload);
  }),
);

router.get(
  "/:id/files/download",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const payload = await downloadPath(
      agent,
      req.query.root,
      typeof req.query.path === "string" ? req.query.path : "",
    );
    res.setHeader("Content-Type", payload.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
    res.send(Buffer.from(payload.contentBase64, "base64"));
  }),
);

// Filesystem mutations

router.put(
  "/:id/files/content",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const result = await writeFile(
      agent,
      req.body?.root,
      req.body?.path,
      req.body?.contentBase64 || "",
      Number.isInteger(req.body?.mode) ? req.body.mode : 0o644,
    );
    res.json(result);
  }),
);

router.post(
  "/:id/files/upload",
  express.raw({ type: "*/*", limit: "50mb" }),
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const filename = filenameFromHeader(req);
    if (!filename) {
      return res.status(400).json({ error: "A file name is required for uploads" });
    }

    const baseDirectory = normalizeRelativePath(
      typeof req.query.path === "string" ? req.query.path : "",
      { allowEmpty: true },
    );
    const relativePath = baseDirectory ? path.posix.join(baseDirectory, filename) : filename;

    const result = await writeFile(
      agent,
      req.query.root,
      relativePath,
      Buffer.from(req.body || Buffer.alloc(0)).toString("base64"),
    );
    res.json(result);
  }),
);

router.post(
  "/:id/files/mkdir",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const result = await createDirectory(agent, req.body?.root, req.body?.path);
    res.json(result);
  }),
);

router.post(
  "/:id/files/move",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const result = await movePath(agent, req.body?.root, req.body?.fromPath, req.body?.toPath);
    res.json(result);
  }),
);

router.delete(
  "/:id/files",
  asyncHandler(async (req, res) => {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;

    const result = await deletePath(agent, req.body?.root, req.body?.path);
    res.json(result);
  }),
);

module.exports = router;
