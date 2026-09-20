import { logger } from '../lib/logger.js';

/**
 * 연합 전용 인증. `auth.js` 와 **완전히 별개의 경로**다 —
 * UI 토큰(`930214`)으로는 여기를 통과할 수 없고, 반대로 연합 토큰으로
 * 일반 API 를 호출할 수도 없다.
 *
 * 검증 조합: `Authorization: Bearer <토큰>` + `X-Claw-Origin: <origin id>`.
 * 둘 중 하나라도 안 맞으면 401. 검증에 성공하면 `req.federationOrigin` 에
 * origin id 를 남긴다.
 */
export function createFederationAuth({ instancesStore }) {
  return function federationAuth(req, res, next) {
    if (!instancesStore) {
      return res.status(503).json({ accepted: false, error: 'federation_unconfigured' });
    }
    const origin = req.headers['x-claw-origin'];
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const token = m?.[1]?.trim() ?? null;

    if (typeof origin !== 'string' || !origin.trim() || !token) {
      return res.status(401).json({ accepted: false, error: 'unauthorized' });
    }
    if (!instancesStore.verifyInbound(origin.trim(), token)) {
      logger.warn({ origin, path: req.path }, 'federation: 자격 검증 실패');
      return res.status(401).json({ accepted: false, error: 'unauthorized' });
    }
    req.federationOrigin = origin.trim();
    return next();
  };
}
