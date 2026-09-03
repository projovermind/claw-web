import { logger } from '../../lib/logger.js';

/**
 * Agent-level delegation queue: holds tasks aimed at an agent that is already
 * busy with another delegation. Distinct from the per-session dispatch queue
 * (dispatch.js), which serializes turns within one session.
 * Cross-module calls (executeDelegation) are resolved lazily via ctx.
 */
export function createQueue(ctx) {
  // agentId → pending delegation entries (when agent is busy)
  const agentQueue = new Map();

  function dequeueNextAgent(agentId) {
    const queue = agentQueue.get(agentId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (queue.length === 0) agentQueue.delete(agentId);
    // 재시작 복구가 이미 꺼내간 작업을 다시 보고하지 않도록 즉시 반영.
    ctx.delegationTracker?.setPendingQueue?.(agentQueue);
    logger.info({ agentId, remaining: agentQueue.get(agentId)?.length ?? 0 }, 'delegation: dequeuing next task');
    setTimeout(() => {
      // executeDelegation 은 async — 타이머 콜백에서 reject 되면 unhandledRejection 이다.
      Promise.resolve(
        ctx.executeDelegation(next.originSessionId, next.targetAgentId, next.task, next.rawText)
      ).catch((err) =>
        logger.warn({ err: err?.message, agentId }, 'delegation: dequeued execution failed')
      );
    }, 500);
  }

  return { agentQueue, dequeueNextAgent };
}
