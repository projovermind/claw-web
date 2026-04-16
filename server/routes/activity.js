import { Router } from 'express';

export function createActivityRouter({ activityLog }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
      const entries = await activityLog.readLast(limit);
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
