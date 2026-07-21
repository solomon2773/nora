// @ts-nocheck

const {
  buildSourceMetadata,
  ensureAuditSourceMetadata,
  readRequestHeader,
  readRequestIp,
  resolveAuditSource,
} = require("../auditSource");

describe("readRequestHeader", () => {
  it("returns null if request or headerName is missing", () => {
    expect(readRequestHeader(null, "x-forwarded-for")).toBeNull();
    expect(readRequestHeader({}, "")).toBeNull();
    expect(readRequestHeader(undefined, undefined)).toBeNull();
  });

  it("reads header using req.get() when available", () => {
    const req = {
      get: (name) => (name.toLowerCase() === "origin" ? "https://example.com" : null),
    };
    expect(readRequestHeader(req, "origin")).toBe("https://example.com");
    expect(readRequestHeader(req, "user-agent")).toBeNull();
  });

  it("falls back to headers object case-insensitively when req.get is not available", () => {
    const req = {
      headers: {
        "x-custom-header": "custom-value",
        "content-type": "application/json",
      },
    };
    expect(readRequestHeader(req, "X-Custom-Header")).toBe("custom-value");
    expect(readRequestHeader(req, "Content-Type")).toBe("application/json");
    expect(readRequestHeader(req, "missing")).toBeNull();
  });
});

describe("readRequestIp", () => {
  it("returns null when req is missing", () => {
    expect(readRequestIp(null)).toBeNull();
  });

  it("prefers first IP in x-forwarded-for over socket/connection fallbacks", () => {
    const req = {
      headers: {
        "x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178",
      },
      ip: "10.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(readRequestIp(req)).toBe("203.0.113.195");
  });

  it("falls back to req.ip, socket.remoteAddress, or connection.remoteAddress", () => {
    expect(readRequestIp({ ip: "192.168.1.50" })).toBe("192.168.1.50");
    expect(readRequestIp({ socket: { remoteAddress: "10.0.0.5" } })).toBe("10.0.0.5");
    expect(readRequestIp({ connection: { remoteAddress: "172.16.0.1" } })).toBe("172.16.0.1");
    expect(readRequestIp({})).toBeNull();
  });
});

describe("buildSourceMetadata", () => {
  const envBackup = process.env.AUDIT_SOURCE_SERVICE;

  afterEach(() => {
    if (envBackup !== undefined) {
      process.env.AUDIT_SOURCE_SERVICE = envBackup;
    } else {
      delete process.env.AUDIT_SOURCE_SERVICE;
    }
  });

  it("builds source metadata for account sources", () => {
    const source = {
      account: { userId: "usr_123", email: "alice@example.com", role: "admin" },
    };
    const metadata = buildSourceMetadata(null, source);

    expect(metadata.kind).toBe("account");
    expect(metadata.label).toBe("alice@example.com");
    expect(metadata.account).toEqual({
      userId: "usr_123",
      email: "alice@example.com",
      role: "admin",
    });
    expect(metadata.channel).toBe("internal");
  });

  it("builds source metadata for unauthenticated request sources", () => {
    const req = {
      method: "POST",
      originalUrl: "/api/v1/auth/login",
      headers: {
        "user-agent": "Mozilla/5.0",
        origin: "https://dashboard.example.com",
      },
      ip: "198.51.100.1",
    };
    const metadata = buildSourceMetadata(req, {});

    expect(metadata.kind).toBe("request");
    expect(metadata.label).toBe("Unauthenticated request");
    expect(metadata.channel).toBe("http");
    expect(metadata.method).toBe("POST");
    expect(metadata.route).toBe("/api/v1/auth/login");
    expect(metadata.origin).toBe("https://dashboard.example.com");
    expect(metadata.ip).toBe("198.51.100.1");
    expect(metadata.userAgent).toBe("Mozilla/5.0");
  });

  it("builds source metadata for system sources with default service name", () => {
    delete process.env.AUDIT_SOURCE_SERVICE;
    const metadata = buildSourceMetadata(null, {});

    expect(metadata.kind).toBe("system");
    expect(metadata.service).toBe("backend-api");
    expect(metadata.label).toBe("System · backend-api");
    expect(metadata.channel).toBe("internal");
  });

  it("supports explicit label, service, and channel overrides", () => {
    const source = {
      kind: "system",
      label: "Custom Background Task",
      service: "worker-provisioner",
      channel: "cron",
      area: "provisioning",
    };
    const metadata = buildSourceMetadata(null, source);

    expect(metadata.kind).toBe("system");
    expect(metadata.label).toBe("Custom Background Task");
    expect(metadata.service).toBe("worker-provisioner");
    expect(metadata.channel).toBe("cron");
    expect(metadata.area).toBe("provisioning");
  });
});

describe("resolveAuditSource", () => {
  it("resolves from metadata.source if present", () => {
    const metadata = {
      source: {
        account: { id: "usr_999", email: "bob@example.com" },
      },
    };
    const res = resolveAuditSource(metadata);
    expect(res.kind).toBe("account");
    expect(res.label).toBe("bob@example.com");
    expect(res.account.userId).toBe("usr_999");
  });

  it("resolves from metadata.actor fallback when source is missing", () => {
    const metadata = {
      actor: { userId: "usr_888", email: "charlie@example.com" },
    };
    const res = resolveAuditSource(metadata);
    expect(res.kind).toBe("account");
    expect(res.label).toBe("charlie@example.com");
    expect(res.account.userId).toBe("usr_888");
  });

  it("falls back to default system source when neither source nor actor is provided", () => {
    const res = resolveAuditSource({});
    expect(res.kind).toBe("system");
    expect(res.channel).toBe("internal");
  });
});

describe("ensureAuditSourceMetadata", () => {
  it("attaches normalized source metadata to metadata object", () => {
    const req = {
      user: { id: "usr_456", email: "dev@example.com", role: "user" },
      method: "GET",
      path: "/api/status",
    };
    const input = { action: "read_status" };
    const output = ensureAuditSourceMetadata(input, req);

    expect(output.action).toBe("read_status");
    expect(output.source).toBeDefined();
    expect(output.source.kind).toBe("account");
    expect(output.source.label).toBe("dev@example.com");
    expect(output.source.account).toEqual({
      userId: "usr_456",
      email: "dev@example.com",
      role: "user",
    });
    expect(output.source.method).toBe("GET");
    expect(output.source.route).toBe("/api/status");
  });
});
