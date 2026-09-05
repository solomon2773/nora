// @ts-nocheck
/**
 * __tests__/auth.test.js — Authentication endpoint tests
 */
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "google-client-id";

const mockDb = { query: jest.fn(), connect: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
}));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../agentHubStore", () => ({
  listAgentHubLocalListings: jest.fn().mockResolvedValue([]),
  publishSnapshot: jest.fn(),
  getListing: jest.fn(),
  deleteListing: jest.fn(),
}));
jest.mock("../snapshots", () => ({
  createSnapshot: jest.fn().mockResolvedValue({ id: "s1", name: "Test", description: "test" }),
  getSnapshot: jest.fn(),
}));
jest.mock("../workspaces", () => ({
  listWorkspaces: jest.fn().mockResolvedValue([]),
  createWorkspace: jest.fn(),
  addAgent: jest.fn(),
  getWorkspaceAgents: jest.fn().mockResolvedValue([]),
  listAgentCandidates: jest.fn().mockResolvedValue([]),
  removeAgent: jest.fn(),
  listAccessibleAgents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../integrations", () => ({
  listIntegrations: jest.fn().mockResolvedValue([]),
  connectIntegration: jest.fn(),
  removeIntegration: jest.fn(),
  testIntegration: jest.fn(),
  getCatalog: jest.fn().mockResolvedValue([]),
  getCatalogItem: jest.fn(),
  getIntegrationsForSync: jest.fn().mockResolvedValue({}),
  seedCatalog: jest.fn(),
}));
jest.mock("../monitoring", () => ({
  getMetrics: jest.fn().mockResolvedValue({}),
  logEvent: jest.fn(),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  IS_PAAS: false,
  SELFHOSTED_LIMITS: { max_vcpu: 16, max_ram_mb: 32768, max_disk_gb: 500, max_agents: 50 },
  enforceLimits: jest.fn().mockResolvedValue({
    allowed: true,
    subscription: { plan: "selfhosted", vcpu: 2, ram_mb: 2048, disk_gb: 20 },
  }),
  getSubscription: jest.fn().mockResolvedValue({
    plan: "selfhosted",
    status: "active",
    agent_limit: 3,
    agent_limit_override: null,
    base_agent_limit: 3,
    agent_limit_source: "default",
    is_unlimited: false,
  }),
  getBackupUsage: jest.fn().mockResolvedValue({
    backup_storage_used_bytes: 0,
    backup_count_for_agent: 0,
  }),
  createCheckoutSession: jest.fn(),
  createPortalSession: jest.fn(),
  handleWebhookEvent: jest.fn(),
}));
jest.mock("../llmProviders", () => ({
  getAvailableProviders: jest.fn().mockReturnValue([]),
  listProviders: jest.fn().mockResolvedValue([]),
  addProvider: jest.fn(),
  updateProvider: jest.fn(),
  deleteProvider: jest.fn(),
  getProviderKeys: jest.fn().mockResolvedValue([]),
  buildAuthProfiles: jest.fn().mockReturnValue({}),
  PROVIDERS: [],
}));
jest.mock("../channels", () => ({
  listChannels: jest.fn().mockResolvedValue([]),
  createChannel: jest.fn(),
  updateChannel: jest.fn(),
  deleteChannel: jest.fn(),
  testChannel: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  handleInboundWebhook: jest.fn(),
}));
jest.mock("../metrics", () => ({
  parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
  getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
  getAccessibleWorkspaceCosts: jest
    .fn()
    .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  recordApiMetric: jest.fn(),
}));

const apiKeys = require("../apiKeys");
const mockVerifyApiKey = jest.spyOn(apiKeys, "verifyApiKey");
const app = require("../server");
const { __test: authRouteTestHelpers } = require("../routes/auth");

function jsonResponse(body, ok = true, status = ok ? 200 : 400) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

let signupIpCounter = 0;
function signupRequest(ip = null) {
  signupIpCounter += 1;
  return request(app)
    .post("/auth/signup")
    .set("X-Forwarded-For", ip || `203.0.113.${signupIpCounter}`);
}

