const monitoring = require("./monitoring");
const {
  ensureAuditSourceMetadata,
  readRequestHeader,
  readRequestIp,
} = require("./auditSource");

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeAuditValue(value, depth = 0) {
  if (value == null || value === "") return undefined;
  if (depth > 8) return "[max-depth]";

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return normalizeAuditValue(
      {
        name: value.name || "Error",
        message: value.message || String(value),
        code: value.code || null,
        status: value.statusCode || value.status || null,
        stack: typeof value.stack === "string" ? value.stack : undefined,
      },
      depth + 1
    );
  }

  if (Array.isArray(value)) {
    const normalizedArray = value
      .map((entry) => normalizeAuditValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
    return normalizedArray.length ? normalizedArray : undefined;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (isPlainObject(value)) {
    const normalizedObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedEntry = normalizeAuditValue(entry, depth + 1);
      if (normalizedEntry !== undefined) {
        normalizedObject[key] = normalizedEntry;
      }
    }
    return Object.keys(normalizedObject).length ? normalizedObject : undefined;
  }

  return value;
}

function buildAuditMetadata(req, context = {}) {
  const { source, ...restContext } = context || {};
  return (
    normalizeAuditValue(
      ensureAuditSourceMetadata(
        {
          actor: req?.user
            ? {
                userId: req.user.id,
                email: req.user.email || null,
                role: req.user.role || null,
              }
            : undefined,
          request: req
            ? {
                method: req.method,
                path: req.originalUrl || req.path || null,
                correlationId: req.correlationId || null,
                ip: readRequestIp(req) || null,
                origin:
                  readRequestHeader(req, "origin") ||
                  readRequestHeader(req, "referer") ||
                  null,
                userAgent: readRequestHeader(req, "user-agent") || null,
                params:
                  req.params && Object.keys(req.params).length
                    ? req.params
                    : undefined,
                query:
                  req.query && Object.keys(req.query).length
                    ? req.query
                    : undefined,
              }
            : undefined,
          source,
          ...restContext,
        },
        req
      )
    ) || {}
  );
}

function buildErrorMetadata(error, context = {}) {
  return normalizeAuditValue({
    ...context,
    error:
      error instanceof Error
        ? error
        : {
            name: error?.name || "Error",
            message:
              error?.message ||
              error?.error ||
              `Request failed with status ${error?.statusCode || error?.status || "unknown"}`,
            code: error?.code || null,
            status: error?.statusCode || error?.status || null,
            stack: error?.stack || null,
          },
  });
}

function buildAgentContext(agent = {}, overrides = {}) {
  const {
    id,
    name,
    ownerUserId,
    ownerEmail,
    backendType,
    sandboxType,
    node,
    containerId,
    ...rest
  } = overrides;

  return normalizeAuditValue({
    agent: {
      id: id || agent?.id || null,
      name: name || agent?.name || null,
      ownerUserId:
        ownerUserId !== undefined ? ownerUserId : agent?.user_id || null,
      ownerEmail:
        ownerEmail !== undefined ? ownerEmail : agent?.ownerEmail || null,
      backendType:
        backendType !== undefined
          ? backendType
          : agent?.backend_type || null,
      sandboxType:
        sandboxType !== undefined
          ? sandboxType
          : agent?.sandbox_type || null,
      node: node !== undefined ? node : agent?.node || null,
      containerId:
        containerId !== undefined ? containerId : agent?.container_id || null,
    },
    ...rest,
  });
}

function buildUserContext(user = {}, overrides = {}) {
  const { id, email, role, name, ...rest } = overrides;
  return normalizeAuditValue({
    user: {
      id: id || user?.id || null,
      email: email || user?.email || null,
      role: role || user?.role || null,
      name: name || user?.name || null,
    },
    ...rest,
  });
}

function buildListingContext(listing = {}, overrides = {}) {
  const {
    id,
    name,
    ownerUserId,
    ownerEmail,
    status,
    sourceType,
    category,
    snapshotId,
    ...rest
  } = overrides;

  return normalizeAuditValue({
    listing: {
      id: id || listing?.id || null,
      name: name || listing?.name || null,
      ownerUserId:
        ownerUserId !== undefined
          ? ownerUserId
          : listing?.owner_user_id || null,
      ownerEmail:
        ownerEmail !== undefined
          ? ownerEmail
          : listing?.owner_email || null,
      status: status || listing?.status || null,
      sourceType: sourceType || listing?.source_type || null,
      category: category || listing?.category || null,
      snapshotId:
        snapshotId !== undefined
          ? snapshotId
          : listing?.snapshot_id || null,
    },
    ...rest,
  });
}

function buildReportContext(report = {}, overrides = {}) {
  const {
    id,
    status,
    reporterUserId,
    reporterEmail,
    reviewerUserId,
    reviewerEmail,
    reason,
    ...rest
  } = overrides;

  return normalizeAuditValue({
    report: {
      id: id || report?.id || null,
      status: status || report?.status || null,
      reporterUserId:
        reporterUserId !== undefined
          ? reporterUserId
          : report?.reporter_user_id || null,
      reporterEmail:
        reporterEmail !== undefined
          ? reporterEmail
          : report?.reporter_email || null,
      reviewerUserId:
        reviewerUserId !== undefined
          ? reviewerUserId
          : report?.reviewed_by_user_id || null,
      reviewerEmail:
        reviewerEmail !== undefined
          ? reviewerEmail
          : report?.reviewed_by_email || null,
      reason: reason || report?.reason || null,
    },
    ...rest,
  });
}

function createMutationFailureAuditMiddleware(routeArea) {
  return function auditMutationFailures(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return next();
    }

    let responseBody;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode < 400 || res.locals?.skipAuditFailureLog) return;

      const errorLike = res.locals?.auditError || {
        name: responseBody?.code || "RequestError",
        message:
          responseBody?.error ||
          responseBody?.message ||
          `Request failed with status ${res.statusCode}`,
        code: responseBody?.code || null,
        statusCode: res.statusCode,
      };

      const metadata = buildAuditMetadata(
        req,
        {
          ...(res.locals?.auditContext || {}),
          ...buildErrorMetadata(errorLike, {
            context: {
              area: routeArea,
              severity: res.statusCode >= 500 ? "error" : "warning",
            },
            response: {
              status: res.statusCode,
            },
          }),
        }
      );

      Promise.resolve(
        monitoring.logEvent(
          `${routeArea}_action_failed`,
          `${routeArea} action failed: ${req.method} ${req.originalUrl}`,
          metadata
        )
      ).catch((error) => {
        console.error("Failed to write audit failure event:", error.message);
      });
    });

    next();
  };
}

module.exports = {
  buildAgentContext,
  buildAuditMetadata,
  buildErrorMetadata,
  buildListingContext,
  buildReportContext,
  buildUserContext,
  createMutationFailureAuditMiddleware,
  normalizeAuditValue,
};
