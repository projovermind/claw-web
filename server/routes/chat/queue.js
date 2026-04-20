import { logger } from '../../lib/logger.js';

/**
 * Creates the message queue and agent delegation queue.
 * Cross-module calls (executeDelegation) are resolved lazily via ctx.
 */
export function createQueue(ctx) {
  // sessionId → queued user messages (sent when current response ends)
  const messageQueue = new Map();

  // agentId → pending delegation entries (when agent is busy)
  const agentQueue = new Map();

  function enqueueMessage(sessionId, message) {
    if (!messageQueue.has(sessionId)) messageQueue.set(sessionId, []);
    messageQueue.get(sessionId).push(message);
  }

  function flushQueue(sessionId) {
    const q = messageQueue.get(sessionId);
    if (!q || q.length === 0) return null;
    messageQueue.delete(sessionId);
    return q.length === 1 ? q[0] : q.map((m, i) => `[추가 ${i + 1}] ${m}`).join('\n\n');
  }

  function dequeueNextAgent(agentId) {
    const queue = agentQueue.get(agentId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (queue.length === 0) agentQueue.delete(agentId);
    logger.info({ agentId, remaining: agentQueue.get(agentId)?.length ?? 0 }, 'delegation: dequeuing next task');
    setTimeout(() => {
      ctx.executeDelegation(next.originSessionId, next.targetAgentId, next.task, next.rawText);
    }, 500);
  }

  return { messageQueue, agentQueue, enqueueMessage, flushQueue, dequeueNextAgent };
}
