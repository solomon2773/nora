// @ts-nocheck
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

// Point the registry client's os.tmpdir()-based disk cache at an isolated
// directory so parallel jest workers never share cache files.
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nora-hermes-skills-routes-test-"));
jest.spyOn(os, "tmpdir").mockReturnValue(CACHE_DIR);

jest.mock("../db", () => ({
  query: jest.fn(),
}));

jest.mock("../authSync", () => ({
  runContainerCommand: jest.fn(),
}));

jest.mock("../redisQueue", () => ({
  addHermesSkillJob: jest.fn(),
  findInFlightHermesSkillJob: jest.fn(),
  getHermesSkillJobStatus: jest.fn(),
  hermesSkillsQueue: { getJobs: jest.fn() },
}));

const { __resetCacheForTests } = require("../hermesSkillsClient");
const db = require("../db");
const { runContainerCommand } = require("../authSync");
const {
  addHermesSkillJob,
  findInFlightHermesSkillJob,
  getHermesSkillJobStatus,
  hermesSkillsQueue,
} = require("../redisQueue");
const router = require("../routes/hermesSkills");

const EMPTY_LOCK_B64 = Buffer.from('{"version":1,"installed":{}}').toString("base64");

function lockfileB64(installed) {
  return Buffer.from(JSON.stringify({ version: 1, installed })).toString("base64");
}

function buildIndexPayload(skills) {
  return {
    version: 1,
    generated_at: "2026-07-01T00:00:00Z",
    skill_count: skills.length,
    skills,
  };
}

const INDEX_SKILLS = [
  {
    name: "1password",
    description: "Manage 1Password vaults.",
    source: "official",
    identifier: "official/security/1password",
    trust_level: "builtin",
    repo: "https://github.com/nousresearch/hermes-skills",
    path: "security/1password",
    tags: ["security"],
    extra: { verified: true },
  },
  {
    name: "k8s",
    description: "Operate Kubernetes clusters.",
    source: "clawhub",
    identifier: "openai/skills/k8s",
    trust_level: "community",
    repo: "https://github.com/openai/skills",
    path: "skills/k8s",
    tags: ["kubernetes"],
    extra: {},
  },
];

function mockJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

