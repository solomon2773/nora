function isGatewayAvailableStatus(status) {
  return ["running", "warning"].includes(status);
}

function reconcileAgentStatus(currentStatus, liveRunning) {
  if (currentStatus === "queued" || currentStatus === "deploying") {
    return currentStatus;
  }

  if (liveRunning) {
    if (currentStatus === "warning") return "warning";
    if (currentStatus === "stopped" || currentStatus === "error") return "running";
    return currentStatus;
  }

  if (["running", "warning", "error"].includes(currentStatus)) {
    return "stopped";
  }

  return currentStatus;
}

module.exports = { isGatewayAvailableStatus, reconcileAgentStatus };
