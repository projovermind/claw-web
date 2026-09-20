import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { checkInstanceHealth } from '../lib/federation-client.js';

/**
 * 인스턴스 레지스트리 관리 API. 여기는 **기존 UI 인증(`auth.js`)** 을 그대로 쓴다
 * — 연합 엔드포인트(`/api/federation`)와 달리 사람이 쓰는 화면의 뒷면이다.
 */

const baseUrlSchema = z.string().url().max(300);

const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'id must be alphanumeric / - / _'),
  label: z.string().max(120).optional(),
  baseUrl: baseUrlSchema,
  token: z.string().min(1).max(500).optional(),
  inboundToken: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
  platform: z.string().max(32).optional()
}).strict();

const patchSchema = z.object({
  label: z.string().max(120).optional(),
  baseUrl: baseUrlSchema.optional(),
  token: z.string().max(500).nullable().optional(),
  inboundToken: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  platform: z.string().max(32).nullable().optional()
}).strict();

const selfSchema = z.object({
  selfId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i).optional(),
  selfPublicUrl: baseUrlSchema.nullable().optional()
}).strict();

export function createInstancesRouter({ instancesStore, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(instancesStore.getPublic());
  });

  // selfId / selfPublicUrl — 콜백 주소의 베이스. 인스턴스 생성보다 먼저 필요하다.
  router.patch('/_self', async (req, res, next) => {
    try {
      const patch = selfSchema.parse(req.body);
      const out = await instancesStore.setSelf(patch);
      eventBus?.publish('instances.updated', { selfId: out.selfId });
      res.json(out);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // 인바운드 토큰은 **origin 이 스스로를 부르는 id** 로 키가 잡힌다. 보통은
  // 상대 인스턴스 id 와 같아서 POST/PATCH 의 inboundToken 으로 충분하지만,
  // 루프백(자기 자신을 인스턴스로 등록)처럼 둘이 갈리는 경우가 있어 별도 경로를 둔다.
  // `/:id` 보다 먼저 선언해야 한다 — 뒤에 두면 id='inbound-tokens' 로 먹힌다.
  router.get('/inbound-tokens', (req, res) => {
    res.json({ origins: Object.keys(instancesStore.getRaw().inboundTokens ?? {}) });
  });

  router.put('/inbound-tokens/:originId', async (req, res, next) => {
    try {
      const { token } = z.object({ token: z.string().min(1).max(500) }).strict().parse(req.body);
      await instancesStore.setInboundToken(req.params.originId, token);
      eventBus?.publish('instances.updated', { originId: req.params.originId });
      res.json({ originId: req.params.originId, tokenSet: true });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/inbound-tokens/:originId', async (req, res, next) => {
    try {
      await instancesStore.setInboundToken(req.params.originId, null);
      eventBus?.publish('instances.updated', { originId: req.params.originId });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { id, ...data } = createSchema.parse(req.body);
      if (id === instancesStore.getSelfId() && !data.baseUrl) {
        throw new HttpError(400, 'selfId 와 같은 id 는 baseUrl 이 필요합니다', 'INVALID_BODY');
      }
      const created = await instancesStore.createInstance(id, data);
      eventBus?.publish('instances.updated', { id });
      res.status(201).json(created);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const patch = patchSchema.parse(req.body);
      const updated = await instancesStore.updateInstance(req.params.id, patch);
      eventBus?.publish('instances.updated', { id: req.params.id });
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid patch', 'INVALID_PATCH'));
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await instancesStore.deleteInstance(req.params.id);
      eventBus?.publish('instances.updated', { id: req.params.id });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  // 즉시 헬스체크 — 원격 /api/health 의 version 을 그대로 실어 돌려준다.
  router.post('/:id/health', async (req, res, next) => {
    try {
      const inst = instancesStore.getInstance(req.params.id);
      if (!inst) return next(new HttpError(404, `Instance ${req.params.id} not found`, 'NOT_FOUND'));
      const health = await checkInstanceHealth(inst.baseUrl);
      await instancesStore.recordHealth(req.params.id, health);
      eventBus?.publish('instances.health', { id: req.params.id, health });
      res.json({ id: req.params.id, health });
    } catch (err) { next(err); }
  });

  return router;
}