describe("hermes skills routes", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.clearAllMocks();
    __resetCacheForTests();
  });

  afterEach(() => {
    delete global.fetch;
  });

  function getRouteHandler(path, method = "get") {
    const layer = router.stack.find(
      (entry) => entry.route?.path === path && entry.route.methods?.[method],
    );
    if (!layer) {
      throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack.at(-1).handle;
  }

  function createMockRes() {
    return {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  function buildApiKeyApp(scopes) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: "user-1" };
      req.apiKey = { id: "key-1", workspaceId: "ws-A", scopes };
      req.apiKeyWorkspace = { id: "ws-A" };
      next();
    });
    app.use(router);
    return app;
  }

  it("requires agents scopes before API-key Hermes skill agent access", async () => {
    const app = buildApiKeyApp(["workspaces:read"]);

    const res = await request(app).get("/agents/agent-1/skills");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("requires the write scope for API-key Hermes skill mutations", async () => {
    const app = buildApiKeyApp(["agents:read"]);

    const res = await request(app)
      .post("/agents/agent-1/skills/install")
      .send({ ref: "official/security/1password", name: "1password" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects API-key Hermes skill access outside the bound workspace", async () => {
    const app = buildApiKeyApp(["agents:read"]);
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/agents/agent-1/skills");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
    expect(runContainerCommand).not.toHaveBeenCalled();
  });

  it("keeps Remote Docker Hermes skill access session-only for API keys", async () => {
    const app = buildApiKeyApp(["agents:read"]);
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          backend_type: "remote-docker",
          deploy_target: "remote-docker",
          execution_target_id: "remote:host-a",
        },
      ],
    });

    const res = await request(app).get("/agents/agent-1/skills");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
    expect(runContainerCommand).not.toHaveBeenCalled();
  });

  it("binds API-key Hermes skill job polling to the job's agent workspace", async () => {
    const app = buildApiKeyApp(["agents:read"]);
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-other",
      agentId: "agent-other",
      status: "success",
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/jobs/job-other");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "job_not_found" });
  });

  it("hides a Hermes skill job when its agent becomes Remote Docker before authorization", async () => {
    const app = buildApiKeyApp(["agents:read"]);
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-remote-race",
      agentId: "agent-1",
      status: "success",
    });
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          backend_type: "remote-docker",
          deploy_target: "remote-docker",
          execution_target_id: "remote:host-a",
        },
      ],
    });

    const res = await request(app).get("/jobs/job-remote-race");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "job_not_found" });
  });

  it("allows API-key Hermes skill access to a teammate-owned assigned agent", async () => {
    const app = buildApiKeyApp(["agents:read"]);
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "agent-1", backend_type: "docker", deploy_target: "docker" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            user_id: "teammate-1",
            status: "running",
            container_id: "container-1",
            backend_type: "docker",
            runtime_family: "hermes",
            deploy_target: "docker",
            sandbox_profile: "standard",
            hermes_skills: [],
          },
        ],
      });
    runContainerCommand.mockResolvedValueOnce({ output: EMPTY_LOCK_B64 });
    hermesSkillsQueue.getJobs.mockResolvedValueOnce([]);

    const res = await request(app).get("/agents/agent-1/skills");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skills: [] });
    expect(db.query.mock.calls[1][0]).toMatch(/FROM workspace_agents wa/);
  });

  it("returns the same not-found response for missing and unauthorized jobs", async () => {
    const app = buildApiKeyApp(["agents:read"]);

    getHermesSkillJobStatus.mockResolvedValueOnce(null);
    const missing = await request(app).get("/jobs/job-missing");

    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-private",
      agentId: "agent-private",
      status: "success",
    });
    db.query.mockResolvedValueOnce({ rows: [] });
    const unauthorized = await request(app).get("/jobs/job-private");

    expect(missing.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(missing.body).toEqual({ error: "job_not_found" });
    expect(unauthorized.body).toEqual(missing.body);
  });

  it("returns normalized browse results and caps limit at 50", async () => {
    const handler = getRouteHandler("/skills");
    const manySkills = Array.from({ length: 60 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Skill number ${index}.`,
      source: "official",
      identifier: `official/generated/skill-${index}`,
      trust_level: "community",
      tags: [],
    }));
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload(manySkills)));

    const req = { query: { limit: "70" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.skills).toHaveLength(50);
    expect(res.body.nextCursor).toBe("50");
    expect(res.body.stale).toBe(false);
    expect(res.body.skills[0]).toEqual({
      ref: "official/generated/skill-0",
      name: "skill-0",
      description: "Skill number 0.",
      source: "official",
      trustLevel: "community",
      tags: [],
    });
  });

  it("pages the browse list with the numeric offset cursor", async () => {
    const handler = getRouteHandler("/skills");
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload(INDEX_SKILLS)));

    const req = { query: { limit: "1", cursor: "1" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.skills.map((skill) => skill.ref)).toEqual(["openai/skills/k8s"]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns missing_query when search input is empty", async () => {
    const handler = getRouteHandler("/skills/search");
    const req = { query: { q: "" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "missing_query",
      message: "q is required.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches the cached index case-insensitively", async () => {
    const handler = getRouteHandler("/skills/search");
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload(INDEX_SKILLS)));

    const req = { query: { q: "KUBERNETES" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.skills.map((skill) => skill.ref)).toEqual(["openai/skills/k8s"]);
  });

  it("returns the full index entry from the query-param detail route", async () => {
    // The ref is a query parameter because registry identifiers contain
    // slashes and cannot be a single path segment.
    const handler = getRouteHandler("/skills/detail");
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload(INDEX_SKILLS)));

    const req = { query: { ref: "official/security/1password" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ref: "official/security/1password",
      name: "1password",
      description: "Manage 1Password vaults.",
      source: "official",
      trustLevel: "builtin",
      tags: ["security"],
      repo: "https://github.com/nousresearch/hermes-skills",
      path: "security/1password",
      extra: { verified: true },
      stale: false,
    });
  });

  it("returns skill_not_found for an unknown detail ref", async () => {
    const handler = getRouteHandler("/skills/detail");
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload(INDEX_SKILLS)));

    const req = { query: { ref: "official/does/not-exist" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: "skill_not_found",
      message: "No skill found with ref: official/does/not-exist",
    });
  });

  it("returns hermes_registry_unavailable when the registry cannot be reached", async () => {
    const handler = getRouteHandler("/skills");
    fetchMock.mockRejectedValue(new Error("network down"));

    const req = { query: {} };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: "hermes_registry_unavailable",
      message: "Could not reach the Hermes skills registry.",
    });
  });

  it("returns merged saved/runtime/pending skill state", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "hermes",
          deploy_target: "docker",
          sandbox_profile: "standard",
          hermes_skills: [
            {
              source: "hermes-hub",
              ref: "official/productivity/github",
              name: "github",
              installMode: "cli",
              installedAt: "2026-07-01T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    runContainerCommand.mockResolvedValueOnce({
      output: lockfileB64({
        github: { version: "2.1.0", install_path: "/opt/data/home/.hermes/skills/github" },
        notion: { version: "1.0.0", install_path: "/opt/data/home/.hermes/skills/notion" },
      }),
    });
    hermesSkillsQueue.getJobs.mockResolvedValueOnce([
      { data: { agentId: "agent-1", name: "notion", operation: "delete" } },
      { data: { agentId: "agent-other", name: "github", operation: "delete" } },
    ]);

    const req = { params: { agentId: "agent-1" }, user: { id: "user-1" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(runContainerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.stringContaining("/opt/data/skills/.hub/lock.json"),
    );
    expect(res.body).toEqual({
      skills: [
        {
          name: "github",
          version: "2.1.0",
          saved: true,
          installed: true,
          source: "hermes-hub",
          ref: "official/productivity/github",
          installMode: "cli",
          installedAt: "2026-07-01T00:00:00.000Z",
          status: "healthy",
        },
        {
          name: "notion",
          version: "1.0.0",
          saved: false,
          installed: true,
          source: "hermes-hub",
          ref: "",
          installMode: "cli",
          installedAt: null,
          status: "pending_delete",
        },
      ],
    });
  });

  // The Skills panel lives inside the Hermes WebUI tab, whose sibling routes
  // (/agents/:id/hermes-ui and its chat/cron/channel endpoints) authorize
  // through workspace membership. These pin the Skills routes to the same
  // model: a member who can see and operate a shared agent must not hit a bare
  // 404 here just because someone else owns the agent row.
  describe("workspace-shared agents", () => {
    const OWNER_ID = "agent-owner";
    const SHARED_AGENT = {
      id: "agent-shared",
      user_id: OWNER_ID,
      status: "running",
      container_id: "container-shared",
      backend_type: "docker",
      runtime_family: "hermes",
      deploy_target: "docker",
      sandbox_profile: "standard",
      hermes_skills: [],
    };

    // Faithful stand-in for the `agents` lookup: an owner-scoped statement
    // (`AND user_id = $2`) really does filter non-owners out, so a lookup that
    // never consults workspace_members cannot pass these tests by accident.
    function mockSharedAgentLookup(memberships) {
      db.query.mockImplementation(async (sql, params = []) => {
        const text = String(sql);
        if (text.includes("workspace_members")) {
          const role = memberships[params[1]];
          return { rows: role ? [{ role }] : [] };
        }
        if (!text.includes("FROM agents")) return { rows: [] };
        if (params[0] !== SHARED_AGENT.id) return { rows: [] };
        if (/user_id\s*=\s*\$2/.test(text) && params[1] !== OWNER_ID) return { rows: [] };
        return { rows: [SHARED_AGENT] };
      });
    }

    function sessionReq(userId, body = {}) {
      return { params: { agentId: SHARED_AGENT.id }, user: { id: userId }, body };
    }

    it("lists skills for a workspace viewer who does not own the agent", async () => {
      mockSharedAgentLookup({ "member-1": "viewer" });
      runContainerCommand.mockResolvedValueOnce({ output: EMPTY_LOCK_B64 });
      hermesSkillsQueue.getJobs.mockResolvedValueOnce([]);

      const res = createMockRes();
      await getRouteHandler("/agents/:agentId/skills")(sessionReq("member-1"), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ skills: [] });
    });

    it("installs a skill for a workspace editor who does not own the agent", async () => {
      mockSharedAgentLookup({ "member-1": "editor" });
      findInFlightHermesSkillJob.mockResolvedValueOnce(null);
      addHermesSkillJob.mockResolvedValueOnce({ id: "job-1" });

      const res = createMockRes();
      await getRouteHandler("/agents/:agentId/skills/install", "post")(
        sessionReq("member-1", { ref: "official/security/1password", name: "1password" }),
        res,
      );

      expect(res.statusCode).toBe(202);
      expect(addHermesSkillJob).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: SHARED_AGENT.id, name: "1password" }),
      );
    });

    // Mirrors loadHermesUiAgent: an insufficient role resolves to no agent, so
    // the mutation reports agent_not_found rather than leaking the role gap.
    it("refuses installs from a read-only workspace viewer", async () => {
      mockSharedAgentLookup({ "member-1": "viewer" });

      const res = createMockRes();
      await getRouteHandler("/agents/:agentId/skills/install", "post")(
        sessionReq("member-1", { ref: "official/security/1password", name: "1password" }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(addHermesSkillJob).not.toHaveBeenCalled();
    });

    it("refuses deletes from a read-only workspace viewer", async () => {
      mockSharedAgentLookup({ "member-1": "viewer" });

      const res = createMockRes();
      await getRouteHandler("/agents/:agentId/skills/delete", "post")(
        sessionReq("member-1", { name: "1password" }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(addHermesSkillJob).not.toHaveBeenCalled();
    });

    it("hides the agent from a user with no membership in any sharing workspace", async () => {
      mockSharedAgentLookup({ "member-1": "editor" });

      const res = createMockRes();
      await getRouteHandler("/agents/:agentId/skills")(sessionReq("stranger"), res);

      expect(res.statusCode).toBe(404);
      expect(runContainerCommand).not.toHaveBeenCalled();
    });

    it("scopes job polling to a workspace member's access", async () => {
      mockSharedAgentLookup({ "member-1": "viewer" });
      getHermesSkillJobStatus.mockResolvedValueOnce({
        agentId: SHARED_AGENT.id,
        status: "completed",
        operation: "install",
      });

      const res = createMockRes();
      await getRouteHandler("/jobs/:jobId")(
        { params: { jobId: "job-1" }, user: { id: "member-1" } },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ agentId: SHARED_AGENT.id, status: "completed" });
    });
  });

  it("returns unsupported_runtime for non-hermes agents", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "openclaw",
          hermes_skills: [],
        },
      ],
    });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { ref: "official/security/1password", name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "unsupported_runtime",
      message: "Hermes skills are only available for Hermes agents.",
    });
  });

  it("returns container_not_running when the agent is stopped", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "stopped",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "hermes",
          hermes_skills: [],
        },
      ],
    });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { ref: "official/security/1password", name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "container_not_running",
      message: "Start the agent before managing Hermes skills.",
    });
  });

  function mockRunningHermesAgent() {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "hermes",
          hermes_skills: [],
        },
      ],
    });
  }

  it("returns missing_ref when the install body has no ref", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");
    mockRunningHermesAgent();

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("missing_ref");
    expect(addHermesSkillJob).not.toHaveBeenCalled();
  });

  it("returns invalid_name for an invalid or missing install name", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");

    mockRunningHermesAgent();
    const missingName = createMockRes();
    await handler(
      {
        params: { agentId: "agent-1" },
        user: { id: "user-1" },
        body: { ref: "official/security/1password" },
      },
      missingName,
    );

    mockRunningHermesAgent();
    const traversalName = createMockRes();
    await handler(
      {
        params: { agentId: "agent-1" },
        user: { id: "user-1" },
        body: { ref: "official/security/1password", name: "../evil" },
      },
      traversalName,
    );

    expect(missingName.statusCode).toBe(400);
    expect(missingName.body.error).toBe("invalid_name");
    expect(traversalName.statusCode).toBe(400);
    expect(traversalName.body.error).toBe("invalid_name");
    expect(addHermesSkillJob).not.toHaveBeenCalled();
  });

  it("returns reserved_skill for Nora-managed skill names", async () => {
    const installHandler = getRouteHandler("/agents/:agentId/skills/install", "post");
    const deleteHandler = getRouteHandler("/agents/:agentId/skills/delete", "post");

    mockRunningHermesAgent();
    const installRes = createMockRes();
    await installHandler(
      {
        params: { agentId: "agent-1" },
        user: { id: "user-1" },
        body: { ref: "official/nora/nora-integrations", name: "nora-integrations" },
      },
      installRes,
    );

    mockRunningHermesAgent();
    const deleteRes = createMockRes();
    await deleteHandler(
      {
        params: { agentId: "agent-1" },
        user: { id: "user-1" },
        body: { name: "nora-integrations" },
      },
      deleteRes,
    );

    expect(installRes.statusCode).toBe(400);
    expect(installRes.body).toEqual({
      error: "reserved_skill",
      message: 'Skill "nora-integrations" is managed by Nora and cannot be installed.',
    });
    expect(deleteRes.statusCode).toBe(400);
    expect(deleteRes.body).toEqual({
      error: "reserved_skill",
      message: 'Skill "nora-integrations" is managed by Nora and cannot be removed.',
    });
    expect(addHermesSkillJob).not.toHaveBeenCalled();
  });

  it("reuses an in-flight install job when one already exists", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");
    mockRunningHermesAgent();
    findInFlightHermesSkillJob.mockResolvedValueOnce({ id: "job-1" });
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-1",
      agentId: "agent-1",
      name: "1password",
      operation: "install",
      status: "running",
      error: null,
      completedAt: null,
    });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { ref: "official/security/1password", name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      jobId: "job-1",
      agentId: "agent-1",
      name: "1password",
      operation: "install",
      status: "running",
    });
    expect(addHermesSkillJob).not.toHaveBeenCalled();
  });

  it("blocks install when a delete job is already in progress", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");
    mockRunningHermesAgent();
    findInFlightHermesSkillJob.mockResolvedValueOnce({ id: "job-del-1" });
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-del-1",
      agentId: "agent-1",
      name: "1password",
      operation: "delete",
      status: "running",
      error: null,
      completedAt: null,
    });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { ref: "official/security/1password", name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "conflicting_job",
      message: "A Hermes skill delete job is already in progress for this skill.",
      jobId: "job-del-1",
      operation: "delete",
    });
    expect(addHermesSkillJob).not.toHaveBeenCalled();
  });

  it("enqueues a new install job with a persistable skill entry", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/install", "post");
    mockRunningHermesAgent();
    findInFlightHermesSkillJob.mockResolvedValueOnce(null);
    addHermesSkillJob.mockResolvedValueOnce({ id: "job-2" });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { ref: "official/security/1password", name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(addHermesSkillJob).toHaveBeenCalledWith({
      agentId: "agent-1",
      name: "1password",
      ref: "official/security/1password",
      operation: "install",
      skillEntry: {
        source: "hermes-hub",
        ref: "official/security/1password",
        name: "1password",
        installMode: "cli",
        installedAt: expect.any(String),
      },
      persistOnSuccess: true,
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      jobId: "job-2",
      agentId: "agent-1",
      name: "1password",
      operation: "install",
      status: "pending",
    });
  });

  it("reuses an in-flight delete job when one already exists", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/delete", "post");
    mockRunningHermesAgent();
    findInFlightHermesSkillJob.mockResolvedValueOnce({ id: "job-del-1" });
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-del-1",
      agentId: "agent-1",
      name: "1password",
      operation: "delete",
      status: "running",
      error: null,
      completedAt: null,
    });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      jobId: "job-del-1",
      agentId: "agent-1",
      name: "1password",
      operation: "delete",
      status: "running",
    });
    expect(addHermesSkillJob).not.toHaveBeenCalled();
  });

  it("blocks delete when an install job is already in progress", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/delete", "post");
    mockRunningHermesAgent();
    findInFlightHermesSkillJob.mockResolvedValueOnce({ id: "job-inst-1" });
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-inst-1",
      agentId: "agent-1",
      name: "1password",
      operation: "install",
      status: "running",
      error: null,
      completedAt: null,
    });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { name: "1password" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "conflicting_job",
      message: "A Hermes skill install job is already in progress for this skill.",
      jobId: "job-inst-1",
      operation: "install",
    });
  });

  it("enqueues a delete job that removes the saved entry on success", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/delete", "post");
    mockRunningHermesAgent();
    findInFlightHermesSkillJob.mockResolvedValueOnce(null);
    addHermesSkillJob.mockResolvedValueOnce({ id: "job-del-2" });

    const req = {
      params: { agentId: "agent-1" },
      user: { id: "user-1" },
      body: { name: "notion" },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(addHermesSkillJob).toHaveBeenCalledWith({
      agentId: "agent-1",
      name: "notion",
      operation: "delete",
      removeSavedEntryOnSuccess: true,
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      jobId: "job-del-2",
      agentId: "agent-1",
      name: "notion",
      operation: "delete",
      status: "pending",
    });
  });

  it("returns job_not_found when the job lookup misses", async () => {
    const handler = getRouteHandler("/jobs/:jobId");
    getHermesSkillJobStatus.mockResolvedValueOnce(null);

    const req = { params: { jobId: "missing-job" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "job_not_found" });
  });

  it("returns normalized job status when the job exists", async () => {
    const handler = getRouteHandler("/jobs/:jobId");
    getHermesSkillJobStatus.mockResolvedValueOnce({
      jobId: "job-3",
      agentId: "agent-1",
      name: "1password",
      operation: "install",
      status: "success",
      error: null,
      completedAt: "2026-07-30T01:00:00.000Z",
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: "agent-1", user_id: "user-1" }],
    });

    const req = { params: { jobId: "job-3" }, user: { id: "user-1" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      jobId: "job-3",
      agentId: "agent-1",
      name: "1password",
      operation: "install",
      status: "success",
      error: null,
      completedAt: "2026-07-30T01:00:00.000Z",
    });
  });

  describe("skills library", () => {
    it("lists library entries without requiring agent scopes", async () => {
      const app = buildApiKeyApp(["workspaces:read"]);
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-2222-4333-8444-555555555555",
            ref: "official/security/1password",
            name: "1password",
            description: "Manage 1Password vaults.",
            added_by_user_id: "user-1",
            created_at: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
      });

      const res = await request(app).get("/library");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        skills: [
          {
            id: "11111111-2222-4333-8444-555555555555",
            ref: "official/security/1password",
            name: "1password",
            description: "Manage 1Password vaults.",
            addedByUserId: "user-1",
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      });
    });

    it("inserts a new library entry and returns 201", async () => {
      const handler = getRouteHandler("/library", "post");
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-2222-4333-8444-555555555555",
            ref: "official/security/1password",
            name: "1password",
            description: "Manage 1Password vaults.",
            added_by_user_id: "user-1",
            created_at: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
      });

      const req = {
        user: { id: "user-1" },
        body: {
          ref: "official/security/1password",
          name: "1password",
          description: "Manage 1Password vaults.",
        },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO hermes_skills_library/),
        ["official/security/1password", "1password", "Manage 1Password vaults.", "user-1"],
      );
      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({
        id: "11111111-2222-4333-8444-555555555555",
        ref: "official/security/1password",
        name: "1password",
        description: "Manage 1Password vaults.",
        addedByUserId: "user-1",
        createdAt: "2026-07-01T00:00:00.000Z",
      });
    });

    it("returns the existing entry with 200 when the ref is already pinned", async () => {
      const handler = getRouteHandler("/library", "post");
      db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-2222-4333-8444-555555555555",
            ref: "official/security/1password",
            name: "1password-original",
            description: "Original description.",
            added_by_user_id: "someone-else",
            created_at: new Date("2026-06-01T00:00:00.000Z"),
          },
        ],
      });

      const req = {
        user: { id: "user-1" },
        body: { ref: "official/security/1password", name: "1password" },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        id: "11111111-2222-4333-8444-555555555555",
        ref: "official/security/1password",
        name: "1password-original",
        description: "Original description.",
        addedByUserId: "someone-else",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
    });

    it("validates library additions like installs", async () => {
      const handler = getRouteHandler("/library", "post");

      const missingRef = createMockRes();
      await handler({ user: { id: "user-1" }, body: { name: "1password" } }, missingRef);

      const invalidName = createMockRes();
      await handler(
        { user: { id: "user-1" }, body: { ref: "official/x", name: "bad name!" } },
        invalidName,
      );

      const reserved = createMockRes();
      await handler(
        { user: { id: "user-1" }, body: { ref: "official/x", name: "nora-integrations" } },
        reserved,
      );

      expect(missingRef.statusCode).toBe(400);
      expect(missingRef.body.error).toBe("missing_ref");
      expect(invalidName.statusCode).toBe(400);
      expect(invalidName.body.error).toBe("invalid_name");
      expect(reserved.statusCode).toBe(400);
      expect(reserved.body).toEqual({
        error: "reserved_skill",
        message: 'Skill "nora-integrations" is managed by Nora and cannot be added to the library.',
      });
      expect(db.query).not.toHaveBeenCalled();
    });

    it("deletes a library entry and returns 204", async () => {
      const handler = getRouteHandler("/library/:id", "delete");
      db.query.mockResolvedValueOnce({
        rows: [{ id: "11111111-2222-4333-8444-555555555555" }],
      });

      const req = {
        params: { id: "11111111-2222-4333-8444-555555555555" },
        user: { id: "user-1" },
      };
      const res = createMockRes();
      await handler(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM hermes_skills_library/),
        ["11111111-2222-4333-8444-555555555555"],
      );
      expect(res.statusCode).toBe(204);
    });

    it("returns 404 for an unknown or malformed library entry id", async () => {
      const handler = getRouteHandler("/library/:id", "delete");

      db.query.mockResolvedValueOnce({ rows: [] });
      const unknown = createMockRes();
      await handler(
        { params: { id: "11111111-2222-4333-8444-555555555555" }, user: { id: "user-1" } },
        unknown,
      );

      const malformed = createMockRes();
      await handler({ params: { id: "not-a-uuid" }, user: { id: "user-1" } }, malformed);

      expect(unknown.statusCode).toBe(404);
      expect(unknown.body).toEqual({ error: "library_entry_not_found" });
      expect(malformed.statusCode).toBe(404);
      expect(malformed.body).toEqual({ error: "library_entry_not_found" });
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });
});
