import { logger } from '../lib/logger.js';

/**
 * Bearer token middleware.
 *
 * - Reads live from webConfig (so settings toggles take effect without restart).
 * - If auth.enabled === false → pass through everything.
 * - If enabled → require `Authorization: Bearer <token>` matching webConfig.auth.token.
 *
 * Exempt paths (always allowed, even with auth on):
 * - GET /api/health — lets probes run without credentials
 * - GET /api/settings — lets clients discover that auth is required (token is already masked
 *   to '***' in the response, so no secret leaks)
 *
 * WS is authenticated separately in ws/hub.js via a `?token=...` query param on the handshake.
 */
export function createAuthMiddleware({ webConfig }) {
  return function authMiddleware(req, res, next) {
    // If auth is off, everything passes.
    if (!webConfig.auth?.enabled) return next();

    // Allowlist
    if (req.method === 'GET' && req.path === '/health') return next();
    if (req.method === 'GET' && req.path === '/settings') return next();

    const expected = webConfig.auth.token;
    if (!expected) {
      // Auth enabled but no token set — lock everything down.
      logger.warn({ path: req.path }, 'auth: enabled but no token configured');
      return res.status(503).json({
        error: 'Auth enabled but no token configured.',
        code: 'AUTH_NOT_CONFIGURED'
      });
    }

    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    // Also accept token as query param `_token` — needed for <img src> and
    // <a href> which can't set Authorization headers. Only for GET requests
    // to file-serving endpoints.
    const queryToken = req.method === 'GET' ? (req.query._token ?? null) : null;
    const provided = m?.[1]?.trim() ?? (typeof queryToken === 'string' ? queryToken : null);

    if (!provided) {
      return res.status(401).json({ error: 'Missing Bearer token', code: 'AUTH_REQUIRED' });
    }
    if (provided !== expected) {
      logger.warn({ path: req.path }, 'auth: bad token');
      return res.status(401).json({ error: 'Invalid token', code: 'AUTH_INVALID' });
    }

    return next();
  };
}

/**
 * WebSocket handshake auth. Returns true if the request is allowed.
 */
export function authorizeWsUpgrade(req, webConfig) {
  if (!webConfig.auth?.enabled) return true;
  const expected = webConfig.auth.token;
  if (!expected) return false;
  try {
    const url = new URL(req.url, 'http://localhost');
    const provided = url.searchParams.get('token');
    return provided === expected;
  } catch {
    return false;
  }
}
