import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { normalizeViewId } from '../lib/workspace-layout-store.js';

/**
 * Workspace layout sync (창별 분리 — viewId).
 *
 * GET /api/workspace-layout?viewId=  → 해당 뷰의 레이아웃. 뷰가 없으면 빈
 *                                      결과(seeded:false) 를 내려준다.
 * PUT /api/workspace-layout          → body.viewId 뷰 교체, 전 WS 클라이언트에
 *                                      브로드캐스트 (viewId·clientId 포함 —
 *                                      수신 측이 자기 창인지 판별)
 */
export function createWorkspaceLayoutRouter({ workspaceLayoutStore, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    const layout = workspaceLayoutStore.get(req.query.viewId);
    res.json(layout ?? {
      viewId: normalizeViewId(req.query.viewId),
      seeded: false,
      workspaces: null,
      activeWorkspaceId: null,
      updatedAt: null,
      updatedBy: null
    });
  });

  router.put('/', async (req, res, next) => {
    try {
      const { viewId, workspaces, activeWorkspaceId, clientId } = req.body ?? {};
      if (!Array.isArray(workspaces) || workspaces.length === 0) {
        throw new HttpError(400, 'workspaces must be a non-empty array', 'BAD_LAYOUT');
      }
      const saved = await workspaceLayoutStore.set({ viewId, workspaces, activeWorkspaceId, clientId });
      if (eventBus) {
        eventBus.publish('workspace-layout.updated', {
          viewId: saved.viewId,
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
