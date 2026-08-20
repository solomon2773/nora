const test = require("node:test");
const assert = require("node:assert");
const api = require("./client");
const monitoring = require("./commands/monitoring");

test("monitoring events passes default limit of 20 when no flags provided", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalGet = api.get;

  console.log = (msg) => logs.push(msg);
  api.get = async (path, options) => {
    assert.strictEqual(path, "/api/monitoring/events");
    assert.deepStrictEqual(options, { query: { limit: 20 } });
    return [
      {
        created_at: "2026-08-20T10:00:00Z",
        type: "agent_started",
        message: "Agent agent-1 started",
      },
    ];
  };

  try {
    await monitoring.subcommands.events.run([], {});
    assert.deepStrictEqual(logs, ["[2026-08-20T10:00:00Z] agent_started: Agent agent-1 started"]);
  } finally {
    console.log = originalLog;
    api.get = originalGet;
  }
});

test("monitoring events forwards search, type, from, to, and limit filter flags", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalGet = api.get;

  console.log = (msg) => logs.push(msg);
  api.get = async (path, options) => {
    assert.strictEqual(path, "/api/monitoring/events");
    assert.deepStrictEqual(options, {
      query: {
        limit: 10,
        search: "backup failure",
        type: "agent_deleted",
        from: "2026-08-01",
        to: "2026-08-20",
      },
    });
    return [
      {
        created_at: "2026-08-15T12:00:00Z",
        type: "agent_deleted",
        message: "Agent agent-2 deleted after backup failure",
      },
    ];
  };

  try {
    await monitoring.subcommands.events.run([], {
      limit: 10,
      search: "backup failure",
      type: "agent_deleted",
      from: "2026-08-01",
      to: "2026-08-20",
    });
    assert.deepStrictEqual(logs, [
      "[2026-08-15T12:00:00Z] agent_deleted: Agent agent-2 deleted after backup failure",
    ]);
  } finally {
    console.log = originalLog;
    api.get = originalGet;
  }
});

test("monitoring events prints (no events) when response is empty", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalGet = api.get;

  console.log = (msg) => logs.push(msg);
  api.get = async () => [];

  try {
    await monitoring.subcommands.events.run([], { search: "nonexistent" });
    assert.deepStrictEqual(logs, ["(no events)"]);
  } finally {
    console.log = originalLog;
    api.get = originalGet;
  }
});

test("monitoring events handles data.events wrapper structure", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalGet = api.get;

  console.log = (msg) => logs.push(msg);
  api.get = async () => ({
    events: [
      {
        createdAt: "2026-08-20T11:00:00Z",
        event_type: "agent_restarted",
        message: "Restarted agent-3",
      },
    ],
  });

  try {
    await monitoring.subcommands.events.run([], { type: "agent_restarted" });
    assert.deepStrictEqual(logs, ["[2026-08-20T11:00:00Z] agent_restarted: Restarted agent-3"]);
  } finally {
    console.log = originalLog;
    api.get = originalGet;
  }
});