function mockValidNoraApiKey() {
  mockVerifyApiKey.mockResolvedValueOnce({
    user: {
      id: "api-key-user",
      email: "api-key-user@example.com",
      role: "user",
      name: "API Key User",
    },
    key: { id: "key-1", scopes: ["agents:read"] },
    workspace: { id: "workspace-1", name: "Test Workspace" },
  });
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockDb.connect.mockReset();
  mockDb.connect.mockResolvedValue({
    query: mockDb.query,
    release: jest.fn(),
  });
  process.env.OAUTH_LOGIN_ENABLED = "false";
  process.env.PLATFORM_MODE = "selfhosted";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  delete process.env.SIGNUP_ENABLED;
  delete process.env.SIGNUP_BOT_PROTECTION_PROVIDER;
  delete process.env.NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER;
  delete process.env.SIGNUP_TURNSTILE_SECRET;
  delete process.env.SIGNUP_TURNSTILE_SITE_KEY;
  delete process.env.NEXT_PUBLIC_SIGNUP_TURNSTILE_SITE_KEY;
  delete process.env.SIGNUP_RECAPTCHA_SECRET;
  delete process.env.SIGNUP_RECAPTCHA_SITE_KEY;
  delete process.env.NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY;
  global.fetch = jest.fn();
  mockVerifyApiKey.mockReset();
});

afterAll(() => {
  mockVerifyApiKey.mockRestore();
  // The last-run test's value must not leak into later test files in the same
  // Jest worker — beforeEach only resets it within this file.
  delete process.env.SIGNUP_ENABLED;
});

describe("auth rate limit configuration", () => {
  const originalWindowMs = process.env.AUTH_RATE_LIMIT_WINDOW_MS;
  const originalMax = process.env.AUTH_RATE_LIMIT_MAX;

  beforeEach(() => {
    delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;
    delete process.env.AUTH_RATE_LIMIT_MAX;
  });

  afterAll(() => {
    if (originalWindowMs === undefined) delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;
    else process.env.AUTH_RATE_LIMIT_WINDOW_MS = originalWindowMs;
    if (originalMax === undefined) delete process.env.AUTH_RATE_LIMIT_MAX;
    else process.env.AUTH_RATE_LIMIT_MAX = originalMax;
  });

  it("uses secure defaults when overrides are unset", () => {
    expect(authRouteTestHelpers.getAuthRateLimitConfig()).toEqual({
      windowMs: 15 * 60 * 1000,
      max: 20,
    });
  });

  it("accepts positive integer overrides", () => {
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = " 60000 ";
    process.env.AUTH_RATE_LIMIT_MAX = "250";

    expect(authRouteTestHelpers.getAuthRateLimitConfig()).toEqual({
      windowMs: 60000,
      max: 250,
    });
  });

  it.each(["0", "-1", "1.5", "20requests", "9007199254740992"])(
    "falls back when an override is not a positive safe integer: %s",
    (invalidValue) => {
      process.env.AUTH_RATE_LIMIT_WINDOW_MS = invalidValue;
      process.env.AUTH_RATE_LIMIT_MAX = invalidValue;

      expect(authRouteTestHelpers.getAuthRateLimitConfig()).toEqual({
        windowMs: 15 * 60 * 1000,
        max: 20,
      });
    },
  );
});

describe("password signup availability configuration", () => {
  it("defaults absent or blank values to enabled", () => {
    delete process.env.SIGNUP_ENABLED;
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(true);

    process.env.SIGNUP_ENABLED = "   ";
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(true);
  });

  it.each(["true", "1", "YES", " on "])("enables password signup for %p", (value) => {
    process.env.SIGNUP_ENABLED = value;
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(true);
  });

  it.each(["false", "0", "NO", " off ", "invalid"])("disables password signup for %p", (value) => {
    process.env.SIGNUP_ENABLED = value;
    expect(authRouteTestHelpers.isSignupEnabled()).toBe(false);
  });
});

describe("bootstrap admin startup gate", () => {
  it("refuses an empty hosted PaaS database without explicit bootstrap credentials", async () => {
    const originalEmail = process.env.DEFAULT_ADMIN_EMAIL;
    const originalPassword = process.env.DEFAULT_ADMIN_PASSWORD;
    try {
      process.env.PLATFORM_MODE = "paas";
      process.env.DEFAULT_ADMIN_EMAIL = "";
      process.env.DEFAULT_ADMIN_PASSWORD = "";
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await expect(app.__test.seedBootstrapAdminAccount()).rejects.toMatchObject({
        code: "PAAS_BOOTSTRAP_ADMIN_REQUIRED",
      });
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    } finally {
      if (originalEmail === undefined) delete process.env.DEFAULT_ADMIN_EMAIL;
      else process.env.DEFAULT_ADMIN_EMAIL = originalEmail;
      if (originalPassword === undefined) delete process.env.DEFAULT_ADMIN_PASSWORD;
      else process.env.DEFAULT_ADMIN_PASSWORD = originalPassword;
    }
  });
});

