import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

/**
 * 메시지 예약 발송 CRUD.
 *
 * GET    /api/scheduled-messages?sessionId=&status=  → 목록
 * GET    /api/scheduled-messages/:id                 → 한 건
 * POST   /api/scheduled-messages                     → 예약 생성
 * PATCH  /api/scheduled-messages/:id                 → 시각/본문 수정 (pending 만)
 * DELETE /api/scheduled-messages/:id                 → 취소 (?purge=1 이면 기록까지 삭제)
 *
 * 응답 봉투는 `{ scheduled }` — 클라이언트 api.ts 가 그 키를 읽는다.
 */
const createSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1).max(50000),
  runAt: z.string().min(1)
}).strict();

const patchSchema = z.object({
  content: z.string().min(1).max(50000).optional(),
  runAt: z.string().min(1).optional()
}).strict();

export function createScheduledMessagesRouter({ scheduledMessagesStore, sessionsStore }) {
  const router = Router();

  // store 는 검증 실패를 평범한 Error 로 던진다 — 400 으로 번역.
  const toHttpError = (err) =>
    err instanceof HttpError || err.name === 'ZodError'
      ? err
      : new HttpError(400, err.message, 'INVALID_SCHEDULED_MESSAGE');

  router.get('/', (req, res) => {
    const { sessionId, status } = req.query;
    res.json({ scheduled: scheduledMessagesStore.list({ sessionId, status }) });
  });

  router.get('/:id', (req, res, next) => {
    const message = scheduledMessagesStore.get(req.params.id);
    if (!message) return next(new HttpError(404, 'Scheduled message not found', 'NOT_FOUND'));
    res.json({ scheduled: message });
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      // 존재하지 않는 세션에 예약을 걸면 만기 때 조용히 failed 로 떨어진다. 지금 막는다.
      if (sessionsStore && !sessionsStore.get(data.sessionId)) {
        throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      }
      const message = await scheduledMessagesStore.create(data);
      res.status(201).json({ scheduled: message });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(toHttpError(err));
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const data = patchSchema.parse(req.body);
      const message = await scheduledMessagesStore.update(req.params.id, data);
      if (!message) throw new HttpError(404, 'Scheduled message not found', 'NOT_FOUND');
      res.json({ scheduled: message });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(toHttpError(err));
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (req.query.purge === '1') {
        const removed = await scheduledMessagesStore.remove(req.params.id);
        if (!removed) throw new HttpError(404, 'Scheduled message not found', 'NOT_FOUND');
        return res.json({ ok: true });
      }
      const message = await scheduledMessagesStore.cancel(req.params.id);
      if (!message) throw new HttpError(404, 'Scheduled message not found', 'NOT_FOUND');
      res.json({ ok: true, scheduled: message });
    } catch (err) {
      next(toHttpError(err));
    }
  });

  return router;
}
