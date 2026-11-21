// @ts-nocheck
const {
  advisoryLockBusyError,
  connectAdvisoryLockSession,
  isAdvisoryLockTimeout,
  normalizeAdvisoryLockWaitMs,
  startAdvisoryLockHoldWatchdog,
} = require("../lib/advisoryLocks");

// #406: session-level advisory locks got stranded on idle Postgres sessions.
// Deployments retried "already being provisioned by another worker" until they
// DLQ'd and POST /api/llm-providers hung past the proxy and 504'd, while nothing
// was actually provisioning. Both halves are guarded here: waiters must not
// block forever, and holders must not hold forever.
describe("advisory lock guards (#406)", () => {
  describe("bounded waits", () => {
    function fakeLockClient({ setConfigError = null } = {}) {
      return {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(() =>
          setConfigError ? Promise.reject(setConfigError) : Promise.resolve({ rows: [] }),
        ),
        end: jest.fn().mockResolvedValue(undefined),
      };
    }

    it("bounds lock waits with a session-scoped set_config after connect", async () => {
      // Session-scoped (is_local = false) and issued as a plain query, never a
      // `-c lock_timeout=` startup parameter: pooled Postgres endpoints reject
      // unknown startup parameters outright, which refused the connection and
      // silently broke provider writes and deploy finalization (#453).
      const client = fakeLockClient();
      await connectAdvisoryLockSession(client, 5000);

      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith("SELECT set_config('lock_timeout', $1, false)", [
        "5000ms",
      ]);
      expect(client.end).not.toHaveBeenCalled();
    });

    it("closes the session and says what failed when the bound cannot be applied", async () => {
      // An unbounded lock session would wait forever behind a stuck holder —
      // refuse to hand it to the caller, and don't leak the connection.
      const client = fakeLockClient({ setConfigError: new Error("permission denied") });

      await expect(connectAdvisoryLockSession(client, 5000)).rejects.toThrow(
        "Could not bound lock_timeout on an advisory-lock session: permission denied",
      );
      expect(client.end).toHaveBeenCalledTimes(1);
    });

    it("leaves the client untouched when connect itself fails", async () => {
      const client = fakeLockClient();
      client.connect.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(connectAdvisoryLockSession(client, 5000)).rejects.toThrow("ECONNREFUSED");
      expect(client.query).not.toHaveBeenCalled();
      expect(client.end).not.toHaveBeenCalled();
    });

    it("clamps absurd values rather than trusting the environment", async () => {
      expect(normalizeAdvisoryLockWaitMs("1")).toBe(10);
      expect(normalizeAdvisoryLockWaitMs("99999999")).toBe(120000);
      // A missing or unparseable value must still produce a bound, never zero
      // (which Postgres reads as "wait forever" — the bug being fixed).
      expect(normalizeAdvisoryLockWaitMs(undefined)).toBe(30000);
      expect(normalizeAdvisoryLockWaitMs("not-a-number")).toBe(30000);

      const client = fakeLockClient();
      await connectAdvisoryLockSession(client, undefined);
      expect(client.query).toHaveBeenCalledWith("SELECT set_config('lock_timeout', $1, false)", [
        "30000ms",
      ]);
    });

    it("recognises Postgres refusing to keep waiting", () => {
      // 55P03 is lock_timeout; 57014 is statement_timeout/cancel and must not
      // be mistaken for it.
      expect(isAdvisoryLockTimeout({ code: "55P03" })).toBe(true);
      expect(isAdvisoryLockTimeout({ code: "57014" })).toBe(false);
      expect(isAdvisoryLockTimeout(new Error("boom"))).toBe(false);
      expect(isAdvisoryLockTimeout(null)).toBe(false);
    });

    it("surfaces a retryable conflict rather than a server error", () => {
      const error = advisoryLockBusyError("busy", { code: "PROVIDER_MUTATION_LOCK_BUSY" });
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("PROVIDER_MUTATION_LOCK_BUSY");
    });
  });

  describe("bounded holds", () => {
    it("ends the session when the hold budget is exceeded", async () => {
      // Ending the connection is what frees the lock: Postgres drops
      // session-level advisory locks when the session goes away.
      const client = { end: jest.fn().mockResolvedValue(undefined) };
      const onTimeout = jest.fn();
      startAdvisoryLockHoldWatchdog(client, { maxHoldMs: 10, onTimeout });

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(client.end).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(10);
    });

    it("does not touch the session when the work finishes in time", async () => {
      const client = { end: jest.fn().mockResolvedValue(undefined) };
      const cancel = startAdvisoryLockHoldWatchdog(client, { maxHoldMs: 50 });
      cancel();

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(client.end).not.toHaveBeenCalled();
    });

    it("stays inert when no budget is configured", async () => {
      const client = { end: jest.fn().mockResolvedValue(undefined) };
      startAdvisoryLockHoldWatchdog(client, { maxHoldMs: 0 });
      startAdvisoryLockHoldWatchdog(client, {});

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(client.end).not.toHaveBeenCalled();
    });

    it("still releases when the reporting hook throws", async () => {
      // A logging failure must never leave the lock held.
      const client = { end: jest.fn().mockResolvedValue(undefined) };
      startAdvisoryLockHoldWatchdog(client, {
        maxHoldMs: 10,
        onTimeout: () => {
          throw new Error("logger exploded");
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(client.end).toHaveBeenCalledTimes(1);
    });

    it("swallows a failure to end the session", async () => {
      const client = { end: jest.fn().mockRejectedValue(new Error("already closed")) };
      startAdvisoryLockHoldWatchdog(client, { maxHoldMs: 10 });

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(client.end).toHaveBeenCalledTimes(1);
    });
  });
});
