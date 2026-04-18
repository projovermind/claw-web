import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url()
});

export function createPushRouter({ pushStore }) {
  const router = Router();

  // GET /api/push/vapid-public-key
  router.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: pushStore.getVapidPublicKey() });
  });

  // POST /api/push/subscribe
  router.post('/subscribe', async (req, res, next) => {
    try {
      const sub = subscribeSchema.parse(req.body);
      await pushStore.addSubscription(sub);
      res.json({ ok: true });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid subscription', 'INVALID_BODY'));
      next(err);
    }
  });

  // DELETE /api/push/subscribe
  router.delete('/subscribe', async (req, res, next) => {
    try {
      const { endpoint } = unsubscribeSchema.parse(req.body);
      await pushStore.removeSubscription(endpoint);
      res.json({ ok: true });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // POST /api/push/activity — 클라이언트가 활성 상태임을 알림
  router.post('/activity', (req, res) => {
    pushStore.touchActivity();
    res.json({ ok: true });
  });

  // POST /api/push/test — 테스트 알림 전송
  router.post('/test', async (req, res, next) => {
    try {
      const title = req.body?.title || 'Claw Web';
      const body = req.body?.body || 'Test notification';
      const result = await pushStore.sendPushToAll(title, body, { skipIdleCheck: true });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
