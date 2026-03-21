const express = require("express");
const db = require("../db");
const monitoring = require("../monitoring");
const marketplace = require("../marketplace");
const { getDLQJobs, retryDLQJob } = require("../redisQueue");
const { requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

// All admin routes require admin role
router.use(requireAdmin);

router.get("/stats", asyncHandler(async (req, res) => {
  res.json(await monitoring.getMetrics());
}));

router.get("/users", async (req, res) => {
  try {
    const result = await db.query("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body;
    if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role" });
    const result = await db.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role",
      [role, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/marketplace/:id", async (req, res) => {
  try {
    await marketplace.deleteListing(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/audit", asyncHandler(async (req, res) => {
  res.json(await monitoring.getRecentEvents(100));
}));

router.get("/dlq", asyncHandler(async (req, res) => {
  const jobs = await getDLQJobs(0, 50);
  res.json(jobs.map(j => ({
    id: j.id,
    name: j.name,
    data: j.data,
    attemptsMade: j.attemptsMade,
    failedReason: j.failedReason,
    timestamp: j.timestamp,
    finishedOn: j.finishedOn,
  })));
}));

router.post("/dlq/:jobId/retry", asyncHandler(async (req, res) => {
  const result = await retryDLQJob(req.params.jobId);
  res.json(result);
}));

module.exports = router;
