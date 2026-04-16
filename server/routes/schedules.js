import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Scheduled tasks CRUD.
 *
 * GET    /api/schedules     → list all schedules
 * POST   /api/schedules     → create schedule
 * PATCH  /api/schedules/:id → update (enable/disable, cron, prompt, etc.)
 * DELETE /api/schedules/:id → delete
 */
export function createSchedulesRouter({ scheduler, eventBus }) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ schedules: scheduler.list() });
  });

  router.post('/', async (req, res, next) => {
    try {
      const { name, cron, agentId, prompt, enabled } = req.body;
      if (!cron || typeof cron !== 'string') {
        throw new HttpError(400, 'cron expression is required', 'MISSING_CRON');
      }
      const schedule = await scheduler.create({ name, cron, agentId, prompt, enabled });
      if (eventBus) eventBus.publish('schedules.updated', {});
      res.status(201).json(schedule);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const updated = await scheduler.update(req.params.id, req.body);
      if (!updated) return next(new HttpError(404, 'Schedule not found', 'NOT_FOUND'));
      if (eventBus) eventBus.publish('schedules.updated', {});
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const removed = await scheduler.remove(req.params.id);
      if (!removed) return next(new HttpError(404, 'Schedule not found', 'NOT_FOUND'));
      if (eventBus) eventBus.publish('schedules.updated', {});
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
