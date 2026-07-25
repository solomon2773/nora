import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

import { afterEach, describe, expect, it } from "vitest";

import * as execEndpoint from "../lib/execEndpoint.ts";

const { handleExec, signalProcessGroup } = execEndpoint;

const cleanupPids = new Set<number>();
const cleanupPaths = new Set<string>();
const cleanupChildren = new Set<ReturnType<typeof spawn>>();
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeTestToken = "runtime-exec-test-token";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

function processGroupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function tempPidPath(label: string) {
  const file = path.join(
    os.tmpdir(),
    `nora-runtime-exec-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`,
  );
  cleanupPaths.add(file);
  return file;
}

function longRunningCommand(pidFile: string) {
  return `trap '' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done`;
}

function termIgnoringDescendantCommand(groupFile: string, descendantFile: string) {
  return [
    `echo $$ > ${JSON.stringify(groupFile)}`,
    `sh -c 'trap "" TERM; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &`,
    `echo $! > ${JSON.stringify(descendantFile)}`,
    "wait",
  ].join("\n");
}

function readTrackedPid(pidFile: string) {
  const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  cleanupPids.add(pid);
  return pid;
}

async function startRuntimeServerProcess(token: string | null = runtimeTestToken) {
  const startupScript = [
    'const { server } = require("./lib/server.ts");',
    'server.listen(0, "127.0.0.1", () => {',
    "  console.log(`NORA_TEST_PORT=${server.address().port}`);",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "-e", startupScript], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      AGENT_HTTP_PORT: "0",
      NODE_NO_WARNINGS: "1",
      OPENCLAW_GATEWAY_TOKEN: token || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanupChildren.add(child);

  return new Promise<{ port: number }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Runtime server did not start: ${stderr || stdout}`));
    }, 5000);

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/NORA_TEST_PORT=(\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve({ port: Number.parseInt(match[1], 10) });
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Runtime server exited with code ${code}: ${stderr || stdout}`));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", onExit);
  });
}

