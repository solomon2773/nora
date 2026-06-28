// @ts-nocheck
// Unit coverage for agentSchedules: cron validation + next-run, the min-interval
// guardrail, input validation, and the replica-safe sweep (claim -> bump -> enqueue).

const mockDb = { query: jest.fn(), connect: jest.fn() };
jest.mock("../db", () => mockDb);

const schedules = require("../agentSchedules");

beforeEach(() => {
  mockDb.query.mockReset();
  mockDb.connect.mockReset();
});

describe("cron validation + next-run", () => {
  it("computes the next fire in the given timezone", () => {
    const next = schedules.computeNextRun("0 9 * * *", "UTC", new Date("2026-06-22T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-06-22T09:00:00.000Z");
  });

  it("accepts a daily cron", () => {
    expect(() => schedules.validateCron("0 9 * * *", "UTC")).not.toThrow();
  });

  it("rejects a sub-minute cron (min-interval guardrail)", () => {
    expect(() => schedules.validateCron("*/30 * * * * *", "UTC")).toThrow(/too frequently/i);
  });

  it("rejects an unparseable cron with a 400", () => {
    try {
      schedules.validateCron("not a cron");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/invalid cron/i);
    }
  });
});

describe("createSchedule validation", () => {
  it("requires a prompt for the prompt action", async () => {
    await expect(
      schedules.createSchedule("a1", "u1", { name: "x", cron: "0 9 * * *", action_type: "prompt" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unknown action_type", async () => {
    await expect(
      schedules.createSchedule("a1", "u1", { name: "x", cron: "0 9 * * *", action_type: "nuke" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("inserts a valid prompt schedule with a computed next_run_at", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "s1", agent_id: "a1", name: "x", action_type: "prompt", enabled: true }],
    });
    const out = await schedules.createSchedule("a1", "u1", {
      name: "x",
      cron: "0 9 * * *",
      action_type: "prompt",
      prompt: "hello",
    });
    expect(out.id).toBe("s1");
    const insert = mockDb.query.mock.calls[0];
    expect(insert[0]).toMatch(/INSERT INTO agent_schedules/);
    // next_run_at (last param) is a Date, not null, for an enabled schedule.
    expect(insert[1][insert[1].length - 1]).toBeInstanceOf(Date);
  });

  it("allows a lifecycle action with no prompt", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: "s2", action_type: "restart" }] });
    const out = await schedules.createSchedule("a1", "u1", {
      name: "nightly restart",
      cron: "0 3 * * *",
      action_type: "restart",
    });
    expect(out.id).toBe("s2");
  });
});

describe("sweepDueSchedules", () => {
  function fakeClient(dueRows) {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (sql, params) => {
        calls.push([sql, params]);
        if (/SELECT \* FROM agent_schedules/.test(sql)) return { rows: dueRows };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
  }

  it("claims due rows, bumps next_run_at, and enqueues each run", async () => {
    const due = [
      {
        id: "s1",
        agent_id: "a1",
        cron: "0 9 * * *",
        timezone: "UTC",
        action_type: "prompt",
        prompt: "hi",
        created_by: "u1",
        name: "morning",
      },
      {
        id: "s2",
        agent_id: "a2",
        cron: "0 * * * *",
        timezone: "UTC",
        action_type: "restart",
        prompt: null,
        created_by: "u2",
        name: "hourly restart",
      },
    ];
    const client = fakeClient(due);
    mockDb.connect.mockResolvedValue(client);
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const n = await schedules.sweepDueSchedules({
      dbClient: mockDb,
      enqueue,
      now: new Date("2026-06-22T10:00:00Z"),
    });

    expect(n).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "s1", agentId: "a1", actionType: "prompt" }),
    );
    // BEGIN + SELECT + 2 UPDATE(next_run_at) + COMMIT
    expect(client.calls.some((c) => /BEGIN/.test(c[0]))).toBe(true);
    expect(client.calls.some((c) => /COMMIT/.test(c[0]))).toBe(true);
    expect(client.calls.filter((c) => /SET next_run_at = \$2/.test(c[0])).length).toBe(2);
    expect(client.release).toHaveBeenCalled();
  });

  it("auto-disables a row whose cron is now invalid (no enqueue)", async () => {
    const due = [
      {
        id: "s9",
        agent_id: "a9",
        cron: "garbage",
        timezone: "UTC",
        action_type: "prompt",
        prompt: "x",
        created_by: "u1",
      },
    ];
    const client = fakeClient(due);
    mockDb.connect.mockResolvedValue(client);
    const enqueue = jest.fn();

    const n = await schedules.sweepDueSchedules({ dbClient: mockDb, enqueue });

    expect(n).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(client.calls.some((c) => /SET enabled = FALSE.*invalid_cron/s.test(c[0]))).toBe(true);
  });

  it("requires an enqueue function", async () => {
    await expect(schedules.sweepDueSchedules({ dbClient: mockDb })).rejects.toThrow(/enqueue/);
  });
});
