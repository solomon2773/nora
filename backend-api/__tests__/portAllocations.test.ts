// @ts-nocheck
const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const {
  allocateGatewayPort,
  reallocateGatewayPort,
  releaseGatewayPort,
  getGatewayPortAllocation,
  resolveGatewayPortRange,
  LOCAL_HOST_KEY,
  GATEWAY_PORT_PURPOSE,
  DASHBOARD_PORT_PURPOSE,
} = require("../portAllocations");

// Route db.query on SQL shape. `insert` is an array of responses consumed in
// order (so we can simulate a unique-violation race then success).
function fakeDb({
  existing = [],
  existingResponses = [],
  insertResponses = [],
  updateResponses = [],
} = {}) {
  const calls = [];
  let existingIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  mockDb.query.mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT host_key, port FROM gateway_port_allocations")) {
      return { rows: existing };
    }
    if (sql.includes("SELECT port FROM gateway_port_allocations WHERE agent_id")) {
      const next = existingResponses[existingIdx++] ?? { rows: existing };
      if (next instanceof Error) throw next;
      return next;
    }
    if (sql.includes("INSERT INTO gateway_port_allocations")) {
      const next = insertResponses[insertIdx++] ?? { rows: [] };
      if (next instanceof Error) throw next;
      return next;
    }
    if (sql.includes("UPDATE gateway_port_allocations")) {
      const next = updateResponses[updateIdx++] ?? { rows: [] };
      if (next instanceof Error) throw next;
      return next;
    }
    if (sql.includes("DELETE FROM gateway_port_allocations")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { calls };
}

beforeEach(() => mockDb.query.mockReset());

afterEach(() => {
  delete process.env.DOCKER_AGENT_PORT_RANGE_MIN;
  delete process.env.DOCKER_AGENT_PORT_RANGE_MAX;
});