function requestRuntime({
  port,
  path = "/exec",
  body = "",
  token = runtimeTestToken,
}: {
  port: number;
  path?: string;
  body?: string;
  token?: string | null;
}) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: path === "/health" ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function stopChild(child: ReturnType<typeof spawn>) {
  cleanupChildren.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, wait(500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

afterEach(async () => {
  await Promise.all([...cleanupChildren].map((child) => stopChild(child)));
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  cleanupPids.clear();
  for (const file of cleanupPaths) fs.rmSync(file, { force: true });
  cleanupPaths.clear();
});

describe("runtime exec", () => {
  it("returns stdout, stderr, and exit status after normal completion", async () => {
    await expect(
      handleExec({ command: "printf success; printf warning >&2; exit 7", timeout: 1000 }),
    ).resolves.toEqual({
      exitCode: 7,
      stdout: "success",
      stderr: "warning",
    });
  });

  it("fails closed when a child closes without an exit code or signal", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const execution = handleExec(
      { command: "ignored", timeout: 1000 },
      {
        spawnImpl: () => child,
        readProcessIdentityImpl: () => ({
          pid: child.pid,
          processGroupId: child.pid,
          startTime: "123",
        }),
      },
    );
    queueMicrotask(() => child.emit("close", null, null));

    await expect(execution).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Command exited without an exit code or terminating signal",
    });
  });

  it("keeps health public but rejects sensitive routes when the runtime token is missing", async () => {
    const { port } = await startRuntimeServerProcess(null);

    await expect(requestRuntime({ port, path: "/health", token: null })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      requestRuntime({
        port,
        body: JSON.stringify({ command: "printf should-not-run" }),
        token: null,
      }),
    ).resolves.toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: "unauthorized" }),
    });
  });

  it("rejects oversized exec bodies before spawning a command", async () => {
    const { port } = await startRuntimeServerProcess();
    const response = await requestRuntime({
      port,
      body: JSON.stringify({ command: "x".repeat(70 * 1024) }),
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "request_body_too_large" });
  });

  it("kills and reports a command that exceeds its timeout", async () => {
    const pidFile = tempPidPath("timeout");
    const execution = handleExec(
      { command: longRunningCommand(pidFile), timeout: 150 },
      { killGraceMs: 30 },
    );

    await waitUntil(() => fs.existsSync(pidFile));
    const pid = readTrackedPid(pidFile);
    await expect(execution).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    await waitUntil(() => !processExists(pid));
  });

  it("kills the command process group when its abort signal fires", async () => {
    const pidFile = tempPidPath("signal");
    const controller = new AbortController();
    const execution = handleExec(
      { command: longRunningCommand(pidFile), timeout: 10000 },
      { signal: controller.signal, killGraceMs: 50 },
    );

    await waitUntil(() => fs.existsSync(pidFile));
    const pid = readTrackedPid(pidFile);
    expect(processExists(pid)).toBe(true);

    controller.abort(new Error("grant revoked"));
    await expect(execution).resolves.toMatchObject({ exitCode: 130, aborted: true });
    await waitUntil(() => !processExists(pid));
  });

  it("rechecks an abort that races with listener registration", async () => {
    const raceSignal = {
      aborted: false,
      addEventListener() {
        this.aborted = true;
      },
      removeEventListener() {},
    };

    await expect(
      handleExec(
        { command: "trap '' TERM; while :; do sleep 1; done", timeout: 10000 },
        { signal: raceSignal, killGraceMs: 20 },
      ),
    ).resolves.toMatchObject({ exitCode: 130, aborted: true });
  });

  it("kills TERM-ignoring descendants after the group leader closes", async () => {
    const groupFile = tempPidPath("group-leader");
    const descendantFile = tempPidPath("term-ignoring-descendant");
    const controller = new AbortController();
    const execution = handleExec(
      {
        command: termIgnoringDescendantCommand(groupFile, descendantFile),
        timeout: 10000,
      },
      { signal: controller.signal, killGraceMs: 75 },
    );

    await waitUntil(() => fs.existsSync(groupFile) && fs.existsSync(descendantFile));
    const groupLeaderPid = readTrackedPid(groupFile);
    const descendantPid = readTrackedPid(descendantFile);
    expect(processExists(groupLeaderPid)).toBe(true);
    expect(processExists(descendantPid)).toBe(true);

    controller.abort(new Error("grant revoked"));
    await expect(execution).resolves.toMatchObject({ exitCode: 130, aborted: true });
    await waitUntil(() => !processGroupExists(groupLeaderPid) && !processExists(descendantPid));
  });

  it("kills TERM-ignoring descendants after a timeout", async () => {
    const groupFile = tempPidPath("timeout-group-leader");
    const descendantFile = tempPidPath("timeout-term-ignoring-descendant");
    const execution = handleExec(
      {
        command: termIgnoringDescendantCommand(groupFile, descendantFile),
        timeout: 250,
      },
      { killGraceMs: 75 },
    );

    await waitUntil(() => fs.existsSync(groupFile) && fs.existsSync(descendantFile));
    const groupLeaderPid = readTrackedPid(groupFile);
    const descendantPid = readTrackedPid(descendantFile);

    await expect(execution).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    await waitUntil(() => !processGroupExists(groupLeaderPid) && !processExists(descendantPid));
  });

  it("does not signal an unrelated process group", async () => {
    const unrelated = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
      detached: true,
      stdio: "ignore",
    });
    if (!unrelated.pid) throw new Error("Unrelated process did not start");
    unrelated.unref();
    cleanupPids.add(unrelated.pid);

    const targetFile = tempPidPath("isolated-target");
    const controller = new AbortController();
    const execution = handleExec(
      { command: longRunningCommand(targetFile), timeout: 10000 },
      { signal: controller.signal, killGraceMs: 30 },
    );
    await waitUntil(() => fs.existsSync(targetFile));
    const targetPid = readTrackedPid(targetFile);

    controller.abort(new Error("grant revoked"));
    await expect(execution).resolves.toMatchObject({ exitCode: 130, aborted: true });
    await waitUntil(() => !processExists(targetPid));
    expect(processExists(unrelated.pid)).toBe(true);
  });

  it("surfaces unexpected process-group signaling failures", async () => {
    const pidFile = tempPidPath("signal-failure");
    const controller = new AbortController();
    let injectedFailure = false;
    const execution = handleExec(
      { command: longRunningCommand(pidFile), timeout: 10000 },
      {
        signal: controller.signal,
        killGraceMs: 20,
        signalProcessGroupImpl(processGroupId: number, processSignal: string | number) {
          if (processSignal === "SIGTERM" && !injectedFailure) {
            injectedFailure = true;
            const error: any = new Error("operation not permitted");
            error.code = "EPERM";
            throw error;
          }
          return signalProcessGroup(processGroupId, processSignal);
        },
      },
    );

    await waitUntil(() => fs.existsSync(pidFile));
    const pid = readTrackedPid(pidFile);
    controller.abort(new Error("grant revoked"));

    await expect(execution).resolves.toMatchObject({
      exitCode: 1,
      aborted: true,
      terminationFailed: true,
      terminationErrorCode: "EXEC_PROCESS_GROUP_TERMINATION_FAILED",
    });
    await waitUntil(() => !processExists(pid));
  });

  it("does not SIGKILL a process group whose leader identity was reused", async () => {
    const pidFile = tempPidPath("reused-process-group");
    const controller = new AbortController();
    let identityReads = 0;
    const deliveredSignals: Array<string | number> = [];
    const execution = handleExec(
      { command: longRunningCommand(pidFile), timeout: 10000 },
      {
        signal: controller.signal,
        killGraceMs: 20,
        groupExitTimeoutMs: 30,
        readProcessIdentityImpl(pid: number) {
          identityReads += 1;
          return {
            pid,
            processGroupId: pid,
            startTime: identityReads <= 2 ? "original-start" : "reused-start",
          };
        },
        signalProcessGroupImpl(processGroupId: number, processSignal: string | number) {
          deliveredSignals.push(processSignal);
          return signalProcessGroup(processGroupId, processSignal);
        },
      },
    );

    await waitUntil(() => fs.existsSync(pidFile));
    const pid = readTrackedPid(pidFile);
    controller.abort(new Error("grant revoked"));

    const result = await execution;
    expect(result).toMatchObject({
      exitCode: 1,
      aborted: true,
      terminationFailed: true,
      terminationErrorCode: "EXEC_PROCESS_GROUP_TERMINATION_FAILED",
    });
    expect(result.stderr).toContain("no longer matches its captured start time");
    expect(deliveredSignals).toEqual(["SIGTERM"]);
    expect(processExists(pid)).toBe(true);
  });

  it("kills the command when the HTTP client disconnects", async () => {
    const pidFile = tempPidPath("http-close");
    const { port } = await startRuntimeServerProcess();

    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/exec",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeTestToken}`,
      },
    });
    request.on("error", () => {});
    request.end(
      JSON.stringify({
        command: longRunningCommand(pidFile),
        timeout: 10000,
      }),
    );

    await waitUntil(() => fs.existsSync(pidFile));
    const pid = readTrackedPid(pidFile);
    expect(processExists(pid)).toBe(true);

    request.destroy();
    await waitUntil(() => !processExists(pid), 5000);
  });
});
