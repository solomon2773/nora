const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (!email || typeof email !== "string") return "Email is required";
  if (!EMAIL_RE.test(email)) return "Invalid email format";
  if (email.length > 255) return "Email too long";
  return null;
}
function validatePassword(pw) {
  if (!pw || typeof pw !== "string") return "Password is required";
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password too long";
  return null;
}

// ─── Public routes ────────────────────────────────────────────────

router.post("/signup", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      "INSERT INTO users(email, password_hash) VALUES($1, $2) RETURNING id, email",
      [email, hash]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    if (!user.password_hash) {
      return res.status(401).json({ error: `This account uses ${user.provider || "OAuth"} login. Please sign in with ${user.provider || "your OAuth provider"} instead.` });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/oauth-login", authLimiter, async (req, res) => {
  const { email, name, provider, providerId } = req.body;
  if (!email || !provider) return res.status(400).json({ error: "email and provider required" });
  try {
    const result = await db.query(
      `INSERT INTO users(email, name, provider, provider_id)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, users.name),
         provider = COALESCE(EXCLUDED.provider, users.provider),
         provider_id = COALESCE(EXCLUDED.provider_id, users.provider_id)
       RETURNING id, email, role, name`,
      [email, name || null, provider, providerId || null]
    );
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Protected routes (require authenticateToken) ─────────────────

router.patch("/password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
    const user = (await db.query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password_hash) return res.status(400).json({ error: "OAuth user — no password to change" });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, email, name, role, provider, avatar, created_at FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/profile", authenticateToken, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100) {
        return res.status(400).json({ error: "Name must be 1-100 characters" });
      }
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }

    if (avatar !== undefined) {
      if (avatar === null) {
        // Allow removing avatar
        updates.push(`avatar = $${idx++}`);
        values.push(null);
      } else if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
        // Max ~500KB base64 (roughly 375KB image)
        if (avatar.length > 500000) {
          return res.status(400).json({ error: "Image too large. Max 500KB." });
        }
        updates.push(`avatar = $${idx++}`);
        values.push(avatar);
      } else {
        return res.status(400).json({ error: "Invalid avatar format" });
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING name, avatar`,
      values
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
