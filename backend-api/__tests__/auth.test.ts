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
jest.mock("../redisQueue", () => ({ addDeploymentJob: jest.fn(), getDLQJobs: jest.fn(), retryDLQJob: jest.fn() }));
jest.mock("../scheduler", () => ({ selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }) }));
jest.mock("../containerManager", () => ({
  start: jest.fn(), stop: jest.fn(), restart: jest.fn(), destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../marketplace", () => ({
  listMarketplace: jest.fn().mockResolvedValue([]),
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
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
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
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
  recordApiMetric: jest.fn(),
}));

const app = require("../server");

function jsonResponse(body, ok = true, status = ok ? 200 : 400) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockDb.connect.mockReset();
  mockDb.connect.mockResolvedValue({
    query: mockDb.query,
    release: jest.fn(),
  });
  process.env.OAUTH_LOGIN_ENABLED = "false";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  global.fetch = jest.fn();
});

describe("POST /auth/signup", () => {
  it("rejects missing email", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ password: "testpassword123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejects invalid email format", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "notanemail", password: "testpassword123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejects short password", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "test@example.com", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it("creates the first registered user as admin", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: false }] })
      .mockResolvedValueOnce({
        rows: [{ id: "uuid-1", email: "new@example.com", role: "admin" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "new@example.com", password: "validpassword123" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "uuid-1");
    expect(res.body).toHaveProperty("email", "new@example.com");
    expect(res.body).toHaveProperty("role", "admin");
  });

  it("creates additional registered users as regular users", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: "uuid-2", email: "next@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "next@example.com", password: "validpassword123" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("role", "user");
  });

  it("returns 500 on duplicate email (DB unique constraint)", async () => {
    const err = new Error("duplicate key value violates unique constraint");
    err.code = "23505";
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "dup@example.com", password: "validpassword123" });
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
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
});

describe("Protected auth routes", () => {
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

    mockDb.query.mockResolvedValueOnce({
      rows: [{ name: "User One", avatar }],
    });

    const res = await request(app)
      .patch("/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatar });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "User One", avatar });
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
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sub: "google-sub-123",
      email: "user@example.com",
      email_verified: "true",
      aud: "unexpected-client-id",
      name: "Google User",
    }));

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
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
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sub: "google-sub-123",
      email: "user@example.com",
      email_verified: "true",
      aud: "google-client-id",
      name: "Google User",
    }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "user-1", email: "user@example.com", role: "user", name: "Google User" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
        email: "user@example.com",
        provider: "google",
        providerId: "google-sub-123",
        oauthIdToken: "google-id-token",
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://oauth2.googleapis.com/tokeninfo?id_token=google-id-token"),
      undefined
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(3,
      "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE provider = $1 AND provider_id = $2",
      ["google", "google-sub-123"]
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(4,
      "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE email = $1",
      ["user@example.com"]
    );

    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded).toMatchObject({ id: "user-1", email: "user@example.com", role: "user" });
  });

  it("assigns admin role to the first OAuth-created user", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sub: "google-sub-123",
      email: "first@example.com",
      email_verified: "true",
      aud: "google-client-id",
      name: "First Admin",
    }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: false }] })
      .mockResolvedValueOnce({ rows: [{ id: "user-1", email: "first@example.com", role: "admin", name: "First Admin" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
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
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sub: "google-sub-123",
      email: "verified@example.com",
      email_verified: "true",
      aud: "google-client-id",
      name: "Google User",
    }));

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
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
      .mockResolvedValueOnce(jsonResponse({ id: 42, login: "octocat", email: null, name: "Octo Cat" }))
      .mockResolvedValueOnce(jsonResponse([
        { email: "octo@example.com", verified: true, primary: true },
      ]));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ has_users: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "user-2", email: "octo@example.com", role: "user", name: "Octo Cat" }] });

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
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
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/user/emails",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gho_test_token" }),
      })
    );
  });

  it("rejects OAuth login for an email already owned by a password account", async () => {
    process.env.OAUTH_LOGIN_ENABLED = "true";
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sub: "google-sub-123",
      email: "user@example.com",
      email_verified: "true",
      aud: "google-client-id",
      name: "Google User",
    }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "user@example.com", provider: null, provider_id: null, password_hash: "bcrypt-hash" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
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
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sub: "google-sub-123",
      email: "new-email@example.com",
      email_verified: "true",
      aud: "google-client-id",
      name: "Google User",
    }));
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "old-email@example.com", provider: "google", provider_id: "google-sub-123", password_hash: null }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/auth/oauth-login")
      .send({
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
    expect(res.body.error).toMatch(/bearer token required/i);
  });
});
