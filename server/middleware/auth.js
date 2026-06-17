import { timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';

/** 길이가 달라도 타이밍 차이가 새지 않는 토큰 비교 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Brute-force guard ──
// 토큰이 짧은 PIN 형태일 수 있고 서버가 인터넷(cloudflared 터널)에 노출되므로
// IP당 연속 실패를 추적해 잠금. 성공 시 해당 IP 기록 즉시 해제.
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;
const failures = new Map(); // ip → { count, lockedUntil }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (
    req.headers['cf-connecting-ip'] ||
    (typeof xff === 'string' ? xff.split(',')[0].trim() : null) ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function isLocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
  if (f.lockedUntil && Date.now() >= f.lockedUntil) failures.delete(ip);
  return false;
}

function recordFailure(ip) {
  // 스푸핑된 헤더로 맵이 무한히 크지 않도록 주기적 lazy purge
  if (failures.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of failures) {
      if (!v.lockedUntil || now >= v.lockedUntil) failures.delete(k);
    }
  }
  const f = failures.get(ip) ?? { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) {
    f.lockedUntil = Date.now() + LOCK_MS;
    logger.warn({ ip, count: f.count }, 'auth: too many failures — locked out 15m');
  }
  failures.set(ip, f);
}

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

    const ip = clientIp(req);
    if (isLocked(ip)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try later.', code: 'AUTH_LOCKED' });
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
    if (!safeEqual(provided, expected)) {
      recordFailure(ip);
      logger.warn({ path: req.path, ip }, 'auth: bad token');
      return res.status(401).json({ error: 'Invalid token', code: 'AUTH_INVALID' });
    }

    failures.delete(ip);
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
  const ip = clientIp(req);
  if (isLocked(ip)) return false;
  try {
    const url = new URL(req.url, 'http://localhost');
    const provided = url.searchParams.get('token');
    if (provided !== null && safeEqual(provided, expected)) {
      failures.delete(ip);
      return true;
    }
    recordFailure(ip);
    return false;
  } catch {
    return false;
  }
}
