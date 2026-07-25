// @ts-nocheck
// Platform-admin managed user groups used by platform Remote Host grants.

const db = require("./db");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createHttpError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function normalizeGroupId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_RE.test(id)) {
    throw createHttpError("User group id must be a UUID");
  }
  return id;
}

function normalizeGroupName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw createHttpError("User group name is required");
  if (name.length > 120) {
    throw createHttpError("User group name must be 120 characters or fewer");
  }
  return name;
}

/**
 * Normalize member ids, accepting either raw id strings or objects with a
 * `userId`, `user_id`, or `id` key; input order and duplicates are not preserved.
 *
 * @param {Array} value - Requested member entries.
 * @returns {Array<string>} Deduplicated, lowercased member ids.
 */
function normalizeUserIds(value) {
  if (!Array.isArray(value)) {
    throw createHttpError("users must be an array");
  }
  const ids = value.map((entry) => {
    const raw =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry.userId ?? entry.user_id ?? entry.id)
          : "";
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) throw createHttpError("Every user group member must be a valid user id");
    return id;
  });
  return [...new Set(ids)];
}

function mapGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    memberCount: Number(row.memberCount ?? row.member_count ?? 0),
    membersVersion: Number(row.membersVersion ?? row.members_version ?? 1),
  };
}

function mapMember(row) {
  return {
    userId: row.userId ?? row.user_id ?? row.id,
    email: row.email || "",
    name: row.name || null,
  };
}

function rethrowUniqueName(error) {
  if (error?.code !== "23505") throw error;
  throw createHttpError(
    "A user group with that name already exists",
    409,
    "USER_GROUP_NAME_EXISTS",
  );
}

async function listUserGroups() {
  const result = await db.query(
    `SELECT ug.id,
            ug.name,
            ug.members_version AS "membersVersion",
            COUNT(ugm.user_id)::int AS "memberCount"
       FROM user_groups ug
       LEFT JOIN user_group_members ugm ON ugm.group_id = ug.id
      GROUP BY ug.id, ug.name, ug.members_version
      ORDER BY LOWER(ug.name), ug.id`,
  );
  return result.rows.map(mapGroup);
}

/**
 * Load a group summary, optionally locking its row for an in-progress
 * membership replacement. Locked reads report `memberCount: 0` — callers that
 * need the count use the unlocked path instead.
 *
 * @param {string} groupId - User group id.
 * @param {Object} [queryable=db] - Pooled client or transaction to query through.
 * @param {Object} [options={}] - `forUpdate` locks the row via `FOR UPDATE`.
 * @returns {Promise<Object>} Group summary, or `undefined` when not found.
 */
async function getUserGroup(groupId, queryable = db, { forUpdate = false } = {}) {
  const id = normalizeGroupId(groupId);
  const result = forUpdate
    ? await queryable.query(
        `SELECT ug.id,
                ug.name,
                ug.members_version AS "membersVersion",
                0::int AS "memberCount"
           FROM user_groups ug
          WHERE ug.id = $1
          FOR UPDATE OF ug`,
        [id],
      )
    : await queryable.query(
        `SELECT ug.id,
                ug.name,
                ug.members_version AS "membersVersion",
                (SELECT COUNT(*)::int FROM user_group_members ugm WHERE ugm.group_id = ug.id) AS "memberCount"
           FROM user_groups ug
          WHERE ug.id = $1`,
        [id],
      );
  return mapGroup(result.rows[0]);
}

/**
 * Create a user group, rejecting a duplicate name with a structured 409
 * instead of the raw unique-constraint error.
 *
 * @param {Object} [input={}] - Requested group name.
 * @param {string|null} [createdByUserId=null] - Creating admin, if any.
 * @returns {Promise<Object>} Created group summary.
 */
async function createUserGroup(input = {}, createdByUserId = null) {
  const name = normalizeGroupName(input.name);
  try {
    const result = await db.query(
      `INSERT INTO user_groups(name, created_by_user_id)
       VALUES($1, $2)
       RETURNING id, name, members_version AS "membersVersion", 0::int AS "memberCount"`,
      [name, createdByUserId || null],
    );
    return mapGroup(result.rows[0]);
  } catch (error) {
    rethrowUniqueName(error);
  }
}

/**
 * Rename a user group, rejecting a duplicate name with a structured 409
 * instead of the raw unique-constraint error.
 *
 * @param {string} groupId - User group to rename.
 * @param {Object} [input={}] - Requested new name.
 * @returns {Promise<Object>} Updated group summary.
 */
async function updateUserGroup(groupId, input = {}) {
  const id = normalizeGroupId(groupId);
  const name = normalizeGroupName(input.name);
  try {
    const result = await db.query(
      `WITH updated AS (
         UPDATE user_groups
            SET name = $2,
                updated_at = NOW()
          WHERE id = $1
        RETURNING id, name, members_version
       )
       SELECT updated.id,
              updated.name,
              updated.members_version AS "membersVersion",
              COUNT(ugm.user_id)::int AS "memberCount"
         FROM updated
         LEFT JOIN user_group_members ugm ON ugm.group_id = updated.id
        GROUP BY updated.id, updated.name, updated.members_version`,
      [id, name],
    );
    if (!result.rows[0]) throw createHttpError("User group not found", 404);
    return mapGroup(result.rows[0]);
  } catch (error) {
    rethrowUniqueName(error);
  }
}

