function shouldPersistReadinessWarning(readiness) {
  return !readiness?.ok;
}

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

async function persistReadinessWarning(db, { agentId, name, host, readiness }) {
  if (!shouldPersistReadinessWarning(readiness)) {
    return null;
  }

  const warningState = buildReadinessWarningState({ agentId, name, host, readiness });

  await db.query(`UPDATE agents SET status = '${warningState.agentStatus}' WHERE id = $1`, [agentId]);
  await db.query(`UPDATE deployments SET status = '${warningState.deploymentStatus}' WHERE agent_id = $1`, [agentId]);
  await db.query(
    "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
    [warningState.event.type, warningState.event.message, JSON.stringify(warningState.event.metadata)]
  );

  return warningState;
}

module.exports = { shouldPersistReadinessWarning, buildReadinessWarningDetail, buildReadinessWarningMetadata, buildReadinessWarningState, persistReadinessWarning };
