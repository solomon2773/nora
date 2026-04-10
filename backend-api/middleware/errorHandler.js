const crypto = require('crypto');

/**
 * Structured application error with status code and error code.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'AppError';
  }
}

/**
 * Middleware: attach a correlation ID to every request.
 * Clients can pass x-correlation-id to trace across services.
 */
function correlationId(req, res, next) {
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}

/**
 * Wrap async route handlers so rejected promises are forwarded to Express error handler.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Central error handler — must be registered LAST (after all routes).
 * - Logs full stack for 500s with correlation ID
 * - Hides internal error details from clients
 * - Preserves explicit status codes from AppError
 */
function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const cid = req.correlationId || 'unknown';

  console.error(`[${cid}] ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  if (status >= 500) console.error(err.stack);

  res.locals.auditError = {
    name: err.name || 'Error',
    message: err.message,
    code,
    statusCode: status,
    stack: err.stack,
  };

  if (res.headersSent) return;

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
    code,
    correlationId: cid,
  });
}

module.exports = { AppError, correlationId, asyncHandler, errorHandler };
