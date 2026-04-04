const { reconcileAgentStatus } = require("../agentStatus");

describe("reconcileAgentStatus", () => {
  it("preserves warning when the container is still running", () => {
    expect(reconcileAgentStatus("warning", true)).toBe("warning");
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
