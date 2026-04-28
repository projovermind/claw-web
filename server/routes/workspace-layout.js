import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Workspace layout sync.
 *
 * GET /api/workspace-layout       → current layout (null if never set)
 * PUT /api/workspace-layout       → replace layout, broadcast to all WS clients
 *                                   (the originating clientId is included so
 *                                    the sender can ignore its own echo)
 */
export function createWorkspaceLayoutRouter({ workspaceLayoutStore, eventBus }) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(workspaceLayoutStore.get() ?? {
      workspaces: null,
      activeWorkspaceId: null,
      updatedAt: null,
      updatedBy: null
    });
  });

  router.put('/', async (req, res, next) => {
    try {
      const { workspaces, activeWorkspaceId, clientId } = req.body ?? {};
      if (!Array.isArray(workspaces) || workspaces.length === 0) {
        throw new HttpError(400, 'workspaces must be a non-empty array', 'BAD_LAYOUT');
      }
      const saved = await workspaceLayoutStore.set({ workspaces, activeWorkspaceId, clientId });
      if (eventBus) {
        eventBus.publish('workspace-layout.updated', {
          workspaces: saved.workspaces,
          activeWorkspaceId: saved.activeWorkspaceId,
          updatedAt: saved.updatedAt,
          clientId: saved.updatedBy
        });
      }
      res.json(saved);
    } catch (err) {
      if (err instanceof HttpError) return next(err);
      next(new HttpError(400, err.message || 'failed to save layout', 'SAVE_FAILED'));
    }
  });

  return router;
}
