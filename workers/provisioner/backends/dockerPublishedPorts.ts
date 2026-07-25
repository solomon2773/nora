// @ts-nocheck

const DEFAULT_DOCKER_PORT_BIND_RETRIES = 3;

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function collectOccupiedDockerPublishedPorts(containers = [], { agentId } = {}) {
  const ignoredAgentId = agentId == null ? "" : String(agentId);
  const occupied = new Set();

  for (const container of Array.isArray(containers) ? containers : []) {
    if (
      ignoredAgentId &&
      String(container?.Labels?.["openclaw.agent.id"] || "") === ignoredAgentId
    ) {
      continue;
    }
    for (const binding of Array.isArray(container?.Ports) ? container.Ports : []) {
      const port = normalizePort(binding?.PublicPort);
      if (port) occupied.add(port);
    }
  }

  return occupied;
}

// Docker's running-container summary is the cheapest host-aware view available
// to the provisioner container. It catches ports held by other Docker workloads;
// non-Docker listeners and races are handled by the bounded start retry below.
async function getOccupiedDockerPublishedPorts(provisioner, { agentId } = {}) {
  if (!provisioner?.docker || typeof provisioner.docker.listContainers !== "function") {
    return new Set();
  }

  try {
    const containers = await provisioner.docker.listContainers({ all: false });
    return collectOccupiedDockerPublishedPorts(containers, { agentId });
  } catch (error) {
    console.warn(
      `[provisioner] Could not inspect Docker published ports; relying on bind retry: ${error.message}`,
    );
    return new Set();
  }
}

function isDockerPortBindConflict(error) {
  const text = [error?.message, error?.reason, error?.json?.message, error?.cause?.message]
    .filter(Boolean)
    .join(" ");
  return /port is already allocated|address already in use|failed to bind host port|bind for .* failed/i.test(
    text,
  );
}

async function createWithDockerPortRetry({
  create,
  initialPort,
  reallocate,
  getOccupiedPorts,
  maxRetries = DEFAULT_DOCKER_PORT_BIND_RETRIES,
  onRetry,
} = {}) {
  if (typeof create !== "function") throw new Error("create callback is required");
  if (typeof reallocate !== "function") throw new Error("reallocate callback is required");

  const retryLimit = Math.max(0, Math.min(10, Number.parseInt(maxRetries, 10) || 0));
  const rejectedPorts = new Set();
  let currentPort = normalizePort(initialPort);

  for (let retry = 0; ; retry++) {
    try {
      return await create(currentPort);
    } catch (error) {
      if (!isDockerPortBindConflict(error) || retry >= retryLimit) throw error;

      if (currentPort) rejectedPorts.add(currentPort);
      const occupied =
        typeof getOccupiedPorts === "function" ? await getOccupiedPorts() : new Set();
      for (const port of occupied instanceof Set ? occupied : occupied || []) {
        const normalized = normalizePort(port);
        if (normalized) rejectedPorts.add(normalized);
      }

      const nextPort = normalizePort(
        await reallocate({
          previousPort: currentPort,
          unavailablePorts: [...rejectedPorts],
        }),
      );
      if (!nextPort) throw new Error("Docker port retry did not receive a valid replacement port");

      if (typeof onRetry === "function") {
        onRetry({
          retry: retry + 1,
          previousPort: currentPort,
          nextPort,
          error,
        });
      }
      currentPort = nextPort;
    }
  }
}

module.exports = {
  DEFAULT_DOCKER_PORT_BIND_RETRIES,
  collectOccupiedDockerPublishedPorts,
  getOccupiedDockerPublishedPorts,
  isDockerPortBindConflict,
  createWithDockerPortRetry,
};
