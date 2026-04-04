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

module.exports = { buildReadinessWarningDetail };
