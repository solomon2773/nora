// @ts-nocheck
function isGatewayAvailableStatus(status) {
  return ["running", "warning"].includes(status);
}

/**
 * Reconcile a stored agent status with whether its runtime is currently live,
 * while preserving deployment states that are still in progress.
 *
 * @param {string} currentStatus - Status currently stored for the agent.
 * @param {boolean} liveRunning - Whether the runtime reports itself as running.
 * @returns {string} Status Nora should persist after reconciliation.
 */
function reconcileAgentStatus(currentStatus, liveRunning) {
  if (currentStatus === "queued" || currentStatus === "deploying") {
    return currentStatus;
  }

  if (liveRunning) {
    // warning is a point-in-time readiness miss (deploy probe timed out) —
    // once the runtime is demonstrably live it must self-heal, same as
    // stopped/error below. Leaving it sticky meant every slow cold boot wore
    // a permanent false "warning" until a manual stop/start.
    if (currentStatus === "warning") return "running";
    if (currentStatus === "stopped" || currentStatus === "error") return "running";
    return currentStatus;
  }

  if (["running", "warning", "error"].includes(currentStatus)) {
    return "stopped";
  }

  return currentStatus;
}

module.exports = { isGatewayAvailableStatus, reconcileAgentStatus };
