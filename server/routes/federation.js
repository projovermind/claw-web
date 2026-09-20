import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { createFederationAuth } from '../middleware/federation-auth.js';

/**
 * 인스턴스 연합 엔드포인트 — 다른 claw-web 인스턴스만 들어온다.
 *
 * **UI 인증(`auth.js`)과 별개의 경로다.** 라우터가 `/api` 인증 미들웨어보다
 * 먼저 마운트되고 자체 미들웨어로만 검증하므로, UI 토큰으로는 401 이 된다.
 */

const delegateSchema = z.object({
  delegationId: z.string().min(1).max(128),
  agent: z.string().min(1).max(64),
  task: z.string().min(1).max(20000),
  tier: z.string().max(32).nullable().optional(),
  originLabel: z.string().max(200).nullable().optional(),
  callbackUrl: z.string().min(1).max(500)
}).strip();

const resultSchema = z.object({
  delegationId: z.string().min(1).max(128),
  status: z.enum(['completed', 'failed', 'abandoned']),
  result: z.string().max(200000).nullable().optional(),
  remoteSessionId: z.string().max(128).nullable().optional(),
  escalate: z.string().max(4000).nullable().optional()
}).strip();

/**
 * @param hooks 지연 배선용 홀더. chat 라우터는 이 라우터보다 나중에 만들어지므로
 *   (인증 미들웨어 앞에 마운트해야 한다) 함수 참조를 요청 시점에 읽는다.
 */
export function createFederationRouter({ instancesStore, hooks }) {
  const router = Router();
  router.use(createFederationAuth({ instancesStore }));

  // origin → remote: 위임 접수. 워커 완료를 기다리지 않고 즉시 응답한다.
  router.post('/delegate', async (req, res) => {
    let body;
    try {
      body = delegateSchema.parse(req.body);
    } catch {
      return res.status(400).json({ accepted: false, error: 'invalid_payload' });
    }
    const accept = hooks?.acceptRemoteDelegation;
    if (!accept) return res.status(503).json({ accepted: false, error: 'not_ready' });
    try {
      const out = await accept({ ...body, originInstance: req.federationOrigin });
      if (!out.accepted) {
        return res.status(out.status ?? 400).json({ accepted: false, error: out.error });
      }
      return res.json({
        accepted: true,
        remoteSessionId: out.remoteSessionId,
        remoteInstance: out.remoteInstance
      });
    } catch (err) {
      logger.error({ err: err.message, origin: req.federationOrigin }, 'federation: 위임 접수 실패');
      return res.status(500).json({ accepted: false, error: 'internal_error' });
    }
  });

  // remote → origin: 결과 콜백. 4xx 는 remote 가 재시도하지 않는다.
  router.post('/result', async (req, res) => {
    let body;
    try {
      body = resultSchema.parse(req.body);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }
    const deliver = hooks?.deliverRemoteResult;
    if (!deliver) return res.status(503).json({ ok: false, error: 'not_ready' });
    try {
      const out = await deliver({
        delegationId: body.delegationId,
        status: body.status,
        result: body.result ?? '',
        remoteSessionId: body.remoteSessionId ?? null,
        escalate: body.escalate ?? null
      });
      if (!out?.ok) return res.status(404).json({ ok: false, error: out?.error ?? 'unknown_delegation' });
      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err: err.message, delegationId: body.delegationId }, 'federation: 결과 회신 처리 실패');
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  return router;
}
