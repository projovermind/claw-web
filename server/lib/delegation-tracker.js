import { logger } from './logger.js';

/**
 * In-memory tracker for agent-to-agent delegations.
 *
 * When a planner outputs {"delegate": {"agent": "td_frontend", "task": "..."}},
 * the chat route creates a delegation entry. When the target session finishes
 * (chat.done), we look up whether it was a delegation and report the result
 * back to the originating session.
 *
 * Shape of an entry:
 *   {
 *     id: "del_abc123",
 *     originSessionId: "sess_xxx",   // planner's session
 *     targetSessionId: "sess_yyy",   // created for the worker
 *     targetAgentId: "td_frontend",
 *     task: "로그인 UI 구현",
 *     loop: false,
 *     status: "running" | "completed" | "failed",
 *     createdAt: ISO string,
 *     completedAt: ISO string | null,
 *     result: string | null            // summary of worker's response
 *   }
 */
export function createDelegationTracker() {
  const active = new Map();  // targetSessionId → entry
  const byOrigin = new Map(); // originSessionId → [entry, ...]
  const activeByAgent = new Map(); // agentId → count of active delegations

  let idCounter = 0;

  return {
    /**
     * Register a new delegation. Returns the entry.
     */
    create({ originSessionId, targetSessionId, targetAgentId, task, loop = false }) {
      const id = `del_${++idCounter}_${Date.now().toString(36)}`;
      const entry = {
        id,
        originSessionId,
        targetSessionId,
        targetAgentId,
        task,
        loop,
        status: 'running',
        createdAt: new Date().toISOString(),
        completedAt: null,
        result: null
      };
      active.set(targetSessionId, entry);
      if (!byOrigin.has(originSessionId)) byOrigin.set(originSessionId, []);
      byOrigin.get(originSessionId).push(entry);
      activeByAgent.set(targetAgentId, (activeByAgent.get(targetAgentId) ?? 0) + 1);
      logger.info({ id, originSessionId, targetSessionId, targetAgentId }, 'delegation: created');
      return entry;
    },

    /**
     * Called when a chat.done fires. If the sessionId is a delegation target,
     * returns the entry (so the caller can report back). Otherwise null.
     */
    getByTarget(targetSessionId) {
      return active.get(targetSessionId) ?? null;
    },

    /**
     * Mark a delegation as completed with a result summary.
     */
    complete(targetSessionId, result) {
      const entry = active.get(targetSessionId);
      if (!entry) return null;
      entry.status = 'completed';
      entry.completedAt = new Date().toISOString();
      entry.result = result;
      active.delete(targetSessionId);
      const prev = activeByAgent.get(entry.targetAgentId) ?? 1;
      activeByAgent.set(entry.targetAgentId, Math.max(0, prev - 1));
      logger.info({ id: entry.id, targetAgentId: entry.targetAgentId }, 'delegation: completed');
      return entry;
    },

    /**
     * Mark a delegation as failed.
     */
    fail(targetSessionId, error) {
      const entry = active.get(targetSessionId);
      if (!entry) return null;
      entry.status = 'failed';
      entry.completedAt = new Date().toISOString();
      entry.result = `Error: ${error}`;
      active.delete(targetSessionId);
      const prev = activeByAgent.get(entry.targetAgentId) ?? 1;
      activeByAgent.set(entry.targetAgentId, Math.max(0, prev - 1));
      logger.warn({ id: entry.id, error }, 'delegation: failed');
      return entry;
    },

    /**
     * Returns true if the given agentId has at least one active delegation running.
     */
    isAgentBusy(agentId) {
      return (activeByAgent.get(agentId) ?? 0) > 0;
    },

    /**
     * Get all delegations (active + completed) for a given origin session.
     */
    getByOrigin(originSessionId) {
      return byOrigin.get(originSessionId) ?? [];
    },

    /** For debugging */
    activeCount() {
      return active.size;
    },

    list() { return [...active.values()]; }
  };
}
