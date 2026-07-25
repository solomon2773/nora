// @ts-nocheck
const db = require("./db");

/**
 * Promote the earliest registered user only when the installation currently
 * has no platform administrator.
 *
 * @param {Object} [queryable=db] - Database client or pool used for the atomic update.
 * @returns {Promise<Object|null>} Promoted user, or `null` when no promotion was needed.
 */
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
     RETURNING id, email, role, created_at`,
  );

  return result.rows[0] || null;
}

module.exports = {
  ensureFirstRegisteredUserIsAdmin,
};
