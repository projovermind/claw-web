import { Router } from 'express';
import { getAppVersion } from '../lib/app-version.js';

export function createHealthRouter({ healthCheck }) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      const s = await healthCheck.check();
      // `federation: true` 는 연합 엔드포인트가 있다는 선언이다. 다른 인스턴스는
      // 이 값을(없으면 version 을) 보고 위임을 보낼지 정한다 — 연합이 없는
      // 구버전에 발주해 놓고 영영 회신을 기다리는 일이 없어야 한다.
      res.json({ ...s, version: getAppVersion(), federation: true });
    } catch (err) { next(err); }
  });
  return router;
}
