// @ts-nocheck
const mockDb = {
  query: jest.fn(),
  connect: jest.fn(),
};

jest.mock("../db", () => mockDb);

const userGroups = require("../userGroups");

const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "33333333-3333-4333-8333-333333333333";

function createClient(handler) {
  return {
    query: jest.fn(handler),
    release: jest.fn(),
  };
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockDb.connect.mockReset();
});

describe("admin user groups", () => {
  it("returns stable group list metadata", async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ id: GROUP_ID, name: "Builders", memberCount: "2", membersVersion: "4" }],
    });
    await expect(userGroups.listUserGroups()).resolves.toEqual([
      { id: GROUP_ID, name: "Builders", memberCount: 2, membersVersion: 4 },
    ]);
    expect(mockDb.query.mock.calls[0][0]).toMatch(/COUNT\(ugm\.user_id\)/);
  });

  it("normalizes duplicate-name database errors to a 409", async () => {
    mockDb.query.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "23505" }));
    await expect(userGroups.createUserGroup({ name: "Builders" }, USER_1)).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_GROUP_NAME_EXISTS",
    });
  });

  it("returns members with their optimistic version from one snapshot", async () => {
    const client = createClient(async (sql) => {
      const text = String(sql);
      if (/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(text)) {
        return { rows: [] };
      }
      if (text === "COMMIT") return { rows: [] };
      if (/FROM user_groups ug/.test(text)) {
        return {
          rows: [{ id: GROUP_ID, name: "Builders", memberCount: 1, membersVersion: 5 }],
        };
      }
      if (/FROM user_group_members ugm/.test(text)) {
        return { rows: [{ userId: USER_1, email: "one@nora.test", name: "One" }] };
      }
      return { rows: [] };
    });
    mockDb.connect.mockResolvedValue(client);

    await expect(userGroups.listUserGroupMembers(GROUP_ID)).resolves.toEqual({
      version: 5,
      members: [{ userId: USER_1, email: "one@nora.test", name: "One" }],
    });
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("replaces members atomically after validating every user", async () => {
    const client = createClient(async (sql) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (/FROM user_groups ug/.test(text)) {
        return {
          rows: [{ id: GROUP_ID, name: "Builders", memberCount: 0, membersVersion: 1 }],
        };
      }
      if (/SELECT id FROM users/.test(text)) return { rows: [{ id: USER_1 }, { id: USER_2 }] };
      if (/UPDATE user_groups/.test(text)) return { rows: [{ membersVersion: 2 }] };
      if (/FROM user_group_members ugm/.test(text) && /JOIN users u/.test(text)) {
        return {
          rows: [
            { userId: USER_1, email: "one@nora.test", name: "One" },
            { userId: USER_2, email: "two@nora.test", name: "Two" },
          ],
        };
      }
      return { rows: [] };
    });
    mockDb.connect.mockResolvedValue(client);

    const result = await userGroups.replaceUserGroupMembers(
      GROUP_ID,
      [USER_1, { userId: USER_2 }, USER_1],
      1,
      USER_1,
    );

    expect(result).toEqual({
      version: 2,
      members: [
        { userId: USER_1, email: "one@nora.test", name: "One" },
        { userId: USER_2, email: "two@nora.test", name: "Two" },
      ],
    });
    expect(client.query.mock.calls.map(([sql]) => String(sql))).toEqual(
      expect.arrayContaining([
        "BEGIN",
        expect.stringContaining("FOR UPDATE"),
        expect.stringContaining("SELECT id FROM users"),
        expect.stringContaining("UPDATE user_groups"),
        "DELETE FROM user_group_members WHERE group_id = $1",
        expect.stringContaining("INSERT INTO user_group_members"),
        expect.stringContaining("JOIN users u"),
        "COMMIT",
      ]),
    );
    const insert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO user_group_members"),
    );
    expect(insert[1]).toEqual([GROUP_ID, [USER_1, USER_2], USER_1]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back without deleting memberships when any user is unknown", async () => {
    const client = createClient(async (sql) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (/FROM user_groups ug/.test(text)) {
        return {
          rows: [{ id: GROUP_ID, name: "Builders", memberCount: 1, membersVersion: 1 }],
        };
      }
      if (/SELECT id FROM users/.test(text)) return { rows: [{ id: USER_1 }] };
      return { rows: [] };
    });
    mockDb.connect.mockResolvedValue(client);

    await expect(
      userGroups.replaceUserGroupMembers(GROUP_ID, [USER_1, USER_2], 1, USER_1),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "USER_GROUP_MEMBER_NOT_FOUND",
    });
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).startsWith("DELETE FROM user_group_members"),
      ),
    ).toBe(false);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale member replacement before validating or deleting members", async () => {
    const client = createClient(async (sql) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (/FROM user_groups ug/.test(text)) {
        return {
          rows: [{ id: GROUP_ID, name: "Builders", memberCount: 1, membersVersion: 3 }],
        };
      }
      return { rows: [] };
    });
    mockDb.connect.mockResolvedValue(client);

    await expect(
      userGroups.replaceUserGroupMembers(GROUP_ID, [USER_1], 2, USER_1),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_GROUP_MEMBERS_VERSION_CONFLICT",
    });
    expect(client.query.mock.calls.some(([sql]) => /SELECT id FROM users/.test(String(sql)))).toBe(
      false,
    );
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).startsWith("DELETE FROM user_group_members"),
      ),
    ).toBe(false);
  });
});
