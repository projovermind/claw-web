import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../lib/logger.js';

/**
 * Permission-prompt approval router.
 *
 * Two endpoints:
 *  - POST /internal/approval/request
 *      (called by the MCP subprocess via loopback HTTP)
 *      body: { sessionId, toolName, input, toolUseId? }
 *      blocks until broker resolves → returns decision JSON
 *
 *  - POST /api/chat/:sessionId/approval/:reqId
 *      (called by the authenticated user via the modal)
 *      body: { behavior: "allow"|"deny", updatedInput?, message?, remember?: boolean }
 *      resolves the pending promise. If remember=true, appends toolName to the
 *      agent's allowedTools list.
 */
export function createMcpApprovalRouter({ approvalBroker, eventBus, bridgeToken, sessionsStore, configStore, metadataStore, pushStore }) {
  const router = Router();

  /** 도구 입력을 알림 본문에 넣을 한 줄로 압축 (80자). */
  function summarizeInput(input) {
    if (input == null) return '';
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    return raw.replace(/\s+/g, ' ').slice(0, 80);
  }

  // ── Internal endpoint (no user auth; bridge-token + loopback only) ──
  router.post('/internal/approval/request', async (req, res, next) => {
    try {
      // Loopback-only. Trust proxy is NOT enabled for this app, so req.ip
      // reflects the actual TCP peer.
      const ip = req.ip || req.socket?.remoteAddress || '';
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLoopback) {
        throw new HttpError(403, 'internal endpoint — loopback only', 'FORBIDDEN_REMOTE');
      }
      const token = req.header('X-Claw-Bridge-Token');
      if (!token || token !== bridgeToken) {
        throw new HttpError(401, 'invalid bridge token', 'BAD_BRIDGE_TOKEN');
      }

      const { sessionId, toolName, input, toolUseId } = req.body ?? {};
      if (!sessionId || !toolName) {
        throw new HttpError(400, 'sessionId and toolName required', 'MISSING_FIELD');
      }

      // 세션-스코프 자동 허용: 사용자가 같은 세션에서 이미 "이 세션" 으로 승인한
      // 도구라면 모달 띄우지 않고 즉시 allow 반환.
      if (approvalBroker.isToolAllowedForSession(sessionId, toolName)) {
        logger.info({ sessionId, toolName }, 'approval: auto-allowed (session allowlist)');
        return res.json({ behavior: 'allow' });
      }

      const { reqId, promise } = approvalBroker.request({ sessionId, toolName, input });

      logger.info({ sessionId, reqId, toolName }, 'approval: prompt requested');

      eventBus.publish('chat.permission-prompt', {
        sessionId,
        reqId,
        toolName,
        input: input ?? {},
        toolUseId: toolUseId ?? null
      });

      // 승인 모달은 화면을 보고 있어야만 뜬다 → 데스크톱/러너 상태와 무관하게 항상 푸시.
      // actions 로 알림에서 바로 승인/거부할 수 있게 한다.
      if (pushStore) {
        const agentId = sessionsStore?.get?.(sessionId)?.agentId ?? null;
        const agentName = (agentId && configStore?.getAgent?.(agentId)?.name) || agentId || sessionId;
        pushStore.sendPushToAll(
          `권한 요청 — ${agentName}`,
          `${toolName}: ${summarizeInput(input)}`,
          {
            url: `/chat?session=${encodeURIComponent(sessionId)}&approval=${encodeURIComponent(reqId)}`,
            skipIdleCheck: true,
            skipRunnerCheck: true,
            actions: [
              { action: 'approve', title: '승인' },
              { action: 'deny', title: '거부' }
            ]
          }
        ).catch(() => {});
      }

      // Wait for user decision (or timeout) — broker resolves the promise.
      const decision = await promise;

      // Inform UI that the prompt is no longer pending (covers timeouts / cancels
      // that the user never resolved manually).
      eventBus.publish('chat.permission-resolved', {
        sessionId,
        reqId,
        behavior: decision.behavior
      });

      res.json(decision);
    } catch (err) {
      next(err);
    }
  });

  // ── User endpoint — resolve pending prompt ──
  const resolveSchema = z.object({
    behavior: z.enum(['allow', 'deny']),
    updatedInput: z.record(z.unknown()).optional(),
    message: z.string().max(500).optional(),
    // Legacy boolean — `true` ⇔ scope:'always'. 신규 클라이언트는 `scope` 사용.
    remember: z.boolean().optional(),
    scope: z.enum(['once', 'session', 'always']).optional()
  }).strict();

  router.post('/api/chat/:sessionId/approval/:reqId', async (req, res, next) => {
    try {
      const parsed = resolveSchema.parse(req.body ?? {});
      const { sessionId, reqId } = req.params;

      // Look up what the pending request was for — so we can persist allowedTools if remember=true.
      const pending = approvalBroker.listPending(sessionId).find((p) => p.reqId === reqId);

      const decision =
        parsed.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: parsed.updatedInput }
          : { behavior: 'deny', message: parsed.message || 'Denied by user' };

      const resolved = approvalBroker.resolve(reqId, decision);
      if (!resolved) {
        throw new HttpError(404, 'approval request not found or already resolved', 'NOT_PENDING');
      }

      // 스코프 정규화: 새 `scope` 우선, 없으면 legacy `remember` 로 폴백.
      const scope = parsed.scope ?? (parsed.remember ? 'always' : 'once');

      if (parsed.behavior === 'allow' && pending?.toolName) {
        if (scope === 'session') {
          // 인메모리 allowlist — 같은 세션의 후속 요청은 모달 안 뜨고 자동 통과.
          // 서버 재시작 시 초기화.
          approvalBroker.allowToolForSession(sessionId, pending.toolName);
          logger.info({ sessionId, toolName: pending.toolName }, 'approval: tool added to session allowlist');
        } else if (scope === 'always' && sessionsStore && configStore) {
          // 영구 허용 — agent.allowedTools 에 추가
          const session = sessionsStore.get(sessionId);
          const agentId = session?.agentId;
          const agent = agentId ? configStore.getAgent(agentId) : null;
          if (agent) {
            const current = Array.isArray(agent.allowedTools) ? agent.allowedTools : [];
            if (!current.includes(pending.toolName)) {
              const next = [...current, pending.toolName];
              try {
                await configStore.updateAgent(agentId, { allowedTools: next });
                eventBus.publish('agent.updated', { agentId, patch: { allowedTools: next } });
                logger.info({ agentId, toolName: pending.toolName }, 'approval: tool added to allowedTools (always)');
              } catch (err) {
                logger.warn({ err: err.message, agentId }, 'approval: failed to persist allowedTools');
              }
            }
          }
        }
      }

      res.json({ ok: true });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  return router;
}
