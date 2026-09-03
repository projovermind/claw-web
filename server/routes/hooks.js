import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { HOOK_EVENTS } from '../lib/hook-settings.js';

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
      const { event, matcher, action, command, enabled, async: isAsync, agentIds, timeout } = req.body;
      if (!command || typeof command !== 'string') {
        throw new HttpError(400, 'command is required', 'MISSING_COMMAND');
      }
      if (event !== undefined && !HOOK_EVENTS.includes(event)) {
        throw new HttpError(400, `event must be one of ${HOOK_EVENTS.join(', ')}`, 'INVALID_EVENT');
      }
      const hook = await hooksStore.create({ event, matcher, action, command, enabled, async: isAsync, agentIds, timeout });
      if (eventBus) eventBus.publish('hooks.updated', {});
      res.status(201).json(hook);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      if (req.body?.event !== undefined && !HOOK_EVENTS.includes(req.body.event)) {
        throw new HttpError(400, `event must be one of ${HOOK_EVENTS.join(', ')}`, 'INVALID_EVENT');
      }
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