describe("POST /auth/signup", () => {
  it("rejects disabled password signup before validation or work", async () => {
    process.env.SIGNUP_ENABLED = "false";
    const hashSpy = jest.spyOn(bcrypt, "hash");

    try {
      const res = await signupRequest().send({});

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Registration is disabled by this Nora operator.",
        code: "SIGNUP_DISABLED",
      });
      expect(hashSpy).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockDb.connect).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
  });

  it("returns the disabled response without consuming the same IP's signup quota", async () => {
    process.env.SIGNUP_ENABLED = "false";
    const ip = "198.51.100.251";
    const hashSpy = jest.spyOn(bcrypt, "hash");
    const disabledResponse = {
      error: "Registration is disabled by this Nora operator.",
      code: "SIGNUP_DISABLED",
    };

    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await signupRequest(ip).send({});

        expect(res.status).toBe(403);
        expect(res.body).toEqual(disabledResponse);
      }

      process.env.SIGNUP_ENABLED = "true";
      const enabledRes = await signupRequest(ip).send({});
      expect(enabledRes.status).toBe(400);
      expect(enabledRes.body.error).toMatch(/email/i);

      expect(hashSpy).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockDb.connect).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
  });

  it("rejects missing email", async () => {
    const res = await signupRequest().send({ password: "testpassword123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejects invalid email format", async () => {
    const res = await signupRequest().send({
      email: "notanemail",
      password: "testpassword123",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejects short password", async () => {
    const res = await signupRequest().send({ email: "test@example.com", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it("creates the first registered user as admin", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: false }] })
      .mockResolvedValueOnce({
        rows: [{ id: "uuid-1", email: "new@example.com", role: "admin" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await signupRequest().send({
      email: "new@example.com",
      password: "validpassword123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "uuid-1");
    expect(res.body).toHaveProperty("email", "new@example.com");
    expect(res.body).toHaveProperty("role", "admin");
  });

  it("refuses public first-admin claim in hosted PaaS mode", async () => {
    process.env.PLATFORM_MODE = "paas";
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.SIGNUP_TURNSTILE_SITE_KEY = "turnstile-site-key";
    process.env.SIGNUP_TURNSTILE_SECRET = "turnstile-secret";
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: false }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await signupRequest().send({
      email: "outside@example.com",
      password: "validpassword123",
      botProtectionToken: "verified-token",
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        code: "PAAS_BOOTSTRAP_ADMIN_REQUIRED",
        error: expect.stringMatching(/bootstrap administrator/i),
      }),
    );
    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO users/i),
      expect.anything(),
    );
  });

  it("creates additional registered users as regular users", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: "uuid-2", email: "next@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await signupRequest().send({
      email: "next@example.com",
      password: "validpassword123",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("role", "user");
  });

  it("returns 409 for an existing email before hashing", async () => {
    const hashSpy = jest.spyOn(bcrypt, "hash");
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: "existing-user" }] });

    const res = await signupRequest().send({
      email: "dup@example.com",
      password: "validpassword123",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(hashSpy).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    hashSpy.mockRestore();
  });

  it("returns 409 on duplicate email races from the DB unique constraint", async () => {
    const err = new Error("duplicate key value violates unique constraint");
    err.code = "23505";
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ rows: [] });

    const res = await signupRequest().send({
      email: "dup-race@example.com",
      password: "validpassword123",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("rate limits signup bursts separately from login", async () => {
    const ip = "198.51.100.250";
    for (let i = 0; i < 5; i += 1) {
      const res = await signupRequest(ip).send({
        email: "notanemail",
        password: "testpassword123",
      });
      expect(res.status).toBe(400);
    }

    const res = await signupRequest(ip).send({
      email: "notanemail",
      password: "testpassword123",
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many signup/i);
  });

  it("rejects signup when Turnstile is configured and the token is missing", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.SIGNUP_TURNSTILE_SECRET = "turnstile-secret";
    process.env.SIGNUP_TURNSTILE_SITE_KEY = "turnstile-site-key";

    const res = await signupRequest().send({
      email: "turnstile@example.com",
      password: "validpassword123",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/verification challenge/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("allows signup when Turnstile verification succeeds", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.SIGNUP_TURNSTILE_SECRET = "turnstile-secret";
    process.env.SIGNUP_TURNSTILE_SITE_KEY = "turnstile-site-key";
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: "uuid-turnstile", email: "turnstile@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await signupRequest().send({
      email: "turnstile@example.com",
      password: "validpassword123",
      botProtectionToken: "turnstile-token",
    });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
    const verifyBody = global.fetch.mock.calls[0][1].body;
    expect(verifyBody.get("secret")).toBe("turnstile-secret");
    expect(verifyBody.get("response")).toBe("turnstile-token");
  });

  it("rejects signup when reCAPTCHA verification fails", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "recaptcha";
    process.env.SIGNUP_RECAPTCHA_SECRET = "recaptcha-secret";
    process.env.SIGNUP_RECAPTCHA_SITE_KEY = "recaptcha-site-key";
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: false }));

    const res = await signupRequest().send({
      email: "recaptcha@example.com",
      password: "validpassword123",
      botProtectionToken: "bad-recaptcha-token",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/verification challenge/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects signup when bot verification cannot be reached", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "recaptcha";
    process.env.SIGNUP_RECAPTCHA_SECRET = "recaptcha-secret";
    process.env.SIGNUP_RECAPTCHA_SITE_KEY = "recaptcha-site-key";
    global.fetch.mockRejectedValueOnce(new Error("network unavailable"));

    const res = await signupRequest().send({
      email: "recaptcha-unreachable@example.com",
      password: "validpassword123",
      botProtectionToken: "recaptcha-token",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/verification challenge/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("allows signup when reCAPTCHA verification succeeds", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "recaptcha";
    process.env.SIGNUP_RECAPTCHA_SECRET = "recaptcha-secret";
    process.env.SIGNUP_RECAPTCHA_SITE_KEY = "recaptcha-site-key";
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: "uuid-recaptcha", email: "recaptcha@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await signupRequest().send({
      email: "recaptcha@example.com",
      password: "validpassword123",
      botProtectionToken: "recaptcha-token",
    });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://www.google.com/recaptcha/api/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
    const verifyBody = global.fetch.mock.calls[0][1].body;
    expect(verifyBody.get("secret")).toBe("recaptcha-secret");
    expect(verifyBody.get("response")).toBe("recaptcha-token");
  });

  it("fails closed when bot protection is enabled without a public site key", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.SIGNUP_TURNSTILE_SECRET = "turnstile-secret";
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await signupRequest().send({
      email: "turnstile-misconfigured@example.com",
      password: "validpassword123",
      botProtectionToken: "unverifiable-token",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not create account/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("POST /auth/login", () => {
  it("rejects missing credentials", async () => {
    const res = await request(app).post("/auth/login").send({});
    expect(res.status).toBe(400);
  });

  it("rejects wrong email", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "nobody@example.com", password: "testpassword123" });
    expect(res.status).toBe(401);
  });

  it("returns token on valid login", async () => {
    const hash = await bcrypt.hash("correctpassword", 10);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "uuid-1", email: "user@example.com", password_hash: hash, role: "user" }],
    });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "user@example.com", password: "correctpassword" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");

    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded).toHaveProperty("id", "uuid-1");
  });

  it("sets an HttpOnly SameSite=Lax auth cookie on successful login", async () => {
    const hash = await bcrypt.hash("correctpassword", 10);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "uuid-1", email: "user@example.com", password_hash: hash, role: "user" }],
    });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "user@example.com", password: "correctpassword" });

    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] || [];
    const authCookie = setCookie.find((c) => c.startsWith("nora_auth="));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/HttpOnly/i);
    expect(authCookie).toMatch(/SameSite=Lax/i);
    expect(authCookie).toMatch(/Path=\//i);
    // The token in the cookie must verify against the same secret.
    const cookieToken = authCookie.match(/nora_auth=([^;]+)/)?.[1];
    const decoded = jwt.verify(decodeURIComponent(cookieToken), JWT_SECRET);
    expect(decoded).toHaveProperty("id", "uuid-1");
  });
});

