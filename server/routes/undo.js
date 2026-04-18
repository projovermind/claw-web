import { Router } from 'express';
import { popUndo, peekUndo, getStack } from '../lib/undo-store.js';
import { HttpError } from '../middleware/error-handler.js';

export function createUndoRouter({ configStore, metadataStore, eventBus }) {
  const router = Router();

  // GET /api/undo — 현재 스택 미리보기 (실행 전 확인용)
  router.get('/', (req, res) => {
    res.json({ stack: getStack() });
  });

  // POST /api/undo — 마지막 변경 복원
  router.post('/', async (req, res, next) => {
    try {
      const entry = popUndo();
      if (!entry) {
        return next(new HttpError(404, 'Nothing to undo', 'UNDO_EMPTY'));
      }

      const { agentId, configBefore, metaBefore } = entry;

      if (!configStore.getAgent(agentId)) {
        return next(new HttpError(404, `Agent ${agentId} not found`, 'AGENT_NOT_FOUND'));
      }

      // configBefore에 있는 필드만 복원 (snapshot에 포함된 것만)
      if (configBefore && Object.keys(configBefore).length > 0) {
        await configStore.updateAgent(agentId, configBefore);
      }
      if (metaBefore && Object.keys(metaBefore).length > 0 && metadataStore) {
        await metadataStore.updateAgent(agentId, metaBefore);
      }

      if (eventBus) {
        eventBus.publish('agent.updated', { agentId, undo: true, undoId: entry.id });
      }

      const restoredConfig = configStore.getAgent(agentId);
      const restoredMeta = metadataStore?.getAgent(agentId) ?? {};
      const restored = { id: agentId, ...restoredConfig, ...restoredMeta };

      res.json({
        undone: entry,
        agent: restored,
        remaining: peekUndo() ? true : false
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
