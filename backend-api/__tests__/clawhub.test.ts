// @ts-nocheck
jest.mock("../db", () => ({
  query: jest.fn(),
}));

jest.mock("../authSync", () => ({
  runContainerCommand: jest.fn(),
}));

jest.mock("../redisQueue", () => ({
  addClawhubInstallJob: jest.fn(),
  findInFlightClawhubInstallJob: jest.fn(),
  getClawhubInstallJobStatus: jest.fn(),
}));

const { normalizeSkillDetailPayload, parseSkillMarkdown } = require("../clawhubClient");
const db = require("../db");
const { runContainerCommand } = require("../authSync");
const {
  addClawhubInstallJob,
  findInFlightClawhubInstallJob,
  getClawhubInstallJobStatus,
} = require("../redisQueue");
const router = require("../routes/clawhub");

function mockJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

function mockTextResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(text),
  };
}

describe("clawhub client markdown parsing", () => {
  it("parses requirements from SKILL.md frontmatter", () => {
    const parsed = parseSkillMarkdown(`---
metadata:
  openclaw:
    requires:
      bins:
        - gh
      env:
        - GITHUB_TOKEN
      config: []
    install:
      - kind: node
        package: "@github/gh-cli"
---
# GitHub Skill

Ship pull requests fast.
`);

    expect(parsed).toEqual({
      readme: "# GitHub Skill\n\nShip pull requests fast.",
      requirements: {
        bins: ["gh"],
        env: ["GITHUB_TOKEN"],
        config: [],
        install: [{ kind: "node", package: "@github/gh-cli" }],
      },
    });
  });

  it("returns null requirements when no openclaw metadata exists", () => {
    const detail = normalizeSkillDetailPayload(
      {
        slug: "plain-skill",
        name: "Plain Skill",
      },
      "# Plain Skill\n\nNo frontmatter here.",
    );

    expect(detail).toMatchObject({
      slug: "plain-skill",
      readme: "# Plain Skill\n\nNo frontmatter here.",
      requirements: null,
    });
  });
});

