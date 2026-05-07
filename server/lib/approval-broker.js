import { nanoid } from 'nanoid';
import { logger } from './logger.js';

// Default timeouts — MCP bridge side is slightly shorter so broker always wins
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

/**
 * Central manager for pending permission-prompt requests.
 *
 * Flow:
 *   1) MCP bridge subprocess POSTs /internal/approval/request
 *   2) Router calls broker.request({ sessionId, toolName, input }) → returns Promise
 *   3) Router also publishes 'chat.permission-prompt' to eventBus so the client modal shows
 *   4) User clicks → POST /api/chat/:sessionId/approval/:reqId → broker.resolve(reqId, decision)
 *   5) Original promise resolves → router responds to MCP bridge
 */
export function createApprovalBroker({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // reqId → { sessionId, resolve, timer }
  const pending = new Map();

  // sessionId → Set<toolName>. 사용자가 모달에서 "이 세션" 을 클릭한 도구는
  // 같은 세션의 후속 요청에서 자동 허용 (모달 안 뜸). 인메모리이므로 서버
  // 재시작 시 자연스럽게 초기화됨.
  const sessionAllowlist = new Map();

  function request({ sessionId, toolName, input }) {
    const reqId = nanoid(12);
    return {
      reqId,
      promise: new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.has(reqId)) {
            pending.delete(reqId);
            logger.warn({ sessionId, reqId, toolName }, 'approval: timeout — auto deny');
            resolve({ behavior: 'deny', message: 'Approval request timed out' });
          }
        }, timeoutMs);
        pending.set(reqId, { sessionId, resolve, timer, toolName });
      })
    };
  }

  function resolve(reqId, decision) {
    const entry = pending.get(reqId);
    if (!entry) return false;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    return true;
  }

  function cancelForSession(sessionId, reason = 'session aborted') {
    const cancelled = [];
    for (const [reqId, entry] of pending.entries()) {
      if (entry.sessionId !== sessionId) continue;
      pending.delete(reqId);
      clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: reason });
      cancelled.push(reqId);
    }
    if (cancelled.length) {
      logger.info({ sessionId, count: cancelled.length }, 'approval: cancelled pending for session');
    }
    return cancelled;
  }

  function listPending(sessionId) {
    const out = [];
    for (const [reqId, entry] of pending.entries()) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      out.push({ reqId, sessionId: entry.sessionId, toolName: entry.toolName });
    }
    return out;
  }

  function allowToolForSession(sessionId, toolName) {
    if (!sessionId || !toolName) return;
    let set = sessionAllowlist.get(sessionId);
    if (!set) {
      set = new Set();
      sessionAllowlist.set(sessionId, set);
    }
    set.add(toolName);
  }

  function isToolAllowedForSession(sessionId, toolName) {
    return sessionAllowlist.get(sessionId)?.has(toolName) ?? false;
  }

  function clearAllowlistForSession(sessionId) {
    sessionAllowlist.delete(sessionId);
  }

  return {
    request,
    resolve,
    cancelForSession,
    listPending,
    allowToolForSession,
    isToolAllowedForSession,
    clearAllowlistForSession,
  };
}