describe("allocateGatewayPort", () => {
  it("reuses the agent's existing allocation (idempotent across redeploys)", async () => {
    const { calls } = fakeDb({ existing: [{ port: 19042 }] });
    const port = await allocateGatewayPort({ hostKey: "local", agentId: "a1" });
    expect(port).toBe(19042);
    // no INSERT attempted
    expect(calls.some((c) => c.sql.includes("INSERT INTO gateway_port_allocations"))).toBe(false);
  });

  it("claims the lowest free port for a fresh agent", async () => {
    const { calls } = fakeDb({ existing: [], insertResponses: [{ rows: [{ port: 19000 }] }] });
    const port = await allocateGatewayPort({ hostKey: "remote:my-vps", agentId: "a2" });
    expect(port).toBe(19000);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(insert.sql).toContain("generate_series($3::integer, $4::integer)");
  });

  it("skips Docker ports that are already occupied outside the allocation table", async () => {
    const { calls } = fakeDb({
      existing: [],
      insertResponses: [{ rows: [{ port: 19001 }] }],
    });
    const port = await allocateGatewayPort({
      hostKey: "local",
      agentId: "occupied-first",
      unavailablePorts: new Set([19000]),
    });

    expect(port).toBe(19001);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(insert.sql).toContain("candidate.port = ANY($6::integer[])");
    expect(insert.params[5]).toEqual([19000]);
  });

  it("persists a replacement when an existing reservation is occupied", async () => {
    const { calls } = fakeDb({
      existing: [{ port: 19000 }],
      updateResponses: [{ rows: [{ port: 19001 }] }],
    });

    const port = await allocateGatewayPort({
      hostKey: "local",
      agentId: "occupied-existing",
      unavailablePorts: [19000],
    });

    expect(port).toBe(19001);
    const update = calls.find((c) => c.sql.includes("UPDATE gateway_port_allocations"));
    expect(update).toBeDefined();
    expect(update.params).toEqual([
      "local",
      "occupied-existing",
      GATEWAY_PORT_PURPOSE,
      19000,
      19999,
      [19000],
      19000,
    ]);
  });

  it("retries on a UNIQUE-violation race and succeeds", async () => {
    const raceError = new Error("duplicate key");
    raceError.code = "23505";
    fakeDb({ existing: [], insertResponses: [raceError, { rows: [{ port: 19001 }] }] });
    const port = await allocateGatewayPort({ hostKey: "local", agentId: "a3" });
    expect(port).toBe(19001);
  });

  it("throws 503 when the host's port range is exhausted", async () => {
    fakeDb({ existing: [], insertResponses: [{ rows: [] }] });
    await expect(
      allocateGatewayPort({ hostKey: "local", agentId: "a4", rangeMin: 19000, rangeMax: 19000 }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("defaults a blank host key to the local host", async () => {
    const { calls } = fakeDb({ existing: [], insertResponses: [{ rows: [{ port: 19000 }] }] });
    await allocateGatewayPort({ agentId: "a5" });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(insert.params[0]).toBe(LOCAL_HOST_KEY);
  });

  it("requires an agentId", async () => {
    fakeDb();
    await expect(allocateGatewayPort({ hostKey: "local" })).rejects.toThrow(/agentId/i);
  });

  it("uses an environment-configured subrange inside the gateway security envelope", async () => {
    process.env.DOCKER_AGENT_PORT_RANGE_MIN = "19500";
    process.env.DOCKER_AGENT_PORT_RANGE_MAX = "19510";
    const { calls } = fakeDb({
      existing: [],
      insertResponses: [{ rows: [{ port: 19500 }] }],
    });

    await allocateGatewayPort({ hostKey: "local", agentId: "configured-range" });

    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(insert.params.slice(2, 4)).toEqual([19500, 19510]);
  });

  it("rejects configured ranges outside the gateway proxy security envelope", () => {
    expect(() =>
      resolveGatewayPortRange({
        env: {
          DOCKER_AGENT_PORT_RANGE_MIN: "18999",
          DOCKER_AGENT_PORT_RANGE_MAX: "20000",
        },
      }),
    ).toThrow(/19000-19999/);
  });

  it("rejects a configured minimum above the maximum", () => {
    expect(() =>
      resolveGatewayPortRange({
        env: {
          DOCKER_AGENT_PORT_RANGE_MIN: "19510",
          DOCKER_AGENT_PORT_RANGE_MAX: "19500",
        },
      }),
    ).toThrow(/cannot exceed/);
  });

  it("defaults the purpose to the gateway slot", async () => {
    const { calls } = fakeDb({ existing: [], insertResponses: [{ rows: [{ port: 19000 }] }] });
    await allocateGatewayPort({ hostKey: "remote:my-vps", agentId: "a6" });
    const select = calls.find((c) =>
      c.sql.includes("SELECT port FROM gateway_port_allocations WHERE agent_id"),
    );
    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(select.params[2]).toBe(GATEWAY_PORT_PURPOSE);
    expect(insert.params[4]).toBe(GATEWAY_PORT_PURPOSE);
  });

  it("scopes the lookup + claim by purpose so a second slot gets its own port", async () => {
    // 'gateway' is already taken at 19000; a 'dashboard' allocation for the SAME
    // agent + host must look up its own purpose row (none yet) and claim a
    // different free port — the NOT EXISTS spans all purposes on the host.
    const { calls } = fakeDb({ existing: [], insertResponses: [{ rows: [{ port: 19001 }] }] });
    const port = await allocateGatewayPort({
      hostKey: "remote:my-vps",
      agentId: "a7",
      purpose: DASHBOARD_PORT_PURPOSE,
    });
    expect(port).toBe(19001);
    const select = calls.find((c) =>
      c.sql.includes("SELECT port FROM gateway_port_allocations WHERE agent_id"),
    );
    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(select.params).toEqual(["a7", "remote:my-vps", DASHBOARD_PORT_PURPOSE]);
    expect(insert.params[4]).toBe(DASHBOARD_PORT_PURPOSE);
    // The free-port scan spans the whole host (no purpose filter), so a second
    // purpose can't land on a port another purpose already holds there.
    expect(insert.sql).toContain("existing.host_key = $1 AND existing.port = candidate.port");
  });

  it("reuses an existing same-purpose allocation (idempotent per purpose)", async () => {
    const { calls } = fakeDb({ existing: [{ port: 19500 }] });
    const port = await allocateGatewayPort({
      hostKey: "remote:my-vps",
      agentId: "a8",
      purpose: DASHBOARD_PORT_PURPOSE,
    });
    expect(port).toBe(19500);
    expect(calls.some((c) => c.sql.includes("INSERT INTO gateway_port_allocations"))).toBe(false);
  });
});

describe("reallocateGatewayPort", () => {
  it("allocates a fresh row if the expected reservation disappeared", async () => {
    const { calls } = fakeDb({
      existing: [],
      insertResponses: [{ rows: [{ port: 19001 }] }],
    });

    const port = await reallocateGatewayPort({
      hostKey: "local",
      agentId: "missing-row",
      previousPort: 19000,
    });

    expect(port).toBe(19001);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO gateway_port_allocations"));
    expect(insert.params[5]).toEqual([19000]);
  });

  it("accepts a concurrent same-agent replacement after its compare-and-swap loses", async () => {
    fakeDb({
      existingResponses: [{ rows: [{ port: 19000 }] }, { rows: [{ port: 19001 }] }],
      updateResponses: [{ rows: [] }],
    });

    const port = await reallocateGatewayPort({
      hostKey: "local",
      agentId: "concurrent-row",
      previousPort: 19000,
      unavailablePorts: [19000],
    });

    expect(port).toBe(19001);
  });
});

describe("releaseGatewayPort", () => {
  it("deletes every allocation the agent holds", async () => {
    const { calls } = fakeDb();
    await releaseGatewayPort("a1");
    const del = calls.find((c) => c.sql.includes("DELETE FROM gateway_port_allocations"));
    expect(del.params).toEqual(["a1"]);
  });

  it("no-ops without an agentId", async () => {
    const { calls } = fakeDb();
    await releaseGatewayPort();
    expect(calls.length).toBe(0);
  });
});

describe("getGatewayPortAllocation", () => {
  it("returns null when the table has not been migrated yet", async () => {
    mockDb.query.mockReset();
    const undefinedTable = new Error('relation "gateway_port_allocations" does not exist');
    undefinedTable.code = "42P01";
    mockDb.query.mockRejectedValueOnce(undefinedTable);
    expect(await getGatewayPortAllocation("a1")).toBeNull();
  });
});
