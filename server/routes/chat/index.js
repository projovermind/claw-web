import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../middleware/error-handler.js';
import { logger } from '../../lib/logger.js';
import { createQueue } from './queue.js';
import { createDelegation } from './delegation.js';
import { createWakeup } from './wakeup.js';
import { createMessageSender } from './message-sender.js';
import { createDispatcher } from './dispatch.js';

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

  // Wire agent-delegation queue (needs ctx.executeDelegation — resolved later)
  const queue = createQueue(ctx);
  Object.assign(ctx, queue);

  // Wire delegation (needs ctx.dispatch, ctx.agentQueue — resolved later)
  const delegation = createDelegation(ctx);
  Object.assign(ctx, delegation);

  // Wire wakeup (needs ctx.dispatch — resolved later)
  const wakeup = createWakeup(ctx);
  Object.assign(ctx, wakeup);

  // Wire message-sender (needs ctx.handleDelegation, ctx.handleLoopContinuation,
  // ctx.dispatch, ctx.dequeueNextAgent — dispatch resolved just below)
  const sender = createMessageSender(ctx);
  Object.assign(ctx, sender);

  // Wire the dispatcher last: it owns ctx.startRunner, which only exists now.
  // (It reads ctx.startRunner lazily, so the cycle sender ↔ dispatcher is fine.)
  const dispatcher = createDispatcher(ctx);
  Object.assign(ctx, dispatcher);

  // Trailing contiguous queued user messages — the stored mirror of the
  // dispatcher's pending `user` items, in the same order.
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

      // 유저가 개입했으면 예약된 자동 재개는 의미가 없다 — 취소.
      ctx.cancelWakeup(sessionId, 'user message');

      // Auto-title on first message
      const isFirstMessage = !session.messages?.length;
      let augmentedMessage = message;
      if (attachmentPaths && attachmentPaths.length > 0) {
        const fileList = attachmentPaths.map((p) => `- ${p}`).join('\n');
        augmentedMessage = `${message}\n\n[첨부 파일]\n${fileList}\n\n위 경로의 파일들을 Read 도구로 확인해주세요.`;
      }
      // Store the message before dispatching: an idle session starts the runner
      // synchronously inside dispatch(), and the runner reads session.messages to
      // decide first-turn injection / conversation-summary re-injection.
      await sessionsStore.appendMessage(sessionId, {
        role: 'user',
        content: augmentedMessage,
        attachmentPaths: attachmentPaths ?? [],
        ...(ctx.isSessionBusy(sessionId) ? { queued: true } : {})
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

      // 유저가 새로 개입했으니 위임 자동 재진입 카운터를 리셋.
      reEntryCounters.delete(sessionId);

      const { queued, queueLength } = ctx.dispatch(sessionId, { kind: 'user', content: augmentedMessage });
      if (queued) {
        eventBus.publish('chat.queued', { sessionId, count: queueLength });
        logger.info({ sessionId, queue: queueLength }, 'chat: queued during running');
      }
      res.status(202).json({ sessionId, status: queued ? 'queued' : 'started', queueLength });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/:sessionId', (req, res) => {
    const sid = req.params.sessionId;
    const aborted = runner.abort(sid);
    ctx.abortDispatch(sid, 'user aborted');
    ctx.cancelWakeup(sid, 'session aborted');
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

      ctx.removeUserItem(sessionId, posInRun);

      const count = ctx.countUserItems(sessionId);
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

      // Mirror the dispatch queue: collapse pending user items into one.
      ctx.mergeUserItems(sessionId);

      const count = ctx.countUserItems(sessionId);
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
   * (2) 없으면 startRunner 내부 isFirstMsg 경로가 자동으로
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

    // fresh-start (resume 파일 부재) 시 컨텍스트 주입은 startRunner 에 위임.
    ctx.dispatch(sessionId, { kind: 'resume', content: lastUser.content });
    return true;
  }

  return {
    router,
    resumeInterruptedSession,
    clearAllWakeups: ctx.clearAllWakeups,
    clearAllDispatch: ctx.clearAllDispatch,
    abortDispatch: ctx.abortDispatch
  };
}
