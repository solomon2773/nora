// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Intentionally-shell-executing handler for the agent runtime's /exec endpoint.
//
// This file is explicitly excluded from CodeQL analysis via
// .github/codeql-config.yml → paths-ignore. Rationale:
//
//   /exec IS the designed terminal surface of the agent runtime. Authenticated
//   callers pass an arbitrary shell command; it runs inside the agent's own
//   container. The container sandbox is the isolation boundary — not this
//   code. A CodeQL js/command-line-injection flag here is structurally correct
//   ("a shell is being fed untrusted input") but semantically the feature.
//   Isolating the handler into its own file keeps CodeQL focused on code that
//   SHOULDN'T exec shell commands, without blanket-disabling the rule.
//
// Keep this file small and single-purpose. Do NOT add anything here that
// would benefit from CodeQL coverage.
// ────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const { spawn } = require("child_process");

const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const MAX_EXEC_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1000;
const DEFAULT_PROCESS_GROUP_EXIT_TIMEOUT_MS = 2000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 10;

function normalizePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIdentityError(message, code = "EXEC_PROCESS_IDENTITY_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readProcessIdentity(pid, readFileImpl = fs.readFileSync) {
  let stat;
  try {
    stat = readFileImpl(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }

  const firstSpace = stat.indexOf(" ");
  const closingParen = stat.lastIndexOf(")");
  if (firstSpace <= 0 || closingParen <= firstSpace || stat[closingParen + 1] !== " ") {
    throw processIdentityError(`Malformed process identity for pid ${pid}`);
  }

  const parsedPid = Number.parseInt(stat.slice(0, firstSpace), 10);
  // Fields after the comm delimiter begin with field 3 (state). pgrp is field
  // 5 (tail index 2), and starttime is field 22 (tail index 19).
  const tail = stat
    .slice(closingParen + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = Number.parseInt(tail[2], 10);
  const startTime = tail[19];
  if (
    parsedPid !== pid ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0 ||
    !/^\d+$/.test(startTime || "")
  ) {
    throw processIdentityError(`Malformed process identity for pid ${pid}`);
  }

  return { pid: parsedPid, processGroupId, startTime };
}

function captureProcessGroupIdentity(pid, readProcessIdentityImpl = readProcessIdentity) {
  const identity = readProcessIdentityImpl(pid);
  if (!identity) {
    throw processIdentityError(
      `Command process group leader ${pid} exited before its identity could be captured`,
      "EXEC_PROCESS_GROUP_IDENTITY_UNAVAILABLE",
    );
  }
  if (identity.pid !== pid || identity.processGroupId !== pid || !identity.startTime) {
    throw processIdentityError(
      `Spawned command pid ${pid} is not its expected process group leader`,
      "EXEC_PROCESS_GROUP_IDENTITY_MISMATCH",
    );
  }
  return identity;
}

function signalProcessGroup(processGroupId, signal, killImpl = process.kill) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    const error = new Error("Command process group id is unavailable");
    error.code = "EXEC_PROCESS_GROUP_UNAVAILABLE";
    throw error;
  }

  try {
    // Runtime containers are Linux. `detached: true` makes the shell the
    // leader of a new process group so every descendant receives the signal.
    killImpl(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(processGroupId, killImpl = process.kill) {
  return signalProcessGroup(processGroupId, 0, killImpl);
}

function matchingProcessGroupIdentity(expected, actual) {
  return (
    actual?.pid === expected.pid &&
    actual?.processGroupId === expected.processGroupId &&
    actual?.startTime === expected.startTime
  );
}

function processGroupIdentityMismatch(expected, actual) {
  const error = processIdentityError(
    `Command process group leader ${expected.pid} no longer matches its captured start time`,
    "EXEC_PROCESS_GROUP_IDENTITY_MISMATCH",
  );
  error.expectedIdentity = expected;
  error.actualIdentity = actual;
  return error;
}

function signalOriginalProcessGroup(
  identity,
  signal,
  {
    identityCaptureError = null,
    readProcessIdentityImpl = readProcessIdentity,
    processGroupExistsImpl = processGroupExists,
    signalProcessGroupImpl = signalProcessGroup,
  } = {},
) {
  if (identityCaptureError) throw identityCaptureError;
  if (!identity) {
    throw processIdentityError(
      "Command process group identity is unavailable",
      "EXEC_PROCESS_GROUP_IDENTITY_UNAVAILABLE",
    );
  }

  const currentIdentity = readProcessIdentityImpl(identity.pid);
  if (currentIdentity) {
    if (!matchingProcessGroupIdentity(identity, currentIdentity)) {
      throw processGroupIdentityMismatch(identity, currentIdentity);
    }
  } else if (!processGroupExistsImpl(identity.processGroupId)) {
    return false;
  }

  return signalProcessGroupImpl(identity.processGroupId, signal);
}

async function waitForProcessGroupExit(
  processGroupId,
  timeoutMs,
  processGroupExistsImpl = processGroupExists,
) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExistsImpl(processGroupId)) {
    if (Date.now() >= deadline) {
      const error = new Error(`Command process group ${processGroupId} still exists after SIGKILL`);
      error.code = "EXEC_PROCESS_GROUP_STILL_RUNNING";
      throw error;
    }
    await delay(Math.min(PROCESS_GROUP_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

function terminationError(processGroupId, errors) {
  const details = errors
    .map(({ stage, error }) => `${stage}: ${error?.message || String(error)}`)
    .join("; ");
  const result = new Error(
    `Failed to terminate command process group ${processGroupId}: ${details}`,
  );
  result.code = "EXEC_PROCESS_GROUP_TERMINATION_FAILED";
  result.causes = errors.map(({ error }) => error);
  return result;
}

async function terminateProcessGroup(
  identity,
  {
    identityCaptureError = null,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    groupExitTimeoutMs = DEFAULT_PROCESS_GROUP_EXIT_TIMEOUT_MS,
    readProcessIdentityImpl = readProcessIdentity,
    signalProcessGroupImpl = signalProcessGroup,
    processGroupExistsImpl = processGroupExists,
  } = {},
) {
  const errors = [];
  const processGroupId = identity?.processGroupId || identity?.pid || "unknown";
  const signalOptions = {
    identityCaptureError,
    readProcessIdentityImpl,
    processGroupExistsImpl,
    signalProcessGroupImpl,
  };

  try {
    signalOriginalProcessGroup(identity, "SIGTERM", signalOptions);
  } catch (error) {
    errors.push({ stage: "SIGTERM", error });
  }

  // Escalation is deliberately independent of the process leader's `close`
  // event. A descendant may ignore TERM, close inherited stdio, and outlive
  // the leader; every requested termination therefore attempts group KILL.
  await delay(killGraceMs);

  try {
    signalOriginalProcessGroup(identity, "SIGKILL", signalOptions);
  } catch (error) {
    errors.push({ stage: "SIGKILL", error });
  }

  try {
    await waitForProcessGroupExit(processGroupId, groupExitTimeoutMs, processGroupExistsImpl);
  } catch (error) {
    errors.push({ stage: "verification", error });
  }

  if (errors.length > 0) throw terminationError(processGroupId, errors);
}

async function handleExec(body = {}, options = {}) {
  const cmd = String(body.command || body.cmd || "echo 'no command'");
  const timeout = normalizePositiveInteger(
    body.timeout,
    DEFAULT_EXEC_TIMEOUT_MS,
    MAX_EXEC_TIMEOUT_MS,
  );
  const killGraceMs = normalizePositiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS, 10000);
  const groupExitTimeoutMs = normalizePositiveInteger(
    options.groupExitTimeoutMs,
    DEFAULT_PROCESS_GROUP_EXIT_TIMEOUT_MS,
    30000,
  );
  const signal = options.signal || null;
  const spawnImpl = options.spawnImpl || spawn;
  const readProcessIdentityImpl = options.readProcessIdentityImpl || readProcessIdentity;
  const signalProcessGroupImpl = options.signalProcessGroupImpl || signalProcessGroup;
  const processGroupExistsImpl = options.processGroupExistsImpl || processGroupExists;

  if (signal?.aborted) {
    return {
      exitCode: 130,
      stdout: "",
      stderr: "Command canceled because the request was closed",
      aborted: true,
    };
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl("/bin/sh", ["-c", cmd], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: 1, stdout: "", stderr: error.message });
      return;
    }

    const processGroupId = child.pid;
    let processGroupIdentity = null;
    let identityCaptureError = null;
    try {
      processGroupIdentity = captureProcessGroupIdentity(processGroupId, readProcessIdentityImpl);
    } catch (error) {
      identityCaptureError = error;
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let terminationReason = null;
    let timeoutTimer = null;
    let childError = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener("abort", abortHandler);
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const outputText = (chunks) => Buffer.concat(chunks).toString("utf8");

    const terminatedResult = (terminationFailure = null) => {
      const stdoutText = outputText(stdout);
      let stderrText = outputText(stderr);
      const extra = {};
      let exitCode = 1;

      if (terminationReason === "aborted") {
        exitCode = 130;
        stderrText ||= "Command canceled because the request was closed";
        extra.aborted = true;
      } else if (terminationReason === "timeout") {
        exitCode = 124;
        stderrText ||= `Command timed out after ${timeout}ms`;
        extra.timedOut = true;
      } else if (terminationReason === "output_limit") {
        stderrText ||= `Command output exceeded ${MAX_EXEC_OUTPUT_BYTES} bytes`;
        extra.outputLimitExceeded = true;
      }

      if (childError && !stderrText) stderrText = childError.message;
      if (terminationFailure) {
        const failureMessage = `Command termination could not be confirmed: ${terminationFailure.message}`;
        stderrText = stderrText ? `${stderrText.trimEnd()}\n${failureMessage}` : failureMessage;
        exitCode = 1;
        extra.terminationFailed = true;
        extra.terminationErrorCode = terminationFailure.code;
      }

      return { exitCode, stdout: stdoutText, stderr: stderrText, ...extra };
    };

    const requestTermination = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      if (timeoutTimer) clearTimeout(timeoutTimer);

      void terminateProcessGroup(processGroupIdentity, {
        identityCaptureError,
        killGraceMs,
        groupExitTimeoutMs,
        readProcessIdentityImpl,
        signalProcessGroupImpl,
        processGroupExistsImpl,
      }).then(
        () => settle(terminatedResult()),
        (error) => settle(terminatedResult(error)),
      );
    };

    const appendOutput = (target, chunk) => {
      if (!chunk) return;
      if (outputBytes >= MAX_EXEC_OUTPUT_BYTES) {
        if (!terminationReason) requestTermination("output_limit");
        return;
      }
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = MAX_EXEC_OUTPUT_BYTES - outputBytes;
      target.push(normalized.subarray(0, remaining));
      outputBytes += Math.min(normalized.length, remaining);
      if (normalized.length > remaining && !terminationReason) {
        requestTermination("output_limit");
      }
    };

    const abortHandler = () => requestTermination("aborted");

    child.stdout?.on("data", (chunk) => appendOutput(stdout, chunk));
    child.stderr?.on("data", (chunk) => appendOutput(stderr, chunk));
    child.once("error", (error) => {
      childError = error;
      if (!terminationReason) {
        settle({ exitCode: 1, stdout: outputText(stdout), stderr: error.message });
      }
    });
    child.once("close", (code, closeSignal) => {
      // Cancellation is settled only by terminateProcessGroup after its
      // mandatory SIGKILL and verification, even if the leader closes first.
      if (terminationReason) return;
      const hasExitCode = Number.isInteger(code);
      const stderrText = outputText(stderr);
      settle({
        // A close event without either an exit code or a terminating signal
        // does not prove that the command completed successfully. Treat that
        // indeterminate state as a failure instead of silently returning 0.
        exitCode: hasExitCode ? code : 1,
        stdout: outputText(stdout),
        stderr:
          stderrText ||
          (!hasExitCode && !closeSignal
            ? "Command exited without an exit code or terminating signal"
            : ""),
      });
    });

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    }

    if (!terminationReason) {
      timeoutTimer = setTimeout(() => requestTermination("timeout"), timeout);
      timeoutTimer.unref?.();
    }
  });
}

module.exports = {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_PROCESS_GROUP_EXIT_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_BYTES,
  captureProcessGroupIdentity,
  handleExec,
  processGroupExists,
  readProcessIdentity,
  signalProcessGroup,
  signalOriginalProcessGroup,
  terminateProcessGroup,
  waitForProcessGroupExit,
};