describe("POST /auth/session-upgrade", () => {
  it("sets an HttpOnly cookie for a valid HS256 bearer JWT", async () => {
    const token = jwt.sign({ id: "user-1", email: "user@example.com", role: "user" }, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });

    const res = await request(app)
      .post("/auth/session-upgrade")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const setCookie = res.headers["set-cookie"] || [];
    const authCookie = setCookie.find((cookie) => cookie.startsWith("nora_auth="));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/HttpOnly/i);
    expect(authCookie).toMatch(/SameSite=Lax/i);
    expect(decodeURIComponent(authCookie.match(/nora_auth=([^;]+)/)?.[1])).toBe(token);
  });

  it("rejects correctly signed JWTs that do not match the historical session contract", async () => {
    const tokens = [
      jwt.sign({ id: "user-1", arbitrary: true }, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
      jwt.sign({ id: "user-1", agentId: "agent-1", scope: "gateway-embed" }, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "15m",
      }),
      jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
      jwt.sign({ id: "user-1", email: "user@example.com", role: "owner" }, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
      jwt.sign(
        { id: "user-1", email: "user@example.com", role: "user", unexpected: true },
        JWT_SECRET,
        { algorithm: "HS256", expiresIn: "1h" },
      ),
      jwt.sign({ id: "user-1", email: "user@example.com", role: "user" }, JWT_SECRET, {
        algorithm: "HS256",
        noTimestamp: true,
      }),
    ];

    for (const token of tokens) {
      const res = await request(app)
        .post("/auth/session-upgrade")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("rejects a forged bearer JWT even when a valid auth cookie is present", async () => {
    const cookieToken = jwt.sign(
      { id: "user-1", email: "user@example.com", role: "user" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "1h" },
    );
    const forgedBearer = jwt.sign(
      { id: "attacker", email: "attacker@example.com", role: "admin" },
      "wrong-secret",
      { algorithm: "HS256", expiresIn: "1h" },
    );

    const res = await request(app)
      .post("/auth/session-upgrade")
      .set("Cookie", `nora_auth=${cookieToken}`)
      .set("Authorization", `Bearer ${forgedBearer}`);

    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a Nora API key even when a valid auth cookie is present", async () => {
    const cookieToken = jwt.sign(
      { id: "user-1", email: "user@example.com", role: "user" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "1h" },
    );

    const res = await request(app)
      .post("/auth/session-upgrade")
      .set("Cookie", `nora_auth=${cookieToken}`)
      .set("Authorization", "Bearer nora_test_api_key");

    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects expired bearer JWTs without setting a cookie", async () => {
    const expiredToken = jwt.sign(
      { id: "user-1", email: "user@example.com", role: "user" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: -1 },
    );

    const res = await request(app)
      .post("/auth/session-upgrade")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects JWTs signed with a non-HS256 algorithm", async () => {
    const token = jwt.sign({ id: "user-1", email: "user@example.com", role: "user" }, JWT_SECRET, {
      algorithm: "HS384",
      expiresIn: "1h",
    });

    const res = await request(app)
      .post("/auth/session-upgrade")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects signed JWTs without a non-empty string user id", async () => {
    const tokens = [
      jwt.sign("not-a-session", JWT_SECRET, { algorithm: "HS256" }),
      jwt.sign({ email: "user@example.com", role: "user" }, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
      jwt.sign({ id: "   ", email: "user@example.com", role: "user" }, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "1h",
      }),
    ];

    for (const token of tokens) {
      const res = await request(app)
        .post("/auth/session-upgrade")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("rejects missing and malformed bearer headers without setting a cookie", async () => {
    const token = jwt.sign({ id: "user-1", email: "user@example.com", role: "user" }, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const headers = [null, `Basic ${token}`, "Bearer", `Bearer ${token} trailing`];

    for (const authorization of headers) {
      let pendingRequest = request(app).post("/auth/session-upgrade");
      if (authorization) pendingRequest = pendingRequest.set("Authorization", authorization);
      const res = await pendingRequest;

      expect(res.status).toBe(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });
});

describe("Cookie-based authentication", () => {
  it("authenticates protected routes via the nora_auth cookie", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          email: "user@example.com",
          name: "User",
          role: "user",
          provider: null,
          avatar: null,
          preferred_locale: null,
          created_at: new Date().toISOString(),
        },
      ],
    });
    mockDb.query.mockResolvedValueOnce({ rows: [{ default_locale: "es" }] });

    const res = await request(app).get("/auth/me").set("Cookie", `nora_auth=${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "user-1");
    expect(res.body).toMatchObject({
      preferredLocale: null,
      defaultLocale: "es",
      effectiveLocale: "es",
    });
  });

  it("POST /auth/logout clears the auth cookie", async () => {
    const res = await request(app).post("/auth/logout");
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] || [];
    const cleared = setCookie.find((c) => c.startsWith("nora_auth="));
    expect(cleared).toBeDefined();
    // clearCookie emits an Expires in the past and/or empty value.
    expect(cleared).toMatch(/nora_auth=;|Expires=Thu, 01 Jan 1970/);
  });
});

describe("Protected auth routes", () => {
  it("rejects API-key authentication on profile mutation before any DB access", async () => {
    mockValidNoraApiKey();

    const res = await request(app)
      .patch("/auth/profile")
      .set("Authorization", "Bearer nora_valid_profile_key")
      .send({ name: "Changed Name" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "session_required" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("fails closed when hosted PaaS signup has no challenge provider", async () => {
    process.env.PLATFORM_MODE = "paas";
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "none";

    const res = await signupRequest().send({
      email: "hosted-without-challenge@example.com",
      password: "testpassword123",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Could not create account");
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects API-key authentication on password mutation before any DB access", async () => {
    mockValidNoraApiKey();

    const res = await request(app)
      .patch("/auth/password")
      .set("Authorization", "Bearer nora_valid_password_key")
      .send({ currentPassword: "currentpassword123", newPassword: "newpassword123" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "session_required" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects API-key authentication on the current-user endpoint before any DB access", async () => {
    mockValidNoraApiKey();

    const res = await request(app).get("/auth/me").set("Authorization", "Bearer nora_valid_me_key");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "session_required" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects password changes that do not meet the signup password policy", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });

    const res = await request(app)
      .patch("/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "currentpassword123", newPassword: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8 characters/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("accepts profile avatar payloads that fit within the documented upload window", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
    const avatar = `data:image/png;base64,${"a".repeat(250000)}`;

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ name: "User One", avatar, preferred_locale: null }],
      })
      .mockResolvedValueOnce({ rows: [{ default_locale: "en" }] });

    const res = await request(app)
      .patch("/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatar });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "User One",
      avatar,
      preferredLocale: null,
      defaultLocale: "en",
      effectiveLocale: "en",
    });
  });

  it("updates the authenticated user's preferred language", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ name: "User One", avatar: null, preferred_locale: "fr" }],
      })
      .mockResolvedValueOnce({ rows: [{ default_locale: "es" }] });

    const res = await request(app)
      .patch("/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferredLocale: "fr" });

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("preferred_locale = $1"),
      ["fr", "user-1"],
    );
    expect(res.body).toMatchObject({
      preferredLocale: "fr",
      defaultLocale: "es",
      effectiveLocale: "fr",
    });
  });

  it("clears the authenticated user's preferred language to the platform default", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ name: "User One", avatar: null, preferred_locale: null }],
      })
      .mockResolvedValueOnce({ rows: [{ default_locale: "zh-Hant" }] });

    const res = await request(app)
      .patch("/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferredLocale: null });

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("preferred_locale = $1"),
      [null, "user-1"],
    );
    expect(res.body).toMatchObject({
      preferredLocale: null,
      defaultLocale: "zh-Hant",
      effectiveLocale: "zh-Hant",
    });
  });

  it("rejects unsupported preferred languages", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });

    const res = await request(app)
      .patch("/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferredLocale: "de" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/preferredLocale must be one of/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("returns the effective subscription payload for the authenticated user", async () => {
    const billingModule = require("../billing");
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, {
      expiresIn: "1h",
    });

    billingModule.getSubscription.mockResolvedValueOnce({
      plan: "pro",
      status: "active",
      agent_limit: 12,
      agent_limit_override: 12,
      base_agent_limit: 10,
      agent_limit_source: "admin_override",
      is_unlimited: false,
      vcpu: 4,
      ram_mb: 4096,
      disk_gb: 50,
    });
    billingModule.getBackupUsage.mockResolvedValueOnce({
      backup_storage_used_bytes: 2048,
      backup_count_for_agent: 0,
    });
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: "4" }] });

    const res = await request(app)
      .get("/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        plan: "pro",
        status: "active",
        agent_limit: 12,
        agent_limit_override: 12,
        base_agent_limit: 10,
        agent_limit_source: "admin_override",
        is_unlimited: false,
        agents_used: 4,
        backup_storage_used_bytes: 2048,
        vcpu: 4,
        ram_mb: 4096,
        disk_gb: 50,
      }),
    );
  });
});

describe("OAuth hardening", () => {
  it("rejects oauth-login when OAuth is disabled", async () => {
    const res = await request(app)
      .post("/auth/oauth-login")
      .send({ email: "user@example.com", provider: "google" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("rejects oauth-login without a provider token when enabled", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({ email: "user@example.com", provider: "google" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauthAccessToken|oauthIdToken/i);
  });

  it("rejects unsupported OAuth providers before any account lookup", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({ email: "user@example.com", provider: "discord", oauthAccessToken: "test-token" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported oauth provider/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects Google id tokens issued for a different client id", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-123",
        email: "user@example.com",
        email_verified: "true",
        aud: "unexpected-client-id",
        name: "Google User",
      }),
    );

    const res = await request(app).post("/auth/oauth-login").send({
      email: "user@example.com",
      provider: "google",
      providerId: "google-sub-123",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/audience mismatch/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("verifies Google id tokens server-side before issuing a platform JWT", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-123",
        email: "user@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "Google User",
      }),
    );
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "user@example.com", role: "user", name: "Google User" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/oauth-login").send({
      email: "user@example.com",
      provider: "google",
      providerId: "google-sub-123",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://oauth2.googleapis.com/tokeninfo?id_token=google-id-token"),
      undefined,
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      3,
      "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE provider = $1 AND provider_id = $2",
      ["google", "google-sub-123"],
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      4,
      "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE email = $1",
      ["user@example.com"],
    );

    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded).toMatchObject({ id: "user-1", email: "user@example.com", role: "user" });
  });

  it("rejects OAuth registration when signup is disabled", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    process.env.SIGNUP_ENABLED = "false";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-new",
        email: "new-user@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "New Google User",
      }),
    );
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "new-user-1",
            email: "new-user@example.com",
            role: "user",
            name: "New Google User",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/oauth-login").send({
      email: "new-user@example.com",
      provider: "google",
      providerId: "google-sub-new",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Registration is disabled by this Nora operator.",
      code: "SIGNUP_DISABLED",
    });
    expect(
      mockDb.query.mock.calls.some(([query]) => /INSERT INTO users/i.test(String(query))),
    ).toBe(false);
  });

  it("allows existing OAuth users to log in when signup is disabled", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    process.env.SIGNUP_ENABLED = "false";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-existing",
        email: "existing-user@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "Existing Google User",
      }),
    );
    const existingUser = {
      id: "existing-user-1",
      email: "existing-user@example.com",
      role: "user",
      name: "Existing Google User",
      provider: "google",
      provider_id: "google-sub-existing",
      password_hash: null,
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existingUser] })
      .mockResolvedValueOnce({ rows: [existingUser] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: existingUser.id,
            email: existingUser.email,
            role: existingUser.role,
            name: existingUser.name,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/oauth-login").send({
      email: existingUser.email,
      provider: "google",
      providerId: existingUser.provider_id,
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded).toMatchObject({
      id: existingUser.id,
      email: existingUser.email,
      role: existingUser.role,
    });
  });

  it("assigns admin role to the first OAuth-created user", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-123",
        email: "first@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "First Admin",
      }),
    );
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: false }] })
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "first@example.com", role: "admin", name: "First Admin" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/oauth-login").send({
      email: "first@example.com",
      provider: "google",
      providerId: "google-sub-123",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded).toMatchObject({ role: "admin", email: "first@example.com" });
  });

  it("rejects mismatched Google token claims", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-123",
        email: "verified@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "Google User",
      }),
    );

    const res = await request(app).post("/auth/oauth-login").send({
      email: "user@example.com",
      provider: "google",
      providerId: "google-sub-123",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/did not match/i);
  });

  it("verifies GitHub access tokens and resolves verified email server-side", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch
      .mockResolvedValueOnce(
        jsonResponse({ id: 42, login: "octocat", email: null, name: "Octo Cat" }),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ email: "octo@example.com", verified: true, primary: true }]),
      );
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: "user-2", email: "octo@example.com", role: "user", name: "Octo Cat" }],
      });

    const res = await request(app).post("/auth/oauth-login").send({
      email: "octo@example.com",
      provider: "github",
      providerId: "42",
      oauthAccessToken: "gho_test_token",
    });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gho_test_token" }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/user/emails",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gho_test_token" }),
      }),
    );
  });

  it("rejects OAuth login for an email already owned by a password account", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-123",
        email: "user@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "Google User",
      }),
    );
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "user-1",
            email: "user@example.com",
            provider: null,
            provider_id: null,
            password_hash: "bcrypt-hash",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/oauth-login").send({
      email: "user@example.com",
      provider: "google",
      providerId: "google-sub-123",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/password login/i);
  });

  it("rejects OAuth login if the provider account is already linked to a different Nora email", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        sub: "google-sub-123",
        email: "new-email@example.com",
        email_verified: "true",
        aud: "google-client-id",
        name: "Google User",
      }),
    );
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "user-1",
            email: "old-email@example.com",
            provider: "google",
            provider_id: "google-sub-123",
            password_hash: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/oauth-login").send({
      email: "new-email@example.com",
      provider: "google",
      providerId: "google-sub-123",
      oauthIdToken: "google-id-token",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already linked to another Nora user email/i);
  });

  it("rejects query-string JWTs on protected routes", async () => {
    const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get(`/auth/me?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
  });
});

describe("GET /auth/bootstrap-status", () => {
  const disabledSignupBotProtection = {
    enabled: false,
    provider: "none",
    siteKey: null,
    configured: true,
    configurationError: null,
  };

  it("reports needsFirstAdmin=true when no users exist", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/auth/bootstrap-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      needsFirstAdmin: true,
      signupEnabled: true,
      oauthLoginEnabled: false,
      platformMode: "selfhosted",
      signupBotProtection: disabledSignupBotProtection,
    });
  });

  it("reports needsFirstAdmin=false once a user is registered", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    const res = await request(app).get("/auth/bootstrap-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      needsFirstAdmin: false,
      signupEnabled: true,
      oauthLoginEnabled: false,
      platformMode: "selfhosted",
      signupBotProtection: disabledSignupBotProtection,
    });
  });

  it("does not advertise first-admin signup when password registration is disabled", async () => {
    process.env.SIGNUP_ENABLED = "false";
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/auth/bootstrap-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      needsFirstAdmin: false,
      signupEnabled: false,
      oauthLoginEnabled: false,
      platformMode: "selfhosted",
      signupBotProtection: disabledSignupBotProtection,
    });
  });

  it("never advertises public first-admin claim for an empty hosted PaaS database", async () => {
    process.env.PLATFORM_MODE = "paas";
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/auth/bootstrap-status");

    expect(res.status).toBe(200);
    expect(res.body.needsFirstAdmin).toBe(false);
    expect(res.body.platformMode).toBe("paas");
  });

  it("reports runtime OAuth and hosted platform configuration", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    process.env.PLATFORM_MODE = "PAAS";
    mockDb.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/auth/bootstrap-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      needsFirstAdmin: false,
      signupEnabled: true,
      oauthLoginEnabled: true,
      platformMode: "paas",
      signupBotProtection: {
        enabled: true,
        provider: null,
        siteKey: null,
        configured: false,
        configurationError: expect.stringMatching(/required.*no challenge provider/i),
      },
    });
  });

  it("returns only safe public Turnstile configuration without secret material", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.SIGNUP_TURNSTILE_SITE_KEY = "turnstile-site-key";
    process.env.SIGNUP_TURNSTILE_SECRET = "turnstile-secret";
    mockDb.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/auth/bootstrap-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      needsFirstAdmin: false,
      signupEnabled: true,
      oauthLoginEnabled: false,
      platformMode: "selfhosted",
      signupBotProtection: {
        enabled: true,
        provider: "turnstile",
        siteKey: "turnstile-site-key",
        configured: true,
        configurationError: null,
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("turnstile-secret");
  });

  it("accepts the legacy public site-key alias at runtime", async () => {
    process.env.NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER = "recaptcha";
    process.env.NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY = "legacy-recaptcha-site-key";
    process.env.SIGNUP_RECAPTCHA_SECRET = "recaptcha-secret";
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/auth/bootstrap-status");

    expect(res.status).toBe(200);
    expect(res.body.signupBotProtection).toEqual({
      enabled: true,
      provider: "recaptcha",
      siteKey: "legacy-recaptcha-site-key",
      configured: true,
      configurationError: null,
    });
    expect(JSON.stringify(res.body)).not.toContain("recaptcha-secret");
  });

  it("reports a fail-closed public configuration error when the site key is missing", async () => {
    process.env.SIGNUP_BOT_PROTECTION_PROVIDER = "turnstile";
    process.env.SIGNUP_TURNSTILE_SECRET = "turnstile-secret";
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/auth/bootstrap-status");

    expect(res.status).toBe(200);
    expect(res.body.signupBotProtection).toEqual({
      enabled: true,
      provider: "turnstile",
      siteKey: null,
      configured: false,
      configurationError: expect.stringMatching(/public site key is missing/i),
    });
  });
});
