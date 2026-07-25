// @ts-nocheck
const fleetStatus = require("../fleetStatus");

const NOW = Date.UTC(2026, 5, 12, 12, 0, 0); // fixed clock for deterministic ages
const minutesAgo = (m) => NOW - m * 60 * 1000;

describe("deriveAttention (pure)", () => {
  it("flags an errored agent", () => {
    const v = fleetStatus.deriveAttention({ id: "a", name: "A", status: "error" }, { now: NOW });
    expect(v.needsAttention).toBe(true);
    expect(v.severity).toBe("error");
    expect(v.reasons.map((r) => r.code)).toEqual(["error"]);
  });

  it("flags a budget-paused agent (stopped + paused_reason) but not a plain stop", () => {
    const paused = fleetStatus.deriveAttention(
      { id: "a", status: "stopped", paused_reason: "budget_exceeded" },
      { now: NOW },
    );
    expect(paused.needsAttention).toBe(true);
    expect(paused.reasons[0].code).toBe("budget_paused");

    const plain = fleetStatus.deriveAttention(
      { id: "b", status: "stopped", paused_reason: null },
      { now: NOW },
    );
    expect(plain.needsAttention).toBe(false);
    expect(plain.reasons).toEqual([]);
  });

  it("flags queued/deploying only after the stuck threshold", () => {
    const fresh = fleetStatus.deriveAttention(
      { id: "a", status: "deploying" },
      { now: NOW, enteredDeployAt: minutesAgo(3) },
    );
    expect(fresh.needsAttention).toBe(false);

    const stuck = fleetStatus.deriveAttention(
      { id: "a", status: "deploying" },
      { now: NOW, enteredDeployAt: minutesAgo(15) },
    );
    expect(stuck.needsAttention).toBe(true);
    expect(stuck.reasons[0].code).toBe("stuck_deploying");
    expect(stuck.reasons[0].label).toMatch(/15m/);
  });

  it("does not flag stuck when there is no deployment timestamp", () => {
    const v = fleetStatus.deriveAttention(
      { id: "a", status: "queued" },
      { now: NOW, enteredDeployAt: null },
    );
    expect(v.needsAttention).toBe(false);
  });

  it("flags a soft budget crossing on a running agent", () => {
    const v = fleetStatus.deriveAttention(
      { id: "a", status: "running" },
      { now: NOW, budgetSoftCrossed: true },
    );
    expect(v.reasons.map((r) => r.code)).toContain("budget_warning");
  });

  it("flags stalled telemetry only when stats exist and are old", () => {
    const stalled = fleetStatus.deriveAttention(
      { id: "a", status: "running" },
      { now: NOW, lastStatAt: minutesAgo(20) },
    );
    expect(stalled.reasons.map((r) => r.code)).toContain("telemetry_stalled");

    const fresh = fleetStatus.deriveAttention(
      { id: "a", status: "running" },
      { now: NOW, lastStatAt: minutesAgo(1) },
    );
    expect(fresh.needsAttention).toBe(false);

    const neverReported = fleetStatus.deriveAttention(
      { id: "a", status: "running" },
      { now: NOW, lastStatAt: null },
    );
    expect(neverReported.needsAttention).toBe(false);
  });

  it("does not flag stuck/telemetry signals against a healthy running agent", () => {
    const v = fleetStatus.deriveAttention(
      { id: "a", status: "running" },
      { now: NOW, enteredDeployAt: minutesAgo(120), lastStatAt: minutesAgo(1) },
    );
    expect(v.needsAttention).toBe(false);
  });

  it("orders error reasons before warning reasons", () => {
    // A degraded (warning) agent that is also approaching its budget.
    const v = fleetStatus.deriveAttention(
      { id: "a", status: "warning" },
      { now: NOW, budgetSoftCrossed: true },
    );
    expect(v.severity).toBe("warning");
    expect(v.reasons[0].code).toBe("warning");
  });
});

describe("getFleetAttention (gather)", () => {
  function fakeDb(rows) {
    return { query: jest.fn(async () => ({ rows })) };
  }

  it("returns an empty result without a user id", async () => {
    const dbClient = fakeDb([]);
    const res = await fleetStatus.getFleetAttention({ userId: null, dbClient, now: NOW });
    expect(res).toEqual({
      generatedAt: new Date(NOW).toISOString(),
      total: 0,
      attentionCount: 0,
      agents: [],
    });
    expect(dbClient.query).not.toHaveBeenCalled();
  });

  it("returns only attention agents, errors first, with summary counts", async () => {
    const dbClient = fakeDb([
      { id: "ok", name: "Healthy", status: "running", last_stat_at: new Date(minutesAgo(1)) },
      { id: "err", name: "Broken", status: "error" },
      {
        id: "stuck",
        name: "Slow",
        status: "deploying",
        entered_deploy_at: new Date(minutesAgo(30)),
      },
    ]);
    const res = await fleetStatus.getFleetAttention({ userId: "u1", dbClient, now: NOW });
    expect(res.total).toBe(3);
    expect(res.attentionCount).toBe(2);
    expect(res.agents.map((a) => a.agentId)).toEqual(["err", "stuck"]); // error before warning
    // The healthy agent is excluded.
    expect(res.agents.find((a) => a.agentId === "ok")).toBeUndefined();
    // Scoped query was parameterized by the user id.
    expect(dbClient.query.mock.calls[0][1]).toEqual(["u1"]);
  });

  it("maps a soft-crossed budget flag from SQL into a budget_warning reason", async () => {
    const dbClient = fakeDb([{ id: "a", name: "A", status: "running", budget_soft_crossed: true }]);
    const res = await fleetStatus.getFleetAttention({ userId: "u1", dbClient, now: NOW });
    expect(res.agents[0].reasons.map((r) => r.code)).toContain("budget_warning");
  });

  it("scopes API-key fleet status to the exact bound workspace", async () => {
    const dbClient = fakeDb([]);

    await fleetStatus.getFleetAttention({
      userId: "u1",
      workspaceId: "ws-A",
      dbClient,
      now: NOW,
    });

    expect(dbClient.query.mock.calls[0][0]).toContain("scoped_workspace_agents.workspace_id = $1");
    expect(dbClient.query.mock.calls[0][0]).not.toContain("a.user_id = $1");
    expect(dbClient.query.mock.calls[0][1]).toEqual(["ws-A"]);
  });
});
