'use strict';

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Wraps an async Express handler so rejected promises reach the error handler (Express 4). */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: 'A record with that value already exists' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { HttpError, asyncHandler, errorHandler };
