import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../middleware/error-handler.js';
import { logger } from '../../lib/logger.js';
import { createQueue } from './queue.js';
import { createDelegation } from './delegation.js';
import { createMessageSender } from './message-sender.js';

const sendSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(50000),
  attachmentPaths: z.array(z.string().max(1000)).max(20).optional()
}).strict();

export function createChatRouter({
  sessionsStore,
  configStore,
  metadataStore,
  skillsStore,
  systemSkillsStore,
  projectsStore,
  backendsStore,
  accountsStore,
  runner,
  eventBus,
  delegationTracker,
  pushStore,
  webConfig,
  getBridgeContext,
  approvalBroker,
  bridgeToken
}) {
  const router = Router();

  // Self-recovery retry state (sessionId → { count, lastError })
  const retryCounters = new Map();
  const MAX_AUTO_RETRIES = 3;

  // Delegation re-entry counters (originSessionId → number)
  const reEntryCounters = new Map();
  const MAX_REENTRY = 8;

  // ── Shared ctx — resolved lazily to enable circular wiring ──
  const ctx = {
    sessionsStore,
    configStore,
    metadataStore,
    skillsStore,
    systemSkillsStore,
    projectsStore,
    backendsStore,
    accountsStore,
    runner,
    eventBus,
    delegationTracker,
    pushStore,
    webConfig,
    getBridgeContext,
    retryCounters,
    reEntryCounters,
    MAX_AUTO_RETRIES,
    MAX_REENTRY,
    approvalBroker,
    bridgeToken
  };

  // Wire queue (needs ctx.executeDelegation — resolved later)
  const queue = createQueue(ctx);
  Object.assign(ctx, queue);

  // Wire delegation (needs ctx.sendRunnerMessage, ctx.agentQueue — resolved later)
  const delegation = createDelegation(ctx);
  Object.assign(ctx, delegation);

  // Wire message-sender (needs ctx.handleDelegation, ctx.handleLoopContinuation,
  // ctx.flushQueue, ctx.dequeueNextAgent — all resolved now)
  const sender = createMessageSender(ctx);
  Object.assign(ctx, sender);

  // Local references for route handlers
  const { sendRunnerMessage } = ctx;
  const { enqueueMessage, messageQueue, getQueue, setQueue } = ctx;

  // Trailing contiguous queued user messages (newest run's pending queue,
  // mirrors the in-memory messageQueue 1:1 in order).
  function trailingQueuedIndices(messages) {
    const idx = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.queued === true && m?.role === 'user') idx.unshift(i);
      else break;
    }
    return idx;
  }

  // ── Routes ─────────────────────────────────────────────

  router.post('/', async (req, res, next) => {
    try {
      const { sessionId, message, attachmentPaths } = sendSchema.parse(req.body);
      const session = sessionsStore.get(sessionId);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      if (!configStore.getAgent(session.agentId)) {
        throw new HttpError(404, `Agent ${session.agentId} not found`, 'AGENT_NOT_FOUND');
      }

      // Running → queue for next turn
      if (runner.isRunning(sessionId)) {
        let augmentedMessage = message;
        if (attachmentPaths && attachmentPaths.length > 0) {
          const fileList = attachmentPaths.map((p) => `- ${p}`).join('\n');
          augmentedMessage = `${message}\n\n[첨부 파일]\n${fileList}`;
        }
        enqueueMessage(sessionId, augmentedMessage);
        await sessionsStore.appendMessage(sessionId, {
          role: 'user',
          content: augmentedMessage,
          attachmentPaths: attachmentPaths ?? [],
          queued: true
        });
        eventBus.publish('chat.queued', { sessionId, count: messageQueue.get(sessionId)?.length ?? 0 });
        logger.info({ sessionId, queue: messageQueue.get(sessionId)?.length }, 'chat: queued during running');
        return res.status(202).json({ sessionId, status: 'queued', queueLength: messageQueue.get(sessionId)?.length });
      }

      // Auto-title on first message
      const isFirstMessage = !session.messages?.length;
      let augmentedMessage = message;
      if (attachmentPaths && attachmentPaths.length > 0) {
        const fileList = attachmentPaths.map((p) => `- ${p}`).join('\n');
        augmentedMessage = `${message}\n\n[첨부 파일]\n${fileList}\n\n위 경로의 파일들을 Read 도구로 확인해주세요.`;
      }
      await sessionsStore.appendMessage(sessionId, {
        role: 'user',
        content: augmentedMessage,
        attachmentPaths: attachmentPaths ?? []
      });
      if (isFirstMessage && (!session.title || session.title === 'New session')) {
        const title = message.slice(0, 40).replace(/\n/g, ' ').trim() || 'New session';
        await sessionsStore.update(sessionId, { title });
      }

      // Unpause escalated loop on new user message
      if (session.loop?.enabled && session.loop?.paused) {
        await sessionsStore.update(sessionId, {
          loop: { ...session.loop, paused: false }
        });
      }

      reEntryCounters.delete(sessionId);
      sendRunnerMessage(sessionId, augmentedMessage);
      res.status(202).json({ sessionId, status: 'started' });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/:sessionId', (req, res) => {
    const sid = req.params.sessionId;
    const aborted = runner.abort(sid);
    // Cancel any pending permission-prompt modal for this session so the UI clears.
    if (approvalBroker) approvalBroker.cancelForSession(sid, 'session aborted');
    if (eventBus) eventBus.publish('chat.aborted', { sessionId: sid });
    res.json({ aborted });
  });

  // DELETE /api/chat/:sessionId/queue/:ts — drop one pending queued message.
  router.delete('/:sessionId/queue/:ts', async (req, res, next) => {
    try {
      const { sessionId, ts } = req.params;
      const session = sessionsStore.get(sessionId);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      const messages = Array.isArray(session.messages) ? session.messages : [];
      const qIdx = trailingQueuedIndices(messages);
      const posInRun = qIdx.findIndex((i) => messages[i].ts === ts);
      if (posInRun < 0) throw new HttpError(404, 'Queued message not found', 'QUEUED_NOT_FOUND');

      const absIdx = qIdx[posInRun];
      await sessionsStore.setMessages(sessionId, messages.filter((_, i) => i !== absIdx));

      const q = getQueue(sessionId).slice();
      if (posInRun < q.length) q.splice(posInRun, 1);
      setQueue(sessionId, q);

      const count = getQueue(sessionId).length;
      eventBus.publish('chat.queued', { sessionId, count });
      logger.info({ sessionId, ts, remaining: count }, 'chat: queued message deleted');
      res.json({ sessionId, queueLength: count });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/chat/:sessionId/queue/merge — combine all pending queued messages into one.
  router.post('/:sessionId/queue/merge', async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const session = sessionsStore.get(sessionId);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      const messages = Array.isArray(session.messages) ? session.messages : [];
      const qIdx = trailingQueuedIndices(messages);
      if (qIdx.length < 2) throw new HttpError(400, 'Nothing to merge', 'QUEUE_TOO_SHORT');

      const mergedContent = qIdx.map((i) => messages[i].content).join('\n\n');
      const mergedAttachments = qIdx.flatMap((i) => messages[i].attachmentPaths ?? []);
      const firstIdx = qIdx[0];
      const dropSet = new Set(qIdx.slice(1));
      const newMessages = messages
        .map((m, i) => (i === firstIdx
          ? { ...m, content: mergedContent, attachmentPaths: mergedAttachments }
          : m))
        .filter((_, i) => !dropSet.has(i));
      await sessionsStore.setMessages(sessionId, newMessages);

      // Mirror in-memory queue: collapse to a single combined entry.
      const q = getQueue(sessionId);
      setQueue(sessionId, q.length >= 2 ? [q.join('\n\n')] : q);

      const count = getQueue(sessionId).length;
      eventBus.publish('chat.queued', { sessionId, count });
      logger.info({ sessionId, merged: qIdx.length, remaining: count }, 'chat: queued messages merged');
      res.json({ sessionId, queueLength: count });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Resume interrupted session on server restart.
   * (1) If claudeSessionId + resume file exists → --resume loads it (컨텍스트 그대로).
   * (2) 없으면 sendRunnerMessage 내부 isFirstMsg 경로가 자동으로
   *     buildConversationSummary 를 프리픽스로 붙여 맥락을 재주입.
   *     → 여기서 수동으로 컨텍스트 블록을 덧붙이면 이중 주입이 됨.
   */
  async function resumeInterruptedSession(sessionId) {
    const session = sessionsStore.get(sessionId);
    if (!session) return false;
    const msgs = Array.isArray(session.messages) ? session.messages : [];
    const lastUserIdx = [...msgs].reverse().findIndex((m) => m?.role === 'user');
    if (lastUserIdx < 0) return false;
    const absoluteIdx = msgs.length - 1 - lastUserIdx;
    const lastUser = msgs[absoluteIdx];
    if (!lastUser?.content) return false;

    const hasClaudeId = !!(session.claudeSessionId || session.claude_session_id);

    logger.info(
      { sessionId, hasClaudeId, priorCount: absoluteIdx },
      'resuming interrupted session'
    );

    await sessionsStore.appendMessage(sessionId, {
      role: 'assistant',
      content: hasClaudeId
        ? '▶ **재시작 후 작업 이어가기** — 이전 세션을 복원합니다.'
        : '▶ **재시작 후 작업 이어가기** — 이전 세션 ID 가 없어 대화 컨텍스트를 재주입합니다.'
    }).catch(() => {});

    // fresh-start (resume 파일 부재) 시 컨텍스트 주입은 sendRunnerMessage 에 위임.
    sendRunnerMessage(sessionId, lastUser.content);
    return true;
  }

  return { router, resumeInterruptedSession };
}
