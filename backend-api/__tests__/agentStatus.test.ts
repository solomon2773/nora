// @ts-nocheck
const { isGatewayAvailableStatus, reconcileAgentStatus } = require("../agentStatus");

describe("isGatewayAvailableStatus", () => {
  it("allows running and warning states", () => {
    expect(isGatewayAvailableStatus("running")).toBe(true);
    expect(isGatewayAvailableStatus("warning")).toBe(true);
  });

  it("blocks stopped, error, queued, and deploying states", () => {
    expect(isGatewayAvailableStatus("stopped")).toBe(false);
    expect(isGatewayAvailableStatus("error")).toBe(false);
    expect(isGatewayAvailableStatus("queued")).toBe(false);
    expect(isGatewayAvailableStatus("deploying")).toBe(false);
  });
});

describe("reconcileAgentStatus", () => {
  it("self-heals warning to running when the container is live", () => {
    // warning is a point-in-time readiness miss; once the runtime is
    // demonstrably live it must recover like stopped/error do.
    expect(reconcileAgentStatus("warning", true)).toBe("running");
  });

  it("downgrades warning to stopped when the container is no longer running", () => {
    expect(reconcileAgentStatus("warning", false)).toBe("stopped");
  });

  it("promotes stopped and error agents back to running when the container is live", () => {
    expect(reconcileAgentStatus("stopped", true)).toBe("running");
    expect(reconcileAgentStatus("error", true)).toBe("running");
  });

  it("leaves queued and deploying agents untouched", () => {
    expect(reconcileAgentStatus("queued", true)).toBe("queued");
    expect(reconcileAgentStatus("deploying", false)).toBe("deploying");
  });
});
