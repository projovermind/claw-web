import { logger } from '../lib/logger.js';

export function errorHandler(err, req, res, next) {
  const status = err.status ?? err.statusCode ?? 500;
  const code = err.code ?? 'INTERNAL_ERROR';
  if (status >= 500) logger.error({ err, path: req.path }, 'request error');
  res.status(status).json({ error: err.message ?? 'Internal error', code });
}

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
