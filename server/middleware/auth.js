import { logger } from '../lib/logger.js';

/**
 * Bearer token middleware — accepts either:
 *  1) A username/password session token issued by /api/auth/login
 *     (when adminUsersStore has at least one user).
 *  2) The legacy single-token `webConfig.auth.token` (master token, treated as admin).
 *
 * Auth is bypassed when:
 *  - webConfig.auth.enabled === false AND adminUsersStore.count() === 0
 *    (i.e. nothing protects the API yet).
 *
 * Whitelisted paths (no auth required even when enabled):
 *  - GET  /api/health
 *  - GET  /api/settings           — UI probes whether auth is required (token is masked in response)
 *  - GET  /api/auth/info          — UI probes whether user-mode login is active
 *  - POST /api/auth/login         — login form
 *
 * On success, sets:
 *  - req._authUser       — public user record { id, username, role, ... } or null for legacy bearer
 *  - req._sessionToken   — the session token (so /logout can revoke it) or null
 *
 * WS handshake auth is in `authorizeWsUpgrade` below.
 */
export function createAuthMiddleware({ webConfig, adminUsersStore, sessionRegistry }) {
  function isWhitelisted(req) {
    if (req.method === 'GET' && req.path === '/health') return true;
    if (req.method === 'GET' && req.path === '/settings') return true;
    if (req.method === 'GET' && req.path === '/auth/info') return true;
    if (req.method === 'POST' && req.path === '/auth/login') return true;
    return false;
  }

  function readToken(req) {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) return m[1].trim();
    // Allow `_token` query param on GET file-serving endpoints (img/href can't set headers).
    if (req.method === 'GET' && typeof req.query._token === 'string') {
      return req.query._token;
    }
    return null;
  }

  return function authMiddleware(req, res, next) {
    req._authUser = null;
    req._sessionToken = null;

    const userCount = adminUsersStore?.count?.() ?? 0;
    const legacyEnabled = !!webConfig.auth?.enabled;
    const guarded = legacyEnabled || userCount > 0;

    if (!guarded) return next();
    if (isWhitelisted(req)) return next();

    const provided = readToken(req);
    if (!provided) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }

    // 1) Try session token (username/password login).
    if (sessionRegistry) {
      const session = sessionRegistry.lookup(provided);
      if (session) {
        const user = adminUsersStore?.getById?.(session.userId);
        if (user) {
          req._authUser = user;
          req._sessionToken = provided;
          return next();
        }
        // Stale session — user was deleted.
        sessionRegistry.revoke(provided);
      }
    }

    // 2) Try legacy master bearer token.
    if (legacyEnabled) {
      const expected = webConfig.auth?.token;
      if (!expected) {
        logger.warn({ path: req.path }, 'auth: enabled but no token configured');
        return res.status(503).json({
          error: 'Auth enabled but no token configured.',
          code: 'AUTH_NOT_CONFIGURED'
        });
      }
      if (provided === expected) {
        // Legacy bearer = implicit admin, no user record.
        return next();
      }
    }

    logger.warn({ path: req.path }, 'auth: invalid token');
    return res.status(401).json({ error: 'Invalid token', code: 'AUTH_INVALID' });
  };
}

/**
 * WebSocket handshake auth. Returns true if the request is allowed.
 * Accepts both session tokens and the legacy master token via `?token=...`.
 */
export function authorizeWsUpgrade(req, webConfig, { adminUsersStore, sessionRegistry } = {}) {
  const userCount = adminUsersStore?.count?.() ?? 0;
  const legacyEnabled = !!webConfig.auth?.enabled;
  const guarded = legacyEnabled || userCount > 0;
  if (!guarded) return true;

  let provided;
  try {
    const url = new URL(req.url, 'http://localhost');
    provided = url.searchParams.get('token');
  } catch {
    return false;
  }
  if (!provided) return false;

  if (sessionRegistry?.lookup?.(provided)) return true;
  if (legacyEnabled && webConfig.auth?.token && provided === webConfig.auth.token) return true;
  return false;
}
