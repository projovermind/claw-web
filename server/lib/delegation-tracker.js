import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Tracker for agent-to-agent delegations, persisted to disk.
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
 *     depth: 1,
 *     status: "running" | "completed" | "failed" | "orphaned",
 *     createdAt: ISO string,
 *     completedAt: ISO string | null,
 *     result: string | null,           // summary handed back to the planner
 *     reportPath: string | null        // full worker response on disk
 *   }
 *
 * Persistence matters because a worker outliving a server restart used to leave
 * the planner waiting forever on a report that could no longer be delivered.
 */

const MAX_HISTORY = 300;
const MAX_CHAIN_WALK = 12;

export function createDelegationTracker({ filePath = null, reportsDir = null } = {}) {
  const active = new Map();        // targetSessionId → entry
  const byOrigin = new Map();      // originSessionId → [entry, ...]
  const activeByAgent = new Map(); // agentId → count of active delegations
  const finished = new Map();      // targetSessionId → entry (completed/failed/orphaned)
  const history = [];              // finished entries, oldest first, capped

  let idCounter = 0;
  let writeTimer = null;

  let pendingQueueRef = null;  // live agentId → [task, ...] map owned by the chat router
  let restoredPending = [];    // queued-but-never-started tasks recovered from the last run
  let orphanedOnRestore = [];  // entries that were mid-flight when the process died

  function indexByOrigin(entry) {
    if (!byOrigin.has(entry.originSessionId)) byOrigin.set(entry.originSessionId, []);
    byOrigin.get(entry.originSessionId).push(entry);
  }

  function retire(entry) {
    finished.set(entry.targetSessionId, entry);
    history.push(entry);
    while (history.length > MAX_HISTORY) {
      const dropped = history.shift();
      if (finished.get(dropped.targetSessionId) === dropped) finished.delete(dropped.targetSessionId);
    }
  }

  function releaseAgent(agentId) {
    const prev = activeByAgent.get(agentId) ?? 1;
    const next = Math.max(0, prev - 1);
    if (next === 0) activeByAgent.delete(agentId);
    else activeByAgent.set(agentId, next);
  }

  /**
   * Tasks sitting in the router's per-agent wait queue were never handed to a
   * worker, so nothing else on disk remembers them. Without this they vanish on
   * restart and the planner waits forever for a delegation that never ran.
   */
  function serializePending() {
    if (!pendingQueueRef) return [];
    return [...pendingQueueRef.values()].flat().map((item) => ({
      originSessionId: item.originSessionId,
      targetAgentId: item.targetAgentId,
      task: item.task
    }));
  }

  function persistNow() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {
        version: 2,
        savedAt: new Date().toISOString(),
        idCounter,
        active: [...active.values()],
        pending: serializePending(),
        history: history.slice(-MAX_HISTORY)
      };
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      logger.warn({ err: err.message, filePath }, 'delegation: persist failed');
    }
  }

  function schedulePersist() {
    if (!filePath || writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      persistNow();
    }, 300);
    writeTimer.unref?.();
  }

  /**
   * Load prior state. Anything still "running" belongs to a process that no
   * longer exists, so it is retired as orphaned — otherwise isAgentBusy() would
   * report a permanently busy agent and queue every future delegation forever.
   */
  function restore() {
    if (!filePath || !fs.existsSync(filePath)) return;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      logger.warn({ err: err.message, filePath }, 'delegation: restore failed — starting empty');
      return;
    }
    idCounter = Number(payload?.idCounter) || 0;
    for (const entry of payload?.history ?? []) {
      retire(entry);
      indexByOrigin(entry);
    }
    const orphans = payload?.active ?? [];
    for (const entry of orphans) {
      entry.status = 'orphaned';
      entry.completedAt = new Date().toISOString();
      entry.result = entry.result ?? '서버 재시작으로 중단됨 (결과 회수 불가)';
      retire(entry);
      indexByOrigin(entry);
    }
    orphanedOnRestore = orphans;
    restoredPending = (payload?.pending ?? []).filter((p) => p?.originSessionId && p?.task);
    if (orphans.length || restoredPending.length) {
      logger.warn(
        { running: orphans.length, queued: restoredPending.length, ids: orphans.map((e) => e.id) },
        'delegation: reclaimed interrupted delegations from previous run'
      );
      persistNow();
    }
  }

  restore();

  return {
    /**
     * Register a new delegation. Returns the entry.
     */
    create({ originSessionId, targetSessionId, targetAgentId, task, loop = false, depth = 1 }) {
      const id = `del_${++idCounter}_${Date.now().toString(36)}`;
      const entry = {
        id,
        originSessionId,
        targetSessionId,
        targetAgentId,
        task,
        loop,
        depth,
        status: 'running',
        createdAt: new Date().toISOString(),
        completedAt: null,
        result: null,
        reportPath: null
      };
      active.set(targetSessionId, entry);
      indexByOrigin(entry);
      activeByAgent.set(targetAgentId, (activeByAgent.get(targetAgentId) ?? 0) + 1);
      schedulePersist();
      logger.info({ id, originSessionId, targetSessionId, targetAgentId, depth }, 'delegation: created');
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
     * How many delegation hops deep this session already sits. A planner session
     * that was never delegated to returns 0.
     */
    getChainDepth(sessionId) {
      let depth = 0;
      let cursor = sessionId;
      for (let i = 0; i < MAX_CHAIN_WALK; i++) {
        const entry = active.get(cursor) ?? finished.get(cursor);
        if (!entry) break;
        depth++;
        cursor = entry.originSessionId;
      }
      return depth;
    },

    /**
     * Mark a delegation as completed with a result summary.
     */
    complete(targetSessionId, result, reportPath = null) {
      const entry = active.get(targetSessionId);
      if (!entry) return null;
      entry.status = 'completed';
      entry.completedAt = new Date().toISOString();
      entry.result = result;
      entry.reportPath = reportPath;
      active.delete(targetSessionId);
      retire(entry);
      releaseAgent(entry.targetAgentId);
      schedulePersist();
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
      retire(entry);
      releaseAgent(entry.targetAgentId);
      schedulePersist();
      logger.warn({ id: entry.id, error }, 'delegation: failed');
      return entry;
    },

    /**
     * Persist a worker's full response so the summary handed to the planner can
     * stay short without the detail becoming unrecoverable. Returns the path.
     */
    saveFullReport(targetSessionId, text) {
      if (!reportsDir || !text) return null;
      try {
        fs.mkdirSync(reportsDir, { recursive: true });
        const safeId = String(targetSessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const file = path.join(reportsDir, `${safeId}.md`);
        fs.writeFileSync(file, text);
        return file;
      } catch (err) {
        logger.warn({ err: err.message, targetSessionId }, 'delegation: full report save failed');
        return null;
      }
    },

    /**
     * Returns true if the given agentId has at least one active delegation running.
     */
    isAgentBusy(agentId) {
      return (activeByAgent.get(agentId) ?? 0) > 0;
    },

    /**
     * Get all delegations (active + finished) for a given origin session.
     */
    getByOrigin(originSessionId) {
      return byOrigin.get(originSessionId) ?? [];
    },

    /**
     * Register the router's live wait queue so it gets persisted alongside the
     * active delegations. Calling it again after the queue mutates re-arms the
     * debounced write.
     */
    setPendingQueue(queueMap) {
      pendingQueueRef = queueMap ?? null;
      schedulePersist();
    },

    /** Tasks that were still waiting for a busy agent when the process died. */
    getPendingQueue() {
      return restoredPending;
    },

    /**
     * Everything the previous run lost: delegations that were mid-flight plus
     * those that never got their turn. The chat router reports these back to the
     * originating planners so a restart does not silently swallow work.
     */
    listOrphaned() {
      return [
        ...orphanedOnRestore.map((e) => ({
          originSessionId: e.originSessionId,
          targetAgentId: e.targetAgentId,
          task: e.task,
          state: 'running'
        })),
        ...restoredPending.map((p) => ({
          originSessionId: p.originSessionId,
          targetAgentId: p.targetAgentId,
          task: p.task,
          state: 'queued'
        }))
      ];
    },

    /** For debugging */
    activeCount() {
      return active.size;
    },

    list() { return [...active.values()]; },

    listRecent(limit = 50) { return history.slice(-limit).reverse(); }
  };
}
