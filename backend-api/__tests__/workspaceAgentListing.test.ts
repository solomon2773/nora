// @ts-nocheck

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const workspaces = require("../workspaces");

describe("workspace-bound agent listing", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("filters accessible API-key listings to one exact workspace", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-a",
          user_id: "user-1",
          is_direct_owner: true,
          effective_role: "owner",
          workspaces: [{ id: "ws-A", name: "A", role: "owner" }],
        },
      ],
    });

    const result = await workspaces.listAccessibleAgents("user-1", {
      scope: "accessible",
      workspaceId: "ws-A",
    });

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM workspace_agents wa[\s\S]*WHERE wa\.workspace_id = \$2/),
      ["user-1", "ws-A"],
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: "agent-a",
        workspaces: [{ id: "ws-A", name: "A", role: "owner" }],
      }),
    ]);
  });

  it("keeps scope=owned inside the same workspace boundary", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    await workspaces.listAccessibleAgents("user-1", {
      scope: "owned",
      workspaceId: "ws-A",
    });

    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("WHERE wa.workspace_id = $2");
    expect(sql).toContain("AND a.user_id = $1");
    expect(params).toEqual(["user-1", "ws-A"]);
  });
});
