const test = require("node:test");
const assert = require("node:assert");
const api = require("./client");
const { load } = require("./config");
const workspaces = require("./commands/workspaces");

test("workspaces list renders table output by default", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalGet = api.get;

  console.log = (msg) => logs.push(msg);
  api.get = async (path) => {
    assert.strictEqual(path, "/api/workspaces");
    return [
      { id: "ws_1", name: "Workspace One", role: "admin" },
      { id: "ws_2", name: "Workspace Two", role: "member" },
    ];
  };

  try {
    await workspaces.subcommands.list.run([], {});
    assert.deepStrictEqual(logs, [
      "ID    NAME           ROLE    ACTIVE",
      "----  -------------  ------  ------",
      "ws_1  Workspace One  admin         ",
      "ws_2  Workspace Two  member        ",
    ]);
  } finally {
    console.log = originalLog;
    api.get = originalGet;
  }
});

test("workspaces list --json outputs formatted JSON payload", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalGet = api.get;

  console.log = (msg) => logs.push(msg);
  const mockWorkspaces = [
    { id: "ws_1", name: "Workspace One", role: "admin" },
    { id: "ws_2", name: "Workspace Two", role: "member" },
  ];
  api.get = async () => mockWorkspaces;

  try {
    await workspaces.subcommands.list.run([], { json: true });
    assert.strictEqual(logs.length, 1);
    assert.deepStrictEqual(JSON.parse(logs[0]), mockWorkspaces);
  } finally {
    console.log = originalLog;
    api.get = originalGet;
  }
});
