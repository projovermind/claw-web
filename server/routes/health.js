import { Router } from 'express';

export function createHealthRouter({ healthCheck }) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      const s = await healthCheck.check();
      res.json(s);
    } catch (err) { next(err); }
  });
  return router;
}
