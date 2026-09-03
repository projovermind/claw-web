import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { deviceCreateSchema, deviceUpdateSchema } from '../schemas/device.js';

const PING_TIMEOUT_MS = 4000;

function zodError(err, fallback) {
  const first = err.issues?.[0];
  return first ? `${first.path.join('.') || 'field'}: ${first.message}` : fallback;
}

export function createDevicesRouter({ devicesStore, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ devices: devicesStore.getAll() });
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = deviceCreateSchema.parse(req.body);
      const created = await devicesStore.create(data);
      if (eventBus) eventBus.publish('device.created', { device: created });
      res.status(201).json(created);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, zodError(err, 'Invalid device'), 'INVALID_DEVICE'));
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const data = deviceUpdateSchema.parse(req.body);
      if (!devicesStore.getById(req.params.id)) {
        throw new HttpError(404, `Device ${req.params.id} not found`, 'DEVICE_NOT_FOUND');
      }
      const updated = await devicesStore.update(req.params.id, data);
      if (eventBus) eventBus.publish('device.updated', { device: updated });
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, zodError(err, 'Invalid patch'), 'INVALID_PATCH'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!devicesStore.getById(req.params.id)) {
        throw new HttpError(404, `Device ${req.params.id} not found`, 'DEVICE_NOT_FOUND');
      }
      await devicesStore.remove(req.params.id);
      if (eventBus) eventBus.publish('device.deleted', { id: req.params.id });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // 브라우저는 다른 기기의 /api/health 를 직접 못 읽는다 — CORS 허용 origin 이 개발 서버뿐이라
  // 크로스오리진 응답이 막힌다. 그래서 서버가 대신 찔러 결과만 넘긴다.
  router.get('/:id/ping', async (req, res, next) => {
    try {
      const device = devicesStore.getById(req.params.id);
      if (!device) throw new HttpError(404, `Device ${req.params.id} not found`, 'DEVICE_NOT_FOUND');
      const started = Date.now();
      try {
        const r = await fetch(new URL('/api/health', device.url), {
          signal: AbortSignal.timeout(PING_TIMEOUT_MS)
        });
        const latencyMs = Date.now() - started;
        if (!r.ok) return res.json({ online: false, latencyMs, error: `HTTP ${r.status}` });
        res.json({ online: true, latencyMs, health: await r.json() });
      } catch (err) {
        res.json({
          online: false,
          latencyMs: Date.now() - started,
          error: err.name === 'TimeoutError' ? 'timeout' : err.message
        });
      }
    } catch (err) { next(err); }
  });

  return router;
}
