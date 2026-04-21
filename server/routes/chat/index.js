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
  webConfig
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
    retryCounters,
    reEntryCounters,
    MAX_AUTO_RETRIES,
    MAX_REENTRY
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
  const { enqueueMessage, messageQueue } = ctx;

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
    const aborted = runner.abort(req.params.sessionId);
    if (eventBus) eventBus.publish('chat.aborted', { sessionId: req.params.sessionId });
    res.json({ aborted });
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
