const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

let assertRemoteHostAgentUseImpl = async () => ({});

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function loadWorkerForExecTests() {
  const originalLoad = Module._load;
  const originalLog = console.log;
  const workerSuffix = "/workers/provisioner/worker.ts";
  const noop = () => undefined;
  const genericModule = new Proxy({}, { get: () => noop });

  class StubWorker {
    on() {}

    isRunning() {
      return true;
    }
  }

  class StubPool {
    async query() {
      return { rows: [] };
    }
  }

  class StubClient {}

  Module._load = function loadWorkerDependency(request, parent) {
    if (parent?.filename?.endsWith(workerSuffix)) {
      if (request === "bullmq") {
        return {
          Worker: StubWorker,
          UnrecoverableError: class UnrecoverableError extends Error {},
        };
      }
      if (request === "crypto") return originalLoad.apply(this, arguments);
      if (request === "ioredis") return function StubRedis() {};
      if (request === "pg") return { Pool: StubPool, Client: StubClient };
      if (request === "http") return { createServer: () => ({ listen() {} }) };
      if (request === "../../backend-api/lib/connectionConfig") {
        return {
          buildPostgresConfig: () => ({}),
          createRedisClient: () => ({}),
        };
      }
      if (request === "../../agent-runtime/lib/backendCatalog") {
        return {
          getDefaultBackend: () => "docker",
          getEnabledBackends: () => ["docker"],
          isKnownBackend: () => true,
          normalizeBackendName: (value) => value,
        };
      }
      if (request === "../../agent-runtime/lib/agentEndpoints") {
        return {
          runtimeUrlForAgent: () => "http://runtime.test/exec",
          buildRuntimeAuthHeaders: () => ({}),
        };
      }
      if (request === "../../backend-api/remoteHosts") {
        return {
          assertRemoteHostAgentUse: (...args) => assertRemoteHostAgentUseImpl(...args),
          isRemoteHostAccessRevokedError: (error) => error?.code === "REMOTE_HOST_ACCESS_REVOKED",
        };
      }
      if (request === "../../agent-runtime/lib/containerCommand") {
        return { shellSingleQuote };
      }
      if (request === "../../backend-api/redisQueue") {
        return { ALERT_DELIVERY_ATTEMPTS: 1 };
      }
      if (request.startsWith(".")) return genericModule;
    }
    return originalLoad.apply(this, arguments);
  };

  console.log = noop;
  try {
    return require("./worker.ts");
  } finally {
    console.log = originalLog;
    Module._load = originalLoad;
  }
}

const {
  buildProvisionerExecCleanupCommand,
  buildTrackedProvisionerCommand,
  fetchWithProvisionerAuthorization,
  guardRemoteProvisioner,
  provisionerExecStateDir,
  runRuntimeCommand,
  runProvisionerExecCommand,
} = loadWorkerForExecTests();

const REMOTE_RUNTIME_FIELDS = {
  runtime_family: "openclaw",
  deploy_target: "remote-docker",
  execution_target_id: "remote:test-host",
  sandbox_profile: "standard",
  backend_type: "remote-docker",
};

function extractCommandId(trackedCommand) {
  const match = trackedCommand.match(/\.nora-worker-exec-([a-f0-9]{32})/);
  assert.ok(match, "tracked command should contain its random command identity");
  return match[1];
}

function endedCleanupResult(output, status = { Running: false, ExitCode: 0 }) {
  const stream = new PassThrough();
  stream.end(output);
  return {
    exec: { inspect: async () => status },
    stream,
  };
}

function removeStateDir(commandId) {
  fs.rmSync(provisionerExecStateDir(commandId), { recursive: true, force: true });
}

function runShell(script, { timeout = 5000 } = {}) {
  return spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    timeout,
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function readProcIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const closeParen = stat.lastIndexOf(")");
  assert.notEqual(closeParen, -1);
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  return {
    pgrp: Number(fields[2]),
    startTime: fields[19],
  };
}

