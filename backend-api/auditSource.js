function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const entries = Object.entries(value).filter(([, entry]) => isPresent(entry));
  if (!entries.length) return undefined;
  return Object.fromEntries(entries);
}

function readRequestHeader(req, headerName) {
  if (!req || !headerName) return null;

  if (typeof req.get === "function") {
    const value = req.get(headerName);
    if (isPresent(value)) return value;
  }

  const headers = req.headers || {};
  return headers[headerName.toLowerCase()] || headers[headerName] || null;
}

function readRequestIp(req) {
  if (!req) return null;

  const forwardedFor = readRequestHeader(req, "x-forwarded-for");
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return (
    req.ip ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    null
  );
}

function normalizeSourceAccount(account = {}) {
  return compactObject({
    userId: account?.userId || account?.id || null,
    email: account?.email || null,
    role: account?.role || null,
  });
}

function buildSourceLabel(kind, account, service, explicitLabel) {
  if (isPresent(explicitLabel)) return explicitLabel;
  if (kind === "account") {
    return account?.email || account?.userId || "Account";
  }
  if (kind === "request") {
    return "Unauthenticated request";
  }
  return service ? `System · ${service}` : "System";
}

function buildSourceMetadata(req, source = {}) {
  const sourceObject =
    source && typeof source === "object" && !Array.isArray(source)
      ? source
      : isPresent(source)
        ? { label: String(source) }
        : {};

  const {
    account: sourceAccount,
    label,
    kind,
    service,
    channel,
    area,
    method,
    route,
    origin,
    ip,
    userAgent,
    ...rest
  } = sourceObject;

  const account = normalizeSourceAccount(
    sourceAccount ||
      (req?.user
        ? {
            userId: req.user.id,
            email: req.user.email || null,
            role: req.user.role || null,
          }
        : null)
  );
  const resolvedKind = kind || (account ? "account" : req ? "request" : "system");
  const resolvedService =
    service ||
    process.env.AUDIT_SOURCE_SERVICE ||
    process.env.SERVICE_NAME ||
    "backend-api";

  return compactObject({
    kind: resolvedKind,
    label: buildSourceLabel(resolvedKind, account, resolvedService, label),
    service: resolvedService,
    channel: channel || (req ? "http" : "internal"),
    area: area || null,
    method: method || req?.method || null,
    route: route || req?.originalUrl || req?.path || null,
    origin:
      origin ||
      readRequestHeader(req, "origin") ||
      readRequestHeader(req, "referer") ||
      null,
    ip: ip || readRequestIp(req) || null,
    userAgent: userAgent || readRequestHeader(req, "user-agent") || null,
    account,
    ...rest,
  });
}

function resolveAuditSource(metadata = {}) {
  if (metadata?.source) {
    return buildSourceMetadata(null, metadata.source);
  }

  if (metadata?.actor) {
    return buildSourceMetadata(null, {
      kind: "account",
      account: metadata.actor,
      label: metadata.actor.email || metadata.actor.userId || "Account",
    });
  }

  return buildSourceMetadata(null, {});
}

function ensureAuditSourceMetadata(metadata = {}, req = null) {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : { value: metadata };

  return {
    ...base,
    source: buildSourceMetadata(req, base.source || {}),
  };
}

module.exports = {
  buildSourceMetadata,
  ensureAuditSourceMetadata,
  readRequestHeader,
  readRequestIp,
  resolveAuditSource,
};
