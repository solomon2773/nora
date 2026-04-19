// @ts-nocheck
const db = require("./db");

async function ensureFirstRegisteredUserIsAdmin(queryable = db) {
  const result = await queryable.query(
    `WITH first_user AS (
       SELECT id
       FROM users
       WHERE NOT EXISTS (
         SELECT 1
         FROM users
         WHERE role = 'admin'
       )
       ORDER BY created_at ASC, id ASC
       LIMIT 1
     )
     UPDATE users
     SET role = 'admin'
     WHERE id = (SELECT id FROM first_user)
     RETURNING id, email, role, created_at`
  );

  return result.rows[0] || null;
}

module.exports = {
  ensureFirstRegisteredUserIsAdmin,
};
