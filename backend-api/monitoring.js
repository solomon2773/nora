const db = require("./db");
const { deployQueue } = require("./redisQueue");
const {
  ensureAuditSourceMetadata,
} = require("./auditSource");

const DEFAULT_EVENT_LIMIT = 20;
const DEFAULT_AUDIT_PAGE_LIMIT = 30;
const MAX_AUDIT_PAGE_LIMIT = 100;

function normalizePositiveInteger(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return defaultValue;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeEventFilters(filters = {}) {
  const normalizedDate = (value) =>
    value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

  return {
    search: typeof filters.search === "string" ? filters.search.trim() : "",
    type: typeof filters.type === "string" ? filters.type.trim() : "",
    from: normalizedDate(filters.from),
    to: normalizedDate(filters.to),
  };
}

function buildEventWhereClause(
  filters = {},
  { tableAlias = "", startIndex = 1 } = {}
) {
  const normalized = normalizeEventFilters(filters);
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const clauses = [];
  const params = [];
  let parameterIndex = startIndex - 1;

  if (normalized.search) {
    params.push(`%${normalized.search}%`);
    parameterIndex += 1;
    clauses.push(
      `(${prefix}type ILIKE $${parameterIndex} OR COALESCE(${prefix}message, '') ILIKE $${parameterIndex} OR COALESCE(${prefix}metadata::text, '') ILIKE $${parameterIndex})`
    );
  }

  if (normalized.type) {
    params.push(normalized.type);
    parameterIndex += 1;
    clauses.push(`${prefix}type = $${parameterIndex}`);
  }

  if (normalized.from) {
    params.push(normalized.from);
    parameterIndex += 1;
    clauses.push(`${prefix}created_at >= $${parameterIndex}`);
  }

  if (normalized.to) {
    params.push(normalized.to);
    parameterIndex += 1;
    clauses.push(`${prefix}created_at <= $${parameterIndex}`);
  }

  return {
    whereClause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function joinWhereClauses(clauses = []) {
  const normalized = clauses
    .map((clause) =>
      typeof clause === "string"
        ? clause.trim().replace(/^WHERE\s+/i, "")
        : ""
    )
    .filter(Boolean);

  return normalized.length ? `WHERE ${normalized.join(" AND ")}` : "";
}

function buildUserEventScopeClause(
  userId,
  { agentId = null, tableAlias = "e", startIndex = 1 } = {}
) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const params = [];
  let parameterIndex = startIndex - 1;

  params.push(userId);
  parameterIndex += 1;
  const metadataUserParamIndex = parameterIndex;

  params.push(userId);
  parameterIndex += 1;
  const scopedAgentUserParamIndex = parameterIndex;

  const clauses = [
    `(
      ${prefix}metadata #>> '{source,account,userId}' = $${metadataUserParamIndex}
      OR ${prefix}metadata #>> '{actor,userId}' = $${metadataUserParamIndex}
      OR ${prefix}metadata #>> '{agent,ownerUserId}' = $${metadataUserParamIndex}
      OR ${prefix}metadata #>> '{user,id}' = $${metadataUserParamIndex}
      OR ${prefix}metadata #>> '{listing,ownerUserId}' = $${metadataUserParamIndex}
      OR ${prefix}metadata #>> '{report,reporterUserId}' = $${metadataUserParamIndex}
      OR ${prefix}metadata #>> '{report,reviewerUserId}' = $${metadataUserParamIndex}
      OR EXISTS (
        SELECT 1
         FROM agents scoped_agents
         WHERE scoped_agents.user_id = $${scopedAgentUserParamIndex}::uuid
           AND (
             scoped_agents.id::text = ${prefix}metadata->>'agentId'
             OR scoped_agents.id::text = ${prefix}metadata #>> '{agent,id}'
             OR scoped_agents.id::text = ${prefix}metadata #>> '{sourceAgent,id}'
           )
      )
    )`,
  ];

  if (agentId) {
    params.push(agentId);
    parameterIndex += 1;
    clauses.push(
      `(
        ${prefix}metadata #>> '{agent,id}' = $${parameterIndex}
        OR ${prefix}metadata #>> '{sourceAgent,id}' = $${parameterIndex}
        OR ${prefix}metadata->>'agentId' = $${parameterIndex}
      )`
    );
  }

  return {
    whereClause: joinWhereClauses(clauses),
    params,
  };
}

async function queryEvents(filters = {}, { limit = null, offset = 0 } = {}) {
  const { whereClause, params } = buildEventWhereClause(filters);
  const queryParams = params.slice();
  let sql = `SELECT * FROM events ${whereClause} ORDER BY created_at DESC`;

  if (Number.isInteger(limit)) {
    queryParams.push(limit);
    sql += ` LIMIT $${queryParams.length}`;
  }

  if (offset > 0) {
    queryParams.push(offset);
    sql += ` OFFSET $${queryParams.length}`;
  }

  const result = await db.query(sql, queryParams);
  return result.rows;
}

async function queryUserEvents(
  userId,
  options = {},
  { limit = null, offset = 0 } = {}
) {
  const scope = buildUserEventScopeClause(userId, {
    agentId:
      typeof options.agentId === "string" && options.agentId.trim()
        ? options.agentId.trim()
        : null,
    tableAlias: "e",
  });
  const filter = buildEventWhereClause(normalizeEventFilters(options), {
    tableAlias: "e",
    startIndex: scope.params.length + 1,
  });
  const queryParams = [...scope.params, ...filter.params];
  const whereClause = joinWhereClauses([scope.whereClause, filter.whereClause]);
  let sql = `SELECT e.* FROM events e ${whereClause} ORDER BY e.created_at DESC`;

  if (Number.isInteger(limit)) {
    queryParams.push(limit);
    sql += ` LIMIT $${queryParams.length}`;
  }

  if (offset > 0) {
    queryParams.push(offset);
    sql += ` OFFSET $${queryParams.length}`;
  }

  const result = await db.query(sql, queryParams);
  return result.rows;
}

async function getMetrics(options = {}) {
  const normalizedOptions =
    typeof options === "string" ? { userId: options } : options || {};
  const userId =
    typeof normalizedOptions.userId === "string" && normalizedOptions.userId.trim()
      ? normalizedOptions.userId.trim()
      : null;

  const agentCountsQuery = userId
    ? db.query(
        "SELECT status, count(*)::int FROM agents WHERE user_id = $1 GROUP BY status",
        [userId]
      )
    : db.query("SELECT status, count(*)::int FROM agents GROUP BY status");

  const deploymentCountQuery = userId
    ? db.query(
        `SELECT count(*)::int as total
           FROM deployments d
           INNER JOIN agents a ON a.id = d.agent_id
          WHERE a.user_id = $1`,
        [userId]
      )
    : db.query("SELECT count(*)::int as total FROM deployments");

  const userCountQuery = userId
    ? Promise.resolve({ rows: [] })
    : db.query("SELECT count(*)::int as total FROM users");

  const [agentCounts, deploymentCount, userCount] = await Promise.all([
    agentCountsQuery,
    deploymentCountQuery,
    userCountQuery,
  ]);

  const statusMap = {};
  agentCounts.rows.forEach((r) => {
    statusMap[r.status] = r.count;
  });

  let queueStats = { waiting: 0, active: 0, completed: 0, failed: 0 };
  if (userId) {
    queueStats = {
      waiting: statusMap.queued || 0,
      active: 0,
      completed: 0,
      failed: 0,
    };
  } else {
    try {
      queueStats = await deployQueue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed"
      );
    } catch (e) {
      /* queue may not be ready */
    }
  }

  const result = {
    activeAgents: statusMap.running || 0,
    warningAgents: statusMap.warning || 0,
    errorAgents: statusMap.error || 0,
    totalAgents: Object.values(statusMap).reduce((a, b) => a + b, 0),
    queuedAgents: statusMap.queued || 0,
    stoppedAgents: statusMap.stopped || 0,
    totalDeployments: deploymentCount.rows[0]?.total || 0,
    queue: queueStats,
  };

  if (!userId) {
    result.totalUsers = userCount.rows[0]?.total || 0;
  }

  return result;
}

async function getRecentEvents(limit = 20) {
  return queryEvents(
    {},
    {
      limit: normalizePositiveInteger(limit, DEFAULT_EVENT_LIMIT, {
        min: 1,
        max: MAX_AUDIT_PAGE_LIMIT,
      }),
    }
  );
}

async function getUserRecentEvents(userId, options = {}) {
  return queryUserEvents(userId, options, {
    limit: normalizePositiveInteger(options.limit, 50, {
      min: 1,
      max: MAX_AUDIT_PAGE_LIMIT,
    }),
  });
}

async function getUserEventsPage(userId, options = {}) {
  const limit = normalizePositiveInteger(options.limit, DEFAULT_AUDIT_PAGE_LIMIT, {
    min: 10,
    max: MAX_AUDIT_PAGE_LIMIT,
  });
  const requestedPage = normalizePositiveInteger(options.page, 1, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const scopedAgentId =
    typeof options.agentId === "string" && options.agentId.trim()
      ? options.agentId.trim()
      : null;
  const scope = buildUserEventScopeClause(userId, {
    agentId: scopedAgentId,
    tableAlias: "e",
  });
  const filter = buildEventWhereClause(normalizeEventFilters(options), {
    tableAlias: "e",
    startIndex: scope.params.length + 1,
  });
  const whereClause = joinWhereClauses([scope.whereClause, filter.whereClause]);
  const queryParams = [...scope.params, ...filter.params];

  const [countResult, typeResult] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS total FROM events e ${whereClause}`,
      queryParams
    ),
    db.query(
      `SELECT DISTINCT e.type
         FROM events e
        ${scope.whereClause}
        ORDER BY e.type ASC`,
      scope.params
    ),
  ]);

  const total = countResult.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;
  const events = await queryUserEvents(userId, options, { limit, offset });

  return {
    events,
    total,
    page,
    limit,
    totalPages,
    availableTypes: typeResult.rows
      .map((row) => row.type)
      .filter((value) => typeof value === "string" && value.length > 0),
  };
}

async function getAuditEventsPage(options = {}) {
  const filters = normalizeEventFilters(options);
  const limit = normalizePositiveInteger(options.limit, DEFAULT_AUDIT_PAGE_LIMIT, {
    min: 10,
    max: MAX_AUDIT_PAGE_LIMIT,
  });
  const requestedPage = normalizePositiveInteger(options.page, 1, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const { whereClause, params } = buildEventWhereClause(filters);

  const [countResult, typeResult] = await Promise.all([
    db.query(`SELECT count(*)::int AS total FROM events ${whereClause}`, params),
    db.query("SELECT DISTINCT type FROM events ORDER BY type ASC"),
  ]);

  const total = countResult.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;
  const events = await queryEvents(filters, { limit, offset });

  return {
    events,
    total,
    page,
    limit,
    totalPages,
    availableTypes: typeResult.rows
      .map((row) => row.type)
      .filter((value) => typeof value === "string" && value.length > 0),
  };
}

async function exportEvents(filters = {}) {
  return queryEvents(normalizeEventFilters(filters));
}

async function logEvent(type, message, metadata = {}) {
  const enrichedMetadata = ensureAuditSourceMetadata(metadata);
  await db.query(
    "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
    [type, message, JSON.stringify(enrichedMetadata)]
  );
}

module.exports = {
  exportEvents,
  getAuditEventsPage,
  getMetrics,
  getRecentEvents,
  getUserEventsPage,
  getUserRecentEvents,
  logEvent,
};
