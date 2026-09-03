import { Router } from 'express';
import { getAppVersion } from '../lib/app-version.js';

export function createHealthRouter({ healthCheck }) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      const s = await healthCheck.check();
      res.json({ ...s, version: getAppVersion() });
    } catch (err) { next(err); }
  });
  return router;
}