/**
 * Delete a user group. This cascades at the database level to its membership
 * rows and to any Remote Host access grants made through the group, silently
 * revoking that access.
 *
 * @param {string} groupId - User group to delete.
 * @returns {Promise<Object>} Deleted group summary.
 */
async function deleteUserGroup(groupId) {
  const id = normalizeGroupId(groupId);
  const result = await db.query(
    `DELETE FROM user_groups ug
      WHERE ug.id = $1
      RETURNING ug.id,
                ug.name,
                ug.members_version AS "membersVersion"`,
    [id],
  );
  if (!result.rows[0]) throw createHttpError("User group not found", 404);
  return mapGroup(result.rows[0]);
}

async function readUserGroupMembers(queryable, group) {
  const result = await queryable.query(
    `SELECT u.id AS "userId", u.email, u.name
       FROM user_group_members ugm
       JOIN users u ON u.id = ugm.user_id
      WHERE ugm.group_id = $1
      ORDER BY LOWER(u.email), u.id`,
    [group.id],
  );
  return {
    version: Number(group.membersVersion || 1),
    members: result.rows.map(mapMember),
  };
}

/**
 * List a group's members from a consistent snapshot, alongside the membership
 * version callers must echo back to `replaceUserGroupMembers`.
 *
 * @param {string} groupId - User group to list.
 * @returns {Promise<Object>} Membership version and member list.
 */
async function listUserGroupMembers(groupId) {
  const id = normalizeGroupId(groupId);
  const client = await db.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const group = await getUserGroup(id, client);
    if (!group) throw createHttpError("User group not found", 404);
    const members = await readUserGroupMembers(client, group);
    await client.query("COMMIT");
    transactionOpen = false;
    return members;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function normalizeExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw createHttpError(
      "User group members expectedVersion is required",
      400,
      "EXPECTED_VERSION_REQUIRED",
    );
  }
  return version;
}

/**
 * Replace a group's entire membership under optimistic concurrency; this is a
 * full replace, not a merge. Fails with a version-conflict 409 when
 * `expectedVersion` no longer matches the persisted `membersVersion`.
 *
 * @param {string} groupId - User group whose membership should be replaced.
 * @param {Array} users - Complete desired membership list.
 * @param {number} expectedVersion - Membership version the caller last read.
 * @param {string|null} [createdByUserId=null] - Admin performing the replacement.
 * @returns {Promise<Object>} Updated membership version and member list.
 */
async function replaceUserGroupMembers(groupId, users, expectedVersion, createdByUserId = null) {
  const id = normalizeGroupId(groupId);
  const userIds = normalizeUserIds(users);
  const expectedMembersVersion = normalizeExpectedVersion(expectedVersion);
  const client = await db.connect();
  let transactionOpen = false;
  let members = null;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const group = await getUserGroup(id, client, { forUpdate: true });
    if (!group) throw createHttpError("User group not found", 404);
    if (group.membersVersion !== expectedMembersVersion) {
      throw createHttpError(
        "User group members changed since they were loaded; refresh and try again",
        409,
        "USER_GROUP_MEMBERS_VERSION_CONFLICT",
      );
    }

    if (userIds.length > 0) {
      const existingUsers = await client.query("SELECT id FROM users WHERE id = ANY($1::uuid[])", [
        userIds,
      ]);
      const found = new Set(existingUsers.rows.map((row) => String(row.id).toLowerCase()));
      const missing = userIds.filter((userId) => !found.has(userId));
      if (missing.length > 0) {
        throw createHttpError(`Unknown user id: ${missing[0]}`, 400, "USER_GROUP_MEMBER_NOT_FOUND");
      }
    }

    const updated = await client.query(
      `UPDATE user_groups
          SET members_version = members_version + 1,
              updated_at = NOW()
        WHERE id = $1
          AND members_version = $2
      RETURNING members_version AS "membersVersion"`,
      [id, expectedMembersVersion],
    );
    if (!updated.rows[0]) {
      throw createHttpError(
        "User group members changed since they were loaded; refresh and try again",
        409,
        "USER_GROUP_MEMBERS_VERSION_CONFLICT",
      );
    }

    await client.query("DELETE FROM user_group_members WHERE group_id = $1", [id]);
    if (userIds.length > 0) {
      await client.query(
        `INSERT INTO user_group_members(group_id, user_id, created_by_user_id)
         SELECT $1, ids.member_id, $3
           FROM UNNEST($2::uuid[]) AS ids(member_id)`,
        [id, userIds, createdByUserId || null],
      );
    }
    members = await readUserGroupMembers(client, {
      id,
      membersVersion: updated.rows[0].membersVersion,
    });
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return members;
}

module.exports = {
  createUserGroup,
  deleteUserGroup,
  getUserGroup,
  listUserGroupMembers,
  listUserGroups,
  normalizeUserIds,
  replaceUserGroupMembers,
  updateUserGroup,
};