describe("clawhub routes", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.clearAllMocks();
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
    return layer.route.stack[0].handle;
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
    };
  }

  it("returns normalized browse results and caps limit at 50", async () => {
    const handler = getRouteHandler("/skills");
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(200, { registryBaseUrl: "https://registry.clawhub.ai" }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          skills: [
            {
              slug: "github",
              name: "GitHub",
              description: "Manage issues.",
              downloads: 94200,
              stars: 1200,
              updated_at: "2026-04-01T12:00:00Z",
            },
          ],
          next_cursor: "next-page",
        }),
      );

    const req = { query: { limit: "70", cursor: "abc" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      skills: [
        {
          slug: "github",
          name: "GitHub",
          description: "Manage issues.",
          downloads: 94200,
          stars: 1200,
          updatedAt: "2026-04-01T12:00:00.000Z",
        },
      ],
      cursor: "next-page",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://registry.clawhub.ai/api/v1/skills?limit=50&cursor=abc",
      expect.any(Object),
    );
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

  it("returns normalized detail with parsed requirements from SKILL.md", async () => {
    const handler = getRouteHandler("/skills/:slug");
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(200, { registryBaseUrl: "https://registry.clawhub.ai" }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          skill: {
            slug: "github",
            name: "GitHub",
            description: "Manage issues.",
            downloads: 94200,
            stars: 1200,
            updatedAt: "2026-04-01T12:00:00Z",
          },
          owner: {
            handle: "steipete",
          },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, { registryBaseUrl: "https://registry.clawhub.ai" }),
      )
      .mockResolvedValueOnce(
        mockTextResponse(
          200,
          `---
metadata:
  openclaw:
    requires:
      bins:
        - gh
      env:
        - GITHUB_TOKEN
    install:
      - kind: node
        package: "@github/gh-cli"
---
# GitHub Skill

Install and manage repos.
`,
        ),
      );

    const req = { params: { slug: "github" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      slug: "github",
      name: "GitHub",
      description: "Manage issues.",
      downloads: 94200,
      stars: 1200,
      updatedAt: "2026-04-01T12:00:00.000Z",
      author: "steipete",
      pagePath: "steipete/github",
      readme: "# GitHub Skill\n\nInstall and manage repos.",
      requirements: {
        bins: ["gh"],
        env: ["GITHUB_TOKEN"],
        config: [],
        install: [{ kind: "node", package: "@github/gh-cli" }],
      },
    });
  });

  it("returns skill_not_found when the skill metadata is missing", async () => {
    const handler = getRouteHandler("/skills/:slug");
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(200, { registryBaseUrl: "https://registry.clawhub.ai" }),
      )
      .mockResolvedValueOnce(mockJsonResponse(404, { error: "not_found" }));

    const req = { params: { slug: "unknown-skill" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: "skill_not_found",
      message: "No skill found with slug: unknown-skill",
    });
  });

  it("returns clawhub_unavailable when ClawHub cannot be reached", async () => {
    const handler = getRouteHandler("/skills");
    fetchMock.mockRejectedValue(new Error("network down"));

    const req = { query: {} };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: "clawhub_unavailable",
      message: "Could not reach ClawHub registry.",
    });
  });

  it("returns installed skills normalized from the agent lockfile", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "openclaw",
          deploy_target: "docker",
          sandbox_profile: "standard",
          clawhub_skills: [],
        },
      ],
    });
    runContainerCommand.mockResolvedValueOnce({
      output: JSON.stringify({
        version: 1,
        skills: {
          github: { version: "2.1.0", installedAt: 1700000000000 },
          notion: { version: "1.0.0", installedAt: 1700000000001 },
        },
      }),
    });

    const req = { params: { agentId: "agent-1" }, user: { id: "user-1" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      skills: [
        { slug: "github", version: "2.1.0" },
        { slug: "notion", version: "1.0.0" },
      ],
    });
  });

  it("returns unsupported_runtime for non-docker or non-openclaw agents", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/:slug/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "k8s",
          runtime_family: "openclaw",
          clawhub_skills: [],
        },
      ],
    });

    const req = {
      params: { agentId: "agent-1", slug: "github" },
      user: { id: "user-1" },
      body: {},
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "unsupported_runtime",
      message: "ClawHub installs are only available for Docker-backed OpenClaw agents.",
    });
  });

  it("returns container_not_running when the agent is stopped", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/:slug/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "stopped",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "openclaw",
          clawhub_skills: [],
        },
      ],
    });

    const req = {
      params: { agentId: "agent-1", slug: "github" },
      user: { id: "user-1" },
      body: {},
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "container_not_running",
      message: "Start the agent before installing skills.",
    });
  });

  it("returns npm_unavailable when clawhub CLI bootstrap cannot use npm", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/:slug/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "openclaw",
          clawhub_skills: [],
        },
      ],
    });
    runContainerCommand.mockRejectedValueOnce(new Error("Container command exited with exit 42"));

    const req = {
      params: { agentId: "agent-1", slug: "github" },
      user: { id: "user-1" },
      body: {},
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      error: "npm_unavailable",
      message: "The clawhub CLI could not be installed. Ensure Node.js is in your base image.",
    });
  });

  it("reuses an in-flight install job when one already exists", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/:slug/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "openclaw",
          clawhub_skills: [],
        },
      ],
    });
    runContainerCommand.mockResolvedValueOnce({ output: "" });
    findInFlightClawhubInstallJob.mockResolvedValueOnce({ id: "job-1" });
    getClawhubInstallJobStatus.mockResolvedValueOnce({
      jobId: "job-1",
      agentId: "agent-1",
      slug: "github",
      status: "running",
      error: null,
      completedAt: null,
    });

    const req = {
      params: { agentId: "agent-1", slug: "github" },
      user: { id: "user-1" },
      body: {},
    };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      jobId: "job-1",
      agentId: "agent-1",
      slug: "github",
      status: "running",
    });
    expect(addClawhubInstallJob).not.toHaveBeenCalled();
  });

  it("enqueues a new install job and marks persistOnSuccess false when already saved", async () => {
    const handler = getRouteHandler("/agents/:agentId/skills/:slug/install", "post");
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          status: "running",
          container_id: "container-1",
          backend_type: "docker",
          runtime_family: "openclaw",
          clawhub_skills: [{ installSlug: "github", author: "steipete" }],
        },
      ],
    });
    runContainerCommand.mockResolvedValueOnce({ output: "" });
    findInFlightClawhubInstallJob.mockResolvedValueOnce(null);
    addClawhubInstallJob.mockResolvedValueOnce({ id: "job-2" });

    const req = {
      params: { agentId: "agent-1", slug: "github" },
      user: { id: "user-1" },
      body: {
        author: "steipete",
        pagePath: "steipete/github",
        installedAt: "2026-04-21T00:00:00.000Z",
      },
    };
    const res = createMockRes();
    await handler(req, res);

    expect(addClawhubInstallJob).toHaveBeenCalledWith({
      agentId: "agent-1",
      slug: "github",
      skillEntry: {
        source: "clawhub",
        installSlug: "github",
        author: "steipete",
        pagePath: "steipete/github",
        installedAt: "2026-04-21T00:00:00.000Z",
      },
      persistOnSuccess: false,
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      jobId: "job-2",
      agentId: "agent-1",
      slug: "github",
      status: "pending",
    });
  });

  it("returns job_not_found when the install job lookup misses", async () => {
    const handler = getRouteHandler("/jobs/:jobId");
    getClawhubInstallJobStatus.mockResolvedValueOnce(null);

    const req = { params: { jobId: "missing-job" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "job_not_found" });
  });

  it("returns normalized install job status when the job exists", async () => {
    const handler = getRouteHandler("/jobs/:jobId");
    getClawhubInstallJobStatus.mockResolvedValueOnce({
      jobId: "job-3",
      agentId: "agent-1",
      slug: "github",
      status: "success",
      error: null,
      completedAt: "2026-04-21T01:00:00.000Z",
    });

    const req = { params: { jobId: "job-3" } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      jobId: "job-3",
      agentId: "agent-1",
      slug: "github",
      status: "success",
      error: null,
      completedAt: "2026-04-21T01:00:00.000Z",
    });
  });
});
