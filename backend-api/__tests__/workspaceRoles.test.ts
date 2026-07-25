// @ts-nocheck
/**
 * __tests__/workspaceRoles.test.ts — direct unit tests for the role-hierarchy
 * helpers and the findAccessibleAgent helper in middleware/ownership.ts.
 * The middleware itself is exercised end-to-end in workspaces.test.ts and
 * agents.test.ts; this file pins the precedence rules and the workspace-
 * membership slow-path.
 */

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const {
  findAgentForRequest,
  findAccessibleAgent,
  findAccessibleAgentForActor,
  rankRole,
  roleSatisfies,
  WORKSPACE_ROLE_RANK,
} = require("../middleware/ownership");

beforeEach(() => {
  mockDb.query.mockReset();
});

describe("workspace role hierarchy", () => {
  it("ranks owner > admin > editor > viewer", () => {
    expect(rankRole("owner")).toBeGreaterThan(rankRole("admin"));
    expect(rankRole("admin")).toBeGreaterThan(rankRole("editor"));
    expect(rankRole("editor")).toBeGreaterThan(rankRole("viewer"));
  });

  it("returns -1 for unknown roles", () => {
    expect(rankRole("god")).toBe(-1);
    expect(rankRole(undefined)).toBe(-1);
    expect(rankRole(null)).toBe(-1);
  });

  it("exports a complete rank table", () => {
    expect(Object.keys(WORKSPACE_ROLE_RANK).sort()).toEqual(["admin", "editor", "owner", "viewer"]);
  });

  describe("roleSatisfies", () => {
    it("owner satisfies every required role", () => {
      for (const required of ["viewer", "editor", "admin", "owner"]) {
        expect(roleSatisfies("owner", required)).toBe(true);
      }
    });

    it("viewer only satisfies viewer", () => {
      expect(roleSatisfies("viewer", "viewer")).toBe(true);
      expect(roleSatisfies("viewer", "editor")).toBe(false);
      expect(roleSatisfies("viewer", "admin")).toBe(false);
      expect(roleSatisfies("viewer", "owner")).toBe(false);
    });

    it("editor satisfies viewer and editor but not admin/owner", () => {
      expect(roleSatisfies("editor", "viewer")).toBe(true);
      expect(roleSatisfies("editor", "editor")).toBe(true);
      expect(roleSatisfies("editor", "admin")).toBe(false);
      expect(roleSatisfies("editor", "owner")).toBe(false);
    });

    it("admin satisfies viewer/editor/admin but not owner", () => {
      expect(roleSatisfies("admin", "viewer")).toBe(true);
      expect(roleSatisfies("admin", "editor")).toBe(true);
      expect(roleSatisfies("admin", "admin")).toBe(true);
      expect(roleSatisfies("admin", "owner")).toBe(false);
    });

    it("rejects unknown actual or required roles", () => {
      expect(roleSatisfies("god", "viewer")).toBe(false);
      expect(roleSatisfies("admin", "superuser")).toBe(false);
      expect(roleSatisfies(undefined, "viewer")).toBe(false);
    });
  });
});

describe("findAccessibleAgent", () => {
  it("returns null when the agent does not exist", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    expect(await findAccessibleAgent("missing", "user-1", "viewer")).toBeNull();
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("fast path: direct owner satisfies any required role", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "a1", user_id: "user-1", name: "Owned" }],
    });
    const agent = await findAccessibleAgent("a1", "user-1", "admin");
    expect(agent).toMatchObject({ id: "a1", effective_role: "owner" });
    // No workspace lookup should happen for the owner — single query only.
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("slow path: returns agent when caller is a workspace member with sufficient role", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "a1", user_id: "creator", name: "Shared" }] })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] });
    const agent = await findAccessibleAgent("a1", "user-2", "viewer");
    expect(agent).toMatchObject({ id: "a1", effective_role: "editor" });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("slow path: returns null when workspace role is below required", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "a1", user_id: "creator" }] })
      .mockResolvedValueOnce({ rows: [{ role: "viewer" }] });
    const agent = await findAccessibleAgent("a1", "user-2", "editor");
    expect(agent).toBeNull();
  });

  it("slow path: returns null when caller is not a member of any sharing workspace", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "a1", user_id: "creator" }] })
      .mockResolvedValueOnce({ rows: [] });
    const agent = await findAccessibleAgent("a1", "user-2", "viewer");
    expect(agent).toBeNull();
  });

  it("rejects unknown required role at config time", async () => {
    await expect(findAccessibleAgent("a1", "user-1", "god")).rejects.toThrow(
      /Unknown workspace role/,
    );
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("returns null for missing inputs without hitting the database", async () => {
    expect(await findAccessibleAgent(null, "user-1")).toBeNull();
    expect(await findAccessibleAgent("a1", null)).toBeNull();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("findAgentForRequest", () => {
  it("preserves direct-owner loading for session requests", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "a1", user_id: "user-1", name: "Owned" }],
    });

    const agent = await findAgentForRequest({ user: { id: "user-1" } }, "a1");

    expect(agent).toMatchObject({ id: "a1", user_id: "user-1" });
    expect(mockDb.query).toHaveBeenCalledWith(
      "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
      ["a1", "user-1"],
    );
  });

  it("loads a teammate-owned agent through the API key's exact workspace assignment", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "a1", user_id: "teammate-1", name: "Shared" }],
    });

    const agent = await findAgentForRequest(
      {
        user: { id: "key-issuer" },
        apiKey: { workspaceId: "ws-A" },
        apiKeyWorkspace: { id: "ws-A" },
      },
      "a1",
    );

    expect(agent).toMatchObject({ id: "a1", user_id: "teammate-1" });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM workspace_agents wa[\s\S]*WHERE wa\.workspace_id = \$1/),
      ["ws-A", "a1"],
    );
  });
});

describe("findAccessibleAgentForActor", () => {
  it("lets platform admins access any agent", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "a1", user_id: "owner-1", name: "Fleet Agent" }],
    });

    const agent = await findAccessibleAgentForActor(
      "a1",
      { id: "admin-1", role: "admin" },
      "editor",
    );

    expect(agent).toMatchObject({ id: "a1", effective_role: "admin" });
    expect(mockDb.query).toHaveBeenCalledWith("SELECT * FROM agents WHERE id = $1", ["a1"]);
  });

  it("uses workspace-aware role checks for non-admin actors", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "a1", user_id: "owner-1", name: "Shared" }] })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] });

    const agent = await findAccessibleAgentForActor(
      "a1",
      { id: "member-1", role: "user" },
      "editor",
    );

    expect(agent).toMatchObject({ id: "a1", effective_role: "editor" });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("returns null when the actor is missing", async () => {
    expect(await findAccessibleAgentForActor("a1", null, "viewer")).toBeNull();
    expect(await findAccessibleAgentForActor("a1", {}, "viewer")).toBeNull();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
