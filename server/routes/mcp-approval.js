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
export function createMcpApprovalRouter({ approvalBroker, eventBus, bridgeToken, sessionsStore, configStore, metadataStore }) {
  const router = Router();

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

      const { reqId, promise } = approvalBroker.request({ sessionId, toolName, input });

      logger.info({ sessionId, reqId, toolName }, 'approval: prompt requested');

      eventBus.publish('chat.permission-prompt', {
        sessionId,
        reqId,
        toolName,
        input: input ?? {},
        toolUseId: toolUseId ?? null
      });

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
    remember: z.boolean().optional()
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

      // Persist "always allow" — append toolName to agent.allowedTools
      if (parsed.behavior === 'allow' && parsed.remember && pending?.toolName && sessionsStore && configStore) {
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
              logger.info({ agentId, toolName: pending.toolName }, 'approval: tool added to allowedTools (remember)');
            } catch (err) {
              logger.warn({ err: err.message, agentId }, 'approval: failed to persist allowedTools');
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