async function waitFor(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function waitForFile(filename, timeout = 3000) {
  await waitFor(() => fs.existsSync(filename), `timed out waiting for ${filename}`, timeout);
}

async function waitForChildExit(child, timeout = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for child ${child.pid}`)), timeout),
    ),
  ]);
}

function killProcessGroup(pgid) {
  if (!pgid) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

test("tracked command builders require setsid, atomically publish state, and preserve fast commands", () => {
  for (const command of ["true", "printf 'fast-output\\n'"]) {
    const commandId = randomBytes(16).toString("hex");
    const trackedCommand = buildTrackedProvisionerCommand(command, commandId);
    const cleanupCommand = buildProvisionerExecCleanupCommand(commandId);
    removeStateDir(commandId);

    assert.equal(runShell(`set -n\n${trackedCommand}`).status, 0);
    assert.equal(runShell(`set -n\n${cleanupCommand}`).status, 0);
    assert.match(trackedCommand, /command -v setsid/);
    assert.match(trackedCommand, /pid\.tmp\.\$\$/);
    assert.match(trackedCommand, /mv -f/);
    assert.match(trackedCommand, /\/proc\/\$\$\/stat/);
    assert.match(trackedCommand, /verify_group_identity/);
    assert.match(trackedCommand, /return 76/);
    assert.match(cleanupCommand, /identity changed before SIGKILL/);

    const result = runShell(trackedCommand);
    assert.equal(result.status, 0, result.stderr);
    if (command.startsWith("printf")) assert.equal(result.stdout, "fast-output\n");
    assert.equal(fs.existsSync(provisionerExecStateDir(commandId)), false);
  }
});

test("tracked wrapper removes leaderless descendants before reporting completion", () => {
  const commandId = randomBytes(16).toString("hex");
  const pgidFile = `/tmp/nora-tracked-pgid-${randomBytes(8).toString("hex")}`;
  const command = `printf '%s\\n' "$$" > ${shellSingleQuote(pgidFile)}; (trap '' HUP TERM; while :; do sleep 0.05; done) & exit 0`;

  try {
    const result = runShell(buildTrackedProvisionerCommand(command, commandId), { timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const trackedPgid = Number(fs.readFileSync(pgidFile, "utf8").trim());
    assert.equal(processGroupExists(trackedPgid), false);
  } finally {
    if (fs.existsSync(pgidFile)) {
      const trackedPgid = Number(fs.readFileSync(pgidFile, "utf8").trim());
      killProcessGroup(trackedPgid);
    }
    fs.rmSync(pgidFile, { force: true });
    removeStateDir(commandId);
  }
});

test("tracked wrapper retains evidence when SIGKILL or identity verification fails", () => {
  const cases = [
    {
      name: "SIGKILL rejection",
      expectedStatus: 74,
      shellFault: [
        "wait() { return 0; }",
        'kill() { if [ "$1" = "-KILL" ]; then return 1; fi; command kill "$@"; }',
      ].join("\n"),
      command: "exec >/dev/null 2>&1; trap '' TERM; while :; do sleep 0.05; done",
    },
    {
      name: "pre-TERM identity verification",
      expectedStatus: 76,
      shellFault: ["wait() { return 0; }", "awk() { printf '0 0\\n'; }"].join("\n"),
    },
  ];

  for (const fault of cases) {
    const commandId = randomBytes(16).toString("hex");
    const stateDir = provisionerExecStateDir(commandId);
    const termSignalFile = `/tmp/nora-wrapper-term-${randomBytes(8).toString("hex")}`;
    const command =
      fault.command ||
      `exec >/dev/null 2>&1; trap 'printf term > ${shellSingleQuote(termSignalFile)}' TERM; while :; do sleep 0.05; done`;
    let trackedPgid;

    try {
      const result = runShell(
        `${fault.shellFault}\n${buildTrackedProvisionerCommand(command, commandId)}`,
        { timeout: 5000 },
      );
      assert.equal(result.status, fault.expectedStatus, `${fault.name}: ${result.stderr}`);
      assert.match(
        result.stderr,
        new RegExp(
          `NORA_EXEC_WRAPPER_TERMINATION_UNCONFIRMED:${commandId}:0:${fault.expectedStatus}`,
        ),
      );
      assert.equal(fs.existsSync(stateDir), true, `${fault.name}: state directory was removed`);
      assert.equal(
        fs.readFileSync(path.join(stateDir, "termination"), "utf8"),
        `nora-exec-termination-v1 ${commandId} 0 ${fault.expectedStatus}\n`,
      );
      const pidState = fs.readFileSync(path.join(stateDir, "pid"), "utf8").trim().split(" ");
      trackedPgid = Number(pidState[2]);
      assert.equal(processGroupExists(trackedPgid), true, `${fault.name}: group already exited`);
      if (fault.expectedStatus === 76) {
        assert.equal(
          fs.existsSync(termSignalFile),
          false,
          "identity mismatch must be detected before SIGTERM",
        );
      }

      const cleanup = runShell(buildProvisionerExecCleanupCommand(commandId), { timeout: 5000 });
      assert.equal(cleanup.status, 0, `${fault.name}: ${cleanup.stderr}`);
      assert.match(cleanup.stdout, new RegExp(`NORA_EXEC_CLEANUP_OK:${commandId}`));
      assert.equal(fs.existsSync(stateDir), false);
    } finally {
      killProcessGroup(trackedPgid);
      fs.rmSync(termSignalFile, { force: true });
      removeStateDir(commandId);
    }
  }
});

test("Remote Docker timeout invokes only fixed cleanup and confirms an already-ended stream", async () => {
  const calls = [];
  const commandStream = new PassThrough();
  const baseProvisioner = {
    exec: async (containerId, options) => {
      calls.push({ containerId, options });
      if (calls.length === 1) {
        return {
          exec: { inspect: async () => ({ Running: true, ExitCode: null }) },
          stream: commandStream,
        };
      }
      const commandId = extractCommandId(calls[0].options.cmd[2]);
      return endedCleanupResult(`NORA_EXEC_CLEANUP_OK:${commandId}\n`);
    },
  };
  const provisioner = guardRemoteProvisioner(baseProvisioner, REMOTE_RUNTIME_FIELDS, "owner-1");
  const arbitraryCommand = "sleep 60; printf 'must-not-enter-cleanup'";

  await assert.rejects(
    runProvisionerExecCommand(provisioner, "container-1", arbitraryCommand, {
      timeout: 10,
      agentId: "agent-1",
    }),
    /Container command timed out after 10ms/,
  );

  assert.equal(calls.length, 2);
  assert.equal(typeof calls[1].options, "object");
  assert.deepEqual(calls[1].options.cmd.slice(0, 2), ["/bin/sh", "-c"]);
  assert.equal(calls[1].options.tty, false);
  assert.deepEqual(calls[1].options.env, []);
  assert.equal(calls[1].options.agentId, "agent-1");
  assert.doesNotMatch(calls[1].options.cmd[2], /must-not-enter-cleanup|sleep 60/);
  assert.match(calls[1].options.cmd[2], /kill -TERM/);
  assert.match(calls[1].options.cmd[2], /kill -KILL/);
});

test("authorized runtime fetch aborts when the Remote Docker grant is revoked in flight", async (t) => {
  const originalFetch = global.fetch;
  const originalAssertion = assertRemoteHostAgentUseImpl;
  t.after(() => {
    global.fetch = originalFetch;
    assertRemoteHostAgentUseImpl = originalAssertion;
  });

  let revoked = false;
  let fetchStarted = false;
  let requestSignal;
  assertRemoteHostAgentUseImpl = async () => {
    if (!revoked) return {};
    throw Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
  };
  global.fetch = async (_resource, init) =>
    new Promise((resolve, reject) => {
      fetchStarted = true;
      requestSignal = init.signal;
      requestSignal.addEventListener(
        "abort",
        () => reject(requestSignal.reason || new Error("request aborted")),
        { once: true },
      );
    });

  const provisioner = guardRemoteProvisioner({}, REMOTE_RUNTIME_FIELDS, "owner-1");
  const request = fetchWithProvisionerAuthorization(
    provisioner,
    "http://runtime.test/integrations/sync",
    { method: "POST" },
    { authorizationRecheckMs: 5 },
  );
  await waitFor(() => fetchStarted, "authorized integration fetch did not start");
  revoked = true;

  await assert.rejects(request, (error) => {
    assert.equal(error.code, "REMOTE_HOST_ACCESS_REVOKED");
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.equal(requestSignal.aborted, true);
});

test("authorized runtime fetch catches revocation racing a successful response", async (t) => {
  const originalFetch = global.fetch;
  const originalAssertion = assertRemoteHostAgentUseImpl;
  t.after(() => {
    global.fetch = originalFetch;
    assertRemoteHostAgentUseImpl = originalAssertion;
  });

  let revoked = false;
  let authorizationChecks = 0;
  assertRemoteHostAgentUseImpl = async () => {
    authorizationChecks += 1;
    if (!revoked) return {};
    throw Object.assign(new Error("Remote host access was revoked"), {
      code: "REMOTE_HOST_ACCESS_REVOKED",
      statusCode: 403,
    });
  };
  global.fetch = async () => {
    revoked = true;
    return { ok: true, status: 200 };
  };

  const provisioner = guardRemoteProvisioner({}, REMOTE_RUNTIME_FIELDS, "owner-1");
  await assert.rejects(
    fetchWithProvisionerAuthorization(
      provisioner,
      "http://runtime.test/integrations/sync",
      { method: "POST" },
      { authorizationRecheckMs: 1000 },
    ),
    (error) => {
      assert.equal(error.code, "REMOTE_HOST_ACCESS_REVOKED");
      return true;
    },
  );
  assert.equal(authorizationChecks, 2);
});

test("authorized runtime fetch rejects non-success integration responses", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({ ok: false, status: 503 });

  await assert.rejects(
    fetchWithProvisionerAuthorization({}, "http://runtime.test/integrations/sync", {
      method: "POST",
    }),
    /Runtime request failed with HTTP 503/,
  );
});

test("runtime command waits for an in-flight authorization rejection before succeeding", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let authorizationChecks = 0;
  let resolveBody;
  let pendingAuthorizationReject;
  const beforeAttempt = async () => {
    authorizationChecks += 1;
    if (authorizationChecks === 1) return;
    return new Promise((_resolve, reject) => {
      pendingAuthorizationReject = reject;
    });
  };
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((resolve) => {
        resolveBody = resolve;
      }),
  });

  const command = runRuntimeCommand({ runtime_host: "runtime.test", runtime_port: 80 }, "true", {
    beforeAttempt,
    authorizationRecheckMs: 5,
  });
  await waitFor(() => authorizationChecks >= 2, "authorization recheck did not start");
  resolveBody({ exitCode: 0 });
  const revoked = Object.assign(new Error("Remote host access was revoked"), {
    code: "REMOTE_HOST_ACCESS_REVOKED",
    statusCode: 403,
  });
  pendingAuthorizationReject(revoked);

  await assert.rejects(command, (error) => {
    assert.equal(error, revoked);
    return true;
  });
  assert.equal(authorizationChecks, 2);
});

test("runtime command fails closed on malformed JSON", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });

  await assert.rejects(
    runRuntimeCommand({ runtime_host: "runtime.test", runtime_port: 80 }, "true"),
    (error) => {
      assert.equal(error.code, "RUNTIME_COMMAND_RESPONSE_INVALID");
      return true;
    },
  );
});

test("runtime command requires an integer zero exit code", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  for (const payload of [{}, { exitCode: null }, { exitCode: "0" }, { exitCode: 0.5 }]) {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    await assert.rejects(
      runRuntimeCommand({ runtime_host: "runtime.test", runtime_port: 80 }, "true"),
      (error) => {
        assert.equal(error.code, "RUNTIME_COMMAND_EXIT_UNCONFIRMED");
        return true;
      },
    );
  }

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ exitCode: 1, stderr: "command failed" }),
  });
  await assert.rejects(
    runRuntimeCommand({ runtime_host: "runtime.test", runtime_port: 80 }, "false"),
    (error) => {
      assert.equal(error.code, "RUNTIME_COMMAND_FAILED");
      assert.equal(error.exitCode, 1);
      return true;
    },
  );

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ exitCode: 0, stdout: "ok" }),
  });
  assert.deepEqual(
    await runRuntimeCommand({ runtime_host: "runtime.test", runtime_port: 80 }, "true"),
    { exitCode: 0, stdout: "ok" },
  );
});

test("cleanup exit or marker failure surfaces termination-unconfirmed with both errors", async () => {
  for (const cleanupResult of [
    () => endedCleanupResult("", { Running: false, ExitCode: 0 }),
    (commandId) =>
      endedCleanupResult(`NORA_EXEC_CLEANUP_OK:${commandId}\n`, {
        Running: false,
        ExitCode: 75,
      }),
  ]) {
    const calls = [];
    const baseProvisioner = {
      exec: async (_containerId, options) => {
        calls.push(options);
        if (calls.length === 1) {
          return {
            exec: { inspect: async () => ({ Running: true, ExitCode: null }) },
            stream: new PassThrough(),
          };
        }
        return cleanupResult(extractCommandId(calls[0].cmd[2]));
      },
    };
    const provisioner = guardRemoteProvisioner(baseProvisioner, REMOTE_RUNTIME_FIELDS, "owner-1");

    let failure;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await runProvisionerExecCommand(provisioner, "container-1", "sleep 60", { timeout: 10 });
    } catch (error) {
      failure = error;
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(failure?.code, "PROVISIONER_EXEC_TERMINATION_UNCONFIRMED");
    assert.match(failure?.cause?.message || "", /Container command timed out after 10ms/);
    assert.ok(failure?.cleanupError instanceof Error);
    assert.notEqual(failure.cleanupError, failure.cause);
  }
});

test("attach close while exec is still running invokes fixed cleanup and fails closed", async () => {
  for (const cleanupSucceeds of [true, false]) {
    const calls = [];
    const commandStream = new PassThrough();
    const baseProvisioner = {
      exec: async (_containerId, options) => {
        calls.push(options);
        const commandId = extractCommandId(calls[0].cmd[2]);
        if (calls.length === 1) {
          setImmediate(() => commandStream.destroy());
          return {
            exec: { inspect: async () => ({ Running: true, ExitCode: null }) },
            stream: commandStream,
          };
        }
        return endedCleanupResult(cleanupSucceeds ? `NORA_EXEC_CLEANUP_OK:${commandId}\n` : "");
      },
    };

    let failure;
    try {
      await runProvisionerExecCommand(
        baseProvisioner,
        "container-1",
        "sleep 60; printf 'must-not-enter-cleanup'",
        { timeout: 1000, agentId: "agent-1" },
      );
    } catch (error) {
      failure = error;
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].cmd.slice(0, 2), ["/bin/sh", "-c"]);
    assert.doesNotMatch(calls[1].cmd[2], /must-not-enter-cleanup|sleep 60/);
    if (cleanupSucceeds) {
      assert.equal(failure?.code, "PROVISIONER_EXEC_EXIT_UNCONFIRMED");
      assert.match(failure?.message || "", /stream ended before tracked command exit/i);
    } else {
      assert.equal(failure?.code, "PROVISIONER_EXEC_TERMINATION_UNCONFIRMED");
      assert.equal(failure?.cause?.code, "PROVISIONER_EXEC_EXIT_UNCONFIRMED");
      assert.match(failure?.cleanupError?.message || "", /confirmation marker was missing/i);
    }
  }
});

test("wrapper termination failures use fixed cleanup and preserve unconfirmed classification", async () => {
  for (const terminationStatus of [73, 74, 75, 76]) {
    const calls = [];
    const baseProvisioner = {
      exec: async (_containerId, options) => {
        calls.push(options);
        const commandId = extractCommandId(calls[0].cmd[2]);
        if (calls.length === 1) {
          const stream = new PassThrough();
          setImmediate(() => {
            stream.end(
              `\nNORA_EXEC_WRAPPER_TERMINATION_UNCONFIRMED:${commandId}:0:${terminationStatus}\n`,
            );
          });
          return {
            exec: {
              inspect: async () => ({ Running: false, ExitCode: terminationStatus }),
            },
            stream,
          };
        }
        return endedCleanupResult(`NORA_EXEC_CLEANUP_OK:${commandId}\n`, {
          Running: false,
          ExitCode: terminationStatus,
        });
      },
    };

    let failure;
    try {
      await runProvisionerExecCommand(baseProvisioner, "container-1", "nora-original-command", {
        timeout: 1000,
      });
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.code, "PROVISIONER_EXEC_TERMINATION_UNCONFIRMED");
    assert.equal(failure?.cause?.terminationExitCode, terminationStatus);
    assert.ok(failure?.cleanupError instanceof Error);
    assert.notEqual(failure.cleanupError, failure.cause);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[1].cmd[2], /nora-original-command/);
  }
});

test("exec inspection cannot outrun the wrapper termination marker", async () => {
  const calls = [];
  const baseProvisioner = {
    exec: async (_containerId, options) => {
      calls.push(options);
      const commandId = extractCommandId(calls[0].cmd[2]);
      if (calls.length === 1) {
        const stream = new PassThrough();
        setTimeout(() => {
          stream.end(`\nNORA_EXEC_WRAPPER_TERMINATION_UNCONFIRMED:${commandId}:0:74\n`);
        }, 650);
        return {
          exec: { inspect: async () => ({ Running: false, ExitCode: 74 }) },
          stream,
        };
      }
      return endedCleanupResult(`NORA_EXEC_CLEANUP_OK:${commandId}\n`, {
        Running: false,
        ExitCode: 75,
      });
    },
  };

  await assert.rejects(
    runProvisionerExecCommand(baseProvisioner, "container-1", "nora-race-command", {
      timeout: 1500,
    }),
    (error) => {
      assert.equal(error.code, "PROVISIONER_EXEC_TERMINATION_UNCONFIRMED");
      assert.equal(error.cause?.terminationExitCode, 74);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("fixed cleanup recovery preserves wrapped command result and strips supervisor evidence", async () => {
  const calls = [];
  const baseProvisioner = {
    exec: async (_containerId, options) => {
      calls.push(options);
      const commandId = extractCommandId(calls[0].cmd[2]);
      if (calls.length === 1) {
        const stream = new PassThrough();
        setImmediate(() => {
          stream.end(
            `command-output\nNORA_EXEC_WRAPPER_TERMINATION_UNCONFIRMED:${commandId}:0:74\n`,
          );
        });
        return {
          exec: { inspect: async () => ({ Running: false, ExitCode: 74 }) },
          stream,
        };
      }
      return endedCleanupResult(`NORA_EXEC_CLEANUP_OK:${commandId}\n`);
    },
  };

  const result = await runProvisionerExecCommand(baseProvisioner, "container-1", "true", {
    timeout: 1000,
  });

  assert.deepEqual(result, { exitCode: 0, output: "command-output" });
  assert.equal(calls.length, 2);
});

test("wrapped application exits 73-76 remain ordinary command failures", async () => {
  for (const exitCode of [73, 74, 75, 76]) {
    const calls = [];
    const baseProvisioner = {
      exec: async (_containerId, options) => {
        calls.push(options);
        const stream = new PassThrough();
        setImmediate(() => stream.end(`application-exit-${exitCode}\n`));
        return {
          exec: { inspect: async () => ({ Running: false, ExitCode: exitCode }) },
          stream,
        };
      },
    };

    await assert.rejects(
      runProvisionerExecCommand(baseProvisioner, "container-1", `exit ${exitCode}`, {
        timeout: 1000,
      }),
      (error) => {
        assert.equal(error.code, undefined);
        assert.match(error.message, new RegExp(`application-exit-${exitCode}`));
        return true;
      },
    );
    assert.equal(calls.length, 1);
  }
});

test("missing, malformed, and reused-leader PID state never signal another process group", () => {
  const commandId = randomBytes(16).toString("hex");
  const stateDir = provisionerExecStateDir(commandId);
  const pidFile = path.join(stateDir, "pid");
  const cleanupCommand = buildProvisionerExecCleanupCommand(commandId);
  const victim = spawn("/bin/sh", ["-c", "while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  victim.unref();

  try {
    const identity = readProcIdentity(victim.pid);
    assert.equal(identity.pgrp, victim.pid);

    removeStateDir(commandId);
    assert.equal(runShell(cleanupCommand).status, 70);
    assert.equal(processExists(victim.pid), true);

    const unsafeStates = [
      {
        name: "malformed start time",
        state: `nora-exec-v1 ${commandId} ${victim.pid} not-numeric\n`,
        exitCode: 71,
      },
      {
        name: "different command identity",
        state: `nora-exec-v1 ${"f".repeat(32)} ${victim.pid} ${identity.startTime}\n`,
        exitCode: 72,
      },
      {
        name: "reused leader with a different start time",
        state: `nora-exec-v1 ${commandId} ${victim.pid} ${BigInt(identity.startTime) + 1n}\n`,
        exitCode: 72,
      },
      {
        name: "trailing state content",
        state: `nora-exec-v1 ${commandId} ${victim.pid} ${identity.startTime}\nextra\n`,
        exitCode: 71,
      },
    ];

    for (const { name, state, exitCode } of unsafeStates) {
      removeStateDir(commandId);
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.writeFileSync(pidFile, state, { mode: 0o600 });
      assert.equal(runShell(cleanupCommand).status, exitCode, name);
      assert.equal(processExists(victim.pid), true, `cleanup signaled victim for ${name}`);
    }
  } finally {
    killProcessGroup(victim.pid);
    removeStateDir(commandId);
  }
});

test("cleanup terminates verified descendants after their original group leader exits", async () => {
  const commandId = randomBytes(16).toString("hex");
  const stateDir = provisionerExecStateDir(commandId);
  const nonce = randomBytes(8).toString("hex");
  const childFile = `/tmp/nora-leaderless-child-${nonce}`;
  const exitGate = `/tmp/nora-leaderless-gate-${nonce}`;
  const leader = spawn(
    "/bin/sh",
    [
      "-c",
      `trap '' HUP; (trap '' HUP TERM; while :; do sleep 0.05; done) & printf '%s\\n' "$!" > ${shellSingleQuote(childFile)}; while [ ! -f ${shellSingleQuote(exitGate)} ]; do sleep 0.01; done; exit 0`,
    ],
    { detached: true, stdio: "ignore" },
  );
  let descendantPid;

  try {
    const leaderIdentity = readProcIdentity(leader.pid);
    assert.equal(leaderIdentity.pgrp, leader.pid);
    await waitForFile(childFile);
    descendantPid = Number(fs.readFileSync(childFile, "utf8").trim());
    assert.equal(readProcIdentity(descendantPid).pgrp, leader.pid);

    fs.writeFileSync(exitGate, "exit\n");
    await waitForChildExit(leader);
    assert.equal(processExists(leader.pid), false);
    assert.equal(processGroupExists(leader.pid), true);

    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "pid"),
      `nora-exec-v1 ${commandId} ${leader.pid} ${leaderIdentity.startTime}\n`,
      { mode: 0o600 },
    );
    const cleanup = runShell(buildProvisionerExecCleanupCommand(commandId), { timeout: 5000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stdout, new RegExp(`NORA_EXEC_CLEANUP_OK:${commandId}`));
    await waitFor(
      () => !processGroupExists(leader.pid),
      "leaderless tracked descendants survived cleanup",
    );
  } finally {
    killProcessGroup(leader.pid);
    fs.rmSync(childFile, { force: true });
    fs.rmSync(exitGate, { force: true });
    removeStateDir(commandId);
  }
});

test("cleanup kills a TERM-ignoring tracked group while an unrelated group survives", async () => {
  const commandId = randomBytes(16).toString("hex");
  const stateDir = provisionerExecStateDir(commandId);
  const trackedCommand = buildTrackedProvisionerCommand(
    "trap '' TERM; while :; do sleep 0.05; done",
    commandId,
  );
  const cleanupCommand = buildProvisionerExecCleanupCommand(commandId);
  const unrelated = spawn("/bin/sh", ["-c", "while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  unrelated.unref();
  const tracked = spawn("/bin/sh", ["-c", trackedCommand], { stdio: "ignore" });
  let trackedPgid;

  try {
    await waitForFile(path.join(stateDir, "pid"));
    const state = fs.readFileSync(path.join(stateDir, "pid"), "utf8").trim().split(" ");
    assert.deepEqual(state.slice(0, 2), ["nora-exec-v1", commandId]);
    trackedPgid = Number(state[2]);
    assert.equal(processGroupExists(trackedPgid), true);
    assert.equal(processExists(unrelated.pid), true);

    const cleanup = runShell(cleanupCommand, { timeout: 5000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stdout, new RegExp(`NORA_EXEC_CLEANUP_OK:${commandId}`));

    await waitFor(() => !processGroupExists(trackedPgid), "tracked process group survived cleanup");
    assert.equal(processExists(unrelated.pid), true);
  } finally {
    killProcessGroup(trackedPgid);
    killProcessGroup(unrelated.pid);
    tracked.kill("SIGKILL");
    removeStateDir(commandId);
  }
});
