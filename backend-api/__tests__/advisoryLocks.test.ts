// @ts-nocheck
const {
  advisoryLockBusyError,
  advisoryLockClientOptions,
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
    it("sets lock_timeout as a connection option", () => {
      expect(advisoryLockClientOptions(5000)).toBe("-c lock_timeout=5000");
    });

    it("preserves options the connection already carries", () => {
      expect(advisoryLockClientOptions(5000, "-c statement_timeout=1000")).toBe(
        "-c statement_timeout=1000 -c lock_timeout=5000",
      );
    });

    it("clamps absurd values rather than trusting the environment", () => {
      expect(normalizeAdvisoryLockWaitMs("1")).toBe(10);
      expect(normalizeAdvisoryLockWaitMs("99999999")).toBe(120000);
      // A missing or unparseable value must still produce a bound, never zero
      // (which Postgres reads as "wait forever" — the bug being fixed).
      expect(normalizeAdvisoryLockWaitMs(undefined)).toBe(30000);
      expect(normalizeAdvisoryLockWaitMs("not-a-number")).toBe(30000);
      expect(advisoryLockClientOptions(undefined)).toBe("-c lock_timeout=30000");
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
