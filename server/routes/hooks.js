import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Hooks CRUD routes.
 *
 * GET    /api/hooks     → list all hooks
 * POST   /api/hooks     → create hook
 * PATCH  /api/hooks/:id → update
 * DELETE /api/hooks/:id → delete
 */
export function createHooksRouter({ hooksStore, eventBus }) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ hooks: hooksStore.list() });
  });

  router.post('/', async (req, res, next) => {
    try {
      const { event, matcher, action, command, enabled } = req.body;
      if (!command || typeof command !== 'string') {
        throw new HttpError(400, 'command is required', 'MISSING_COMMAND');
      }
      const hook = await hooksStore.create({ event, matcher, action, command, enabled });
      if (eventBus) eventBus.publish('hooks.updated', {});
      res.status(201).json(hook);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const updated = await hooksStore.update(req.params.id, req.body);
      if (!updated) return next(new HttpError(404, 'Hook not found', 'NOT_FOUND'));
      if (eventBus) eventBus.publish('hooks.updated', {});
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const removed = await hooksStore.remove(req.params.id);
      if (!removed) return next(new HttpError(404, 'Hook not found', 'NOT_FOUND'));
      if (eventBus) eventBus.publish('hooks.updated', {});
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
