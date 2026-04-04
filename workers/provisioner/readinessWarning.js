function buildReadinessWarningDetail(readiness) {
  const problems = [];

  if (readiness?.runtime && !readiness.runtime.ok) {
    problems.push(
      `runtime unavailable at ${readiness.runtime.url} (${readiness.runtime.error || readiness.runtime.status || 'unreachable'})`
    );
  }

  if (readiness?.gateway && !readiness.gateway.ok) {
    problems.push(
      `gateway unavailable at ${readiness.gateway.url} (${readiness.gateway.error || readiness.gateway.status || 'unreachable'})`
    );
  }

  return problems.join('; ') || 'readiness checks failed';
}

function buildReadinessWarningMetadata({ agentId, host, readiness }) {
  return {
    agentId,
    host,
    detail: buildReadinessWarningDetail(readiness),
    readiness,
  };
}

function buildReadinessWarningState({ agentId, name, host, readiness }) {
  const metadata = buildReadinessWarningMetadata({ agentId, host, readiness });
  return {
    agentStatus: 'warning',
    deploymentStatus: 'warning',
    event: {
      type: 'agent_runtime_warning',
      message: `Agent "${name}" deployed with readiness warning: ${metadata.detail}`,
      metadata,
    },
  };
}

module.exports = { buildReadinessWarningDetail, buildReadinessWarningMetadata, buildReadinessWarningState };
