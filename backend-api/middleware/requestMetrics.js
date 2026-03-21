const { recordApiMetric } = require('../metrics');

/**
 * Middleware that records request latency and status for API performance tracking.
 * Metrics are buffered in-memory and flushed to DB every 60s by the metrics module.
 */
function requestMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // Skip health checks and static assets
    if (req.originalUrl === '/health') return;

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    recordApiMetric({
      method: req.method,
      path: req.route?.path || req.originalUrl,
      status: res.statusCode,
      durationMs,
      correlationId: req.correlationId,
    });
  });
  next();
}

module.exports = requestMetrics;
