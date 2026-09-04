// @ts-nocheck
process.env.ENCRYPTION_KEY = "1".repeat(64);

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../billing", () => ({
  IS_PAAS: false,
  BILLING_ENABLED: false,
  getSubscription: jest.fn(async () => ({ status: "active", managed_backups_enabled: true })),
  getBackupUsage: jest.fn(async () => ({ count: 0, bytes: 0 })),
}));

const { deleteBackup, listUserBackups } = require("../backups");

beforeEach(() => {
  mockDb.query.mockReset();
});

// #338: managed backups could be created but not restored once their source
// agent was deleted — the exact disaster-recovery case they exist for. Every
// route was mounted under /agents and resolved the agent first, so the archive
// and its row both survived while nothing routed to them.
describe("account-scoped backup access (#338)", () => {
  describe("listUserBackups", () => {
    it("lists backups whose source agent has been deleted", async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { id: "b-orphan", kind: "agent", status: "ready", agent_name: null, agent_exists: false },
          { id: "b-live", kind: "agent", status: "ready", agent_name: "Live", agent_exists: true },
        ],
      });

      const result = await listUserBackups("user-1");
      const byId = Object.fromEntries(result.backups.map((b) => [b.id, b]));

      expect(byId["b-orphan"]).toBeDefined();
      expect(byId["b-orphan"].agent_exists).toBe(false);
      expect(byId["b-live"].agent_exists).toBe(true);
      expect(byId["b-live"].agent_name).toBe("Live");
    });

    it("scopes the query to the owner and never to an agent", async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      await listUserBackups("user-1");

      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain("b.user_id = $1");
      // An inner join, or any agent_id predicate, would re-hide orphaned rows.
      expect(sql).toContain("LEFT JOIN agents");
      expect(sql).not.toMatch(/\bAND b\.agent_id\s*=/);
      expect(params).toEqual(["user-1"]);
    });
  });

  describe("backup lookup by id", () => {
    // Exercised through deleteBackup's not-found path so the assertion stays on
    // the lookup itself and never reaches storage.
    async function captureLookupSql(args) {
      mockDb.query.mockResolvedValue({ rows: [] });
      await expect(deleteBackup(args)).rejects.toThrow("Backup not found");
      return mockDb.query.mock.calls[0][0];
    }

    it("omits the agent constraint when no agent is supplied", async () => {
      const sql = await captureLookupSql({ backupId: "b-1", userId: "user-1" });
      expect(sql).toContain("user_id = $2");
      // The agent_id predicate is what made a deleted agent hide its own backup.
      expect(sql).not.toContain("agent_id");
    });

    it("still applies the agent constraint on the agent-scoped path", async () => {
      const sql = await captureLookupSql({ backupId: "b-1", userId: "user-1", agentId: "a-1" });
      expect(sql).toContain("agent_id = $3");
    });

    it("always scopes to the owner so a backup id alone is not enough", async () => {
      const sql = await captureLookupSql({ backupId: "b-1", userId: "user-1" });
      expect(sql).toContain("user_id");
    });
  });
});
