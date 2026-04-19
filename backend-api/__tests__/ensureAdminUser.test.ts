// @ts-nocheck
const mockDb = { query: jest.fn() };

jest.mock("../db", () => mockDb);

const { ensureFirstRegisteredUserIsAdmin } = require("../ensureAdminUser");

describe("ensureFirstRegisteredUserIsAdmin", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("promotes the earliest registered user when no admin exists", async () => {
    const promotedUser = {
      id: "user-1",
      email: "first@example.com",
      role: "admin",
      created_at: "2026-04-08T00:00:00.000Z",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [promotedUser] });

    await expect(ensureFirstRegisteredUserIsAdmin()).resolves.toEqual(promotedUser);
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("WHERE NOT EXISTS"));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY created_at ASC, id ASC"));
  });

  it("returns null when an admin already exists or there are no users", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    await expect(ensureFirstRegisteredUserIsAdmin()).resolves.toBeNull();
  });
});
