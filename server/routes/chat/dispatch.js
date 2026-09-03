import { logger } from '../../lib/logger.js';

/**
 * Per-session serial dispatch queue.
 *
 * Every path that wants the runner to produce a turn goes through `dispatch()`.
 * Nothing else may call `startRunner`. That single ownership is what removes the
 * check-then-act races: the decision "run now vs. queue" happens exactly once,
 * inside `pumpOnce`, in a synchronous stretch that reaches `runner.start()`
 * without a single `await` in between. No other code can interleave there, so
 * two producers can no longer both observe "idle" and both call start.
 *
 * State per session:
 *   queued  — items waiting (queues)
 *   running — a turn we started and have not seen settle yet (running)
 *   idle    — neither
 *
 * Transitions:
 *   dispatch()      queued;   idle → (pump) → running
 *   onSettled()     running → idle, then re-pump after a short coalesce window
 *   abort()         running/queued → idle, queue discarded (user-visible note)
 *   heartbeat       running → idle when the runner is demonstrably gone
 *                   (safety net for runners that die without firing onExit)
 */

/** Wait this long after a dispatch on an idle session — 0 means start now. */
const COALESCE_MS = 200;
/**
 * After a turn ends, wait before starting the next batch. The previous turn's
 * `onResult` handler is still running its async tail (store writes, delegation
 * bookkeeping) and may dispatch more items; this window lets them land in the
 * same batch so a planner sees "queued user message + all worker reports" as one
 * turn instead of several. Missing the window costs an extra turn, never a message.
 */
const IDLE_COALESCE_MS = 400;
/** Safety net re-check while items are waiting. Not the primary wake-up path. */
const HEARTBEAT_MS = 10_000;
/** `already running` contention retries before we give up and tell the user. */
const MAX_CONTENTION_RETRIES = 30;
const CONTENTION_RETRY_MS = 1000;

const MERGE_SEPARATOR = '\n\n---\n\n';

const QUEUED_PREFIX = '[이전 답변 중에 추가된 요청 — 이전 맥락을 참고해서 답변하세요]';

/**
 * `exclusive` items are delivered alone — they either carry their own
 * `claudeSessionId` (fresh-start vs. resume) or replay a previous message, so
 * merging them would duplicate content or lose the session-id intent.
 *
 * `rank` orders a merged batch: the user's live instruction first (it frames how
 * the agent should read everything else), then inbound automated results, then
 * the agent's own self-driven continuations.
 */
const KINDS = {
  user: { exclusive: false, rank: 0 },
  task: { exclusive: false, rank: 0 },
  report: { exclusive: false, rank: 1 },
  escalation: { exclusive: false, rank: 1 },
  undelivered: { exclusive: false, rank: 1 },
  loop: { exclusive: false, rank: 2 },
  wakeup: { exclusive: false, rank: 2 },
  retry: { exclusive: true, rank: 0 },
  resume: { exclusive: true, rank: 0 }
};

function kindOf(kind) {
  return KINDS[kind] ?? KINDS.user;
}

export function createDispatcher(ctx) {
  const { runner, sessionsStore, eventBus } = ctx;

  const queues = new Map(); // sessionId → item[]
  // sessionId → turn token. Set 이 아니라 Map 인 이유: abort 직후 새 턴이 시작되면
  // 앞 턴의 뒤늦은 onSettled 가 새 턴의 running 플래그를 지워 같은 세션에 자식
  // 프로세스 두 개가 붙는다. 토큰이 일치할 때만 지운다.
  const running = new Map();
  let turnSeq = 0;
  const timers = new Map(); // sessionId → Timeout (pending pump)
  const heartbeats = new Map(); // sessionId → Timeout
  const pumping = new Set(); // re-entrancy guard
  const repump = new Set(); // pump requested while pumping

  function isSessionBusy(sessionId) {
    return running.has(sessionId) || runner.isRunning(sessionId);
  }

  function clearTimer(sessionId) {
    const t = timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      timers.delete(sessionId);
    }
  }

  function requestPump(sessionId, delay) {
    if (timers.has(sessionId)) return; // a window is already open — keep coalescing
    if (delay <= 0) {
      pump(sessionId);
      return;
    }
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        pump(sessionId);
      }, delay)
    );
  }

  function armHeartbeat(sessionId) {
    if (heartbeats.has(sessionId)) return;
    heartbeats.set(
      sessionId,
      setTimeout(() => {
        heartbeats.delete(sessionId);
        if (!queues.get(sessionId)?.length) return;
        // A runner can vanish without firing onExit (openai path aborted out of
        // band, spawn error swallowed). Without this the session would queue
        // forever. Safe to read here: we are on our own tick, never inside the
        // synchronous start window.
        if (running.has(sessionId) && !runner.isRunning(sessionId)) {
          logger.warn({ sessionId }, 'dispatch: stale running flag — reconciled by heartbeat');
          running.delete(sessionId);
        }
        pump(sessionId);
        if (queues.get(sessionId)?.length) armHeartbeat(sessionId);
      }, HEARTBEAT_MS)
    );
  }

  function clearHeartbeat(sessionId) {
    const t = heartbeats.get(sessionId);
    if (t) {
      clearTimeout(t);
      heartbeats.delete(sessionId);
    }
  }

  function passesGuard(item) {
    if (typeof item.guard !== 'function') return true;
    try {
      return item.guard() !== false;
    } catch (err) {
      logger.warn({ err: err.message, kind: item.kind }, 'dispatch: guard threw — dropping item');
      return false;
    }
  }

  function buildUserBlock(items) {
    const body =
      items.length === 1
        ? items[0].content
        : items.map((it, i) => `[추가 ${i + 1}] ${it.content}`).join('\n\n');
    return items.some((it) => it.deferred) ? `${QUEUED_PREFIX}\n\n${body}` : body;
  }

  function buildBatch(items) {
    const userItems = items.filter((it) => kindOf(it.kind).rank === 0);
    const rest = items
      .filter((it) => kindOf(it.kind).rank !== 0)
      .sort((a, b) => kindOf(a.kind).rank - kindOf(b.kind).rank);
    const parts = [];
    if (userItems.length) parts.push(buildUserBlock(userItems));
    for (const it of rest) parts.push(it.content);
    return { content: parts.join(MERGE_SEPARATOR), items };
  }

  /** Pull the next runnable batch off the queue. Synchronous by contract. */
  function takeBatch(sessionId) {
    const q = queues.get(sessionId);
    while (q?.length) {
      const head = q[0];
      if (!passesGuard(head)) {
        q.shift();
        logger.info({ sessionId, kind: head.kind }, 'dispatch: item dropped by guard');
        continue;
      }
      if (kindOf(head.kind).exclusive) {
        q.shift();
        const batch = { content: head.content, items: [head] };
        if ('claudeSessionId' in head) batch.claudeSessionId = head.claudeSessionId;
        if (!q.length) queues.delete(sessionId);
        return batch;
      }
      const picked = [];
      while (q.length && !kindOf(q[0].kind).exclusive) {
        const it = q.shift();
        if (!passesGuard(it)) {
          logger.info({ sessionId, kind: it.kind }, 'dispatch: item dropped by guard');
          continue;
        }
        picked.push(it);
      }
      if (!q.length) queues.delete(sessionId);
      if (picked.length) return buildBatch(picked);
    }
    queues.delete(sessionId);
    return null;
  }

  function requeue(sessionId, items) {
    const q = queues.get(sessionId) ?? [];
    q.unshift(...items);
    queues.set(sessionId, q);
  }

  async function notifyUndeliverable(sessionId, reason, items) {
    // Never drop silently: the trigger content is already in the session as a
    // user message, so surface why it will not be answered.
    await sessionsStore
      .appendMessage(sessionId, {
        role: 'assistant',
        content: `⚠️ **메시지를 실행하지 못했습니다** — ${reason}\n\n대기 중이던 ${items.length}건이 전달되지 않았습니다. 다시 보내주세요.`
      })
      .catch(() => {});
    eventBus.publish('chat.error', { sessionId, error: reason });
  }

  function pumpOnce(sessionId) {
    if (!queues.get(sessionId)?.length) return;
    if (running.has(sessionId)) {
      armHeartbeat(sessionId);
      return;
    }
    if (runner.isRunning(sessionId)) {
      // Should not happen — nothing outside this module starts a runner.
      logger.warn({ sessionId }, 'dispatch: runner busy without queue ownership — deferring');
      armHeartbeat(sessionId);
      requestPump(sessionId, CONTENTION_RETRY_MS);
      return;
    }

    const batch = takeBatch(sessionId);
    if (!batch) return;

    // ── critical section: no await between here and runner.start() ──
    const turnToken = ++turnSeq;
    running.set(sessionId, turnToken);
    clearHeartbeat(sessionId);

    let settled = false;
    const releaseTurn = () => {
      if (running.get(sessionId) === turnToken) running.delete(sessionId);
    };
    const onSettled = () => {
      if (!settled) {
        settled = true;
        releaseTurn();
      }
      clearTimer(sessionId);
      requestPump(sessionId, IDLE_COALESCE_MS);
    };

    const opts = { onSettled };
    if ('claudeSessionId' in batch) opts.claudeSessionId = batch.claudeSessionId;

    let result;
    try {
      result = ctx.startRunner(sessionId, batch.content, opts);
    } catch (err) {
      result = { started: false, reason: err.message };
    }
    if (result?.started) return;
    // ── end critical section ──

    settled = true;
    releaseTurn();

    const reason = result?.reason ?? 'unknown';
    if (reason === 'session_missing') {
      logger.info({ sessionId, count: batch.items.length }, 'dispatch: session gone — discarding batch');
      queues.delete(sessionId);
      clearHeartbeat(sessionId);
      return;
    }
    if (/already running/i.test(reason)) {
      const attempts = (batch.items[0].contention ?? 0) + 1;
      for (const it of batch.items) it.contention = attempts;
      if (attempts <= MAX_CONTENTION_RETRIES) {
        requeue(sessionId, batch.items);
        logger.warn({ sessionId, attempts }, 'dispatch: runner still occupied — requeued');
        requestPump(sessionId, CONTENTION_RETRY_MS);
        return;
      }
      logger.error({ sessionId, attempts }, 'dispatch: contention retries exhausted');
      notifyUndeliverable(sessionId, `러너가 ${attempts}초 동안 점유 해제되지 않았습니다`, batch.items);
      return;
    }
    logger.warn({ sessionId, reason }, 'dispatch: start failed');
    notifyUndeliverable(sessionId, reason, batch.items);
    requestPump(sessionId, IDLE_COALESCE_MS);
  }

  function pump(sessionId) {
    if (pumping.has(sessionId)) {
      repump.add(sessionId);
      return;
    }
    pumping.add(sessionId);
    try {
      do {
        repump.delete(sessionId);
        pumpOnce(sessionId);
      } while (repump.has(sessionId));
    } finally {
      pumping.delete(sessionId);
      repump.delete(sessionId);
    }
  }

  /**
   * The one entry point. `item`:
   *   kind             — see KINDS
   *   content          — text handed to the runner
   *   claudeSessionId  — optional, exclusive kinds only (null = force fresh start)
   *   guard            — optional predicate re-checked at dequeue time
   *
   * Returns { queued, queueLength } where `queued` means the turn did not start
   * immediately. `queueLength` counts pending user messages (UI badge).
   */
  function dispatch(sessionId, item) {
    // 다른 무언가가 세션을 깨웠다면 예약된 자동 재개는 확인할 것이 없는 빈 턴이 된다.
    // 위임 보고가 그 대표 사례 — 워커 결과는 이벤트로 도착하므로 폴링 턴은 순수 낭비다.
    if (item.kind !== 'wakeup') ctx.cancelWakeup?.(sessionId, `superseded by ${item.kind}`);

    const deferred = isSessionBusy(sessionId);
    const entry = { ...item, deferred };
    const q = queues.get(sessionId) ?? [];
    q.push(entry);
    queues.set(sessionId, q);

    if (deferred) {
      armHeartbeat(sessionId);
      requestPump(sessionId, COALESCE_MS);
    } else {
      requestPump(sessionId, q.length > 1 ? COALESCE_MS : 0);
    }
    return { queued: deferred, queueLength: countUserItems(sessionId) };
  }

  // ── User-message queue introspection (drives the UI badge + queue endpoints) ──

  function userItems(sessionId) {
    return (queues.get(sessionId) ?? []).filter((it) => it.kind === 'user');
  }

  function countUserItems(sessionId) {
    return userItems(sessionId).length;
  }

  /** Drop the `pos`-th pending user message. Returns true when one was removed. */
  function removeUserItem(sessionId, pos) {
    const q = queues.get(sessionId);
    if (!q) return false;
    let seen = 0;
    for (let i = 0; i < q.length; i++) {
      if (q[i].kind !== 'user') continue;
      if (seen === pos) {
        q.splice(i, 1);
        if (!q.length) queues.delete(sessionId);
        return true;
      }
      seen++;
    }
    return false;
  }

  /** Collapse all pending user messages into the first one. */
  function mergeUserItems(sessionId) {
    const q = queues.get(sessionId);
    if (!q) return 0;
    const idx = [];
    for (let i = 0; i < q.length; i++) if (q[i].kind === 'user') idx.push(i);
    if (idx.length < 2) return idx.length;
    q[idx[0]].content = idx.map((i) => q[i].content).join('\n\n');
    const drop = new Set(idx.slice(1));
    queues.set(sessionId, q.filter((_, i) => !drop.has(i)));
    return 1;
  }

  /** User pressed stop: forget everything pending for this session. */
  function abort(sessionId, reason) {
    const pending = queues.get(sessionId)?.length ?? 0;
    queues.delete(sessionId);
    running.delete(sessionId);
    clearTimer(sessionId);
    clearHeartbeat(sessionId);
    if (pending > 0) {
      logger.info({ sessionId, pending, reason }, 'dispatch: queue discarded on abort');
      sessionsStore
        .appendMessage(sessionId, {
          role: 'assistant',
          content: `⏹ **중단됨** — 대기 중이던 메시지 ${pending}건도 함께 취소했습니다.`
        })
        .catch(() => {});
    }
    return pending;
  }

  function clearAll() {
    for (const t of timers.values()) clearTimeout(t);
    for (const t of heartbeats.values()) clearTimeout(t);
    timers.clear();
    heartbeats.clear();
    queues.clear();
    running.clear();
  }

  return {
    dispatch,
    isSessionBusy,
    countUserItems,
    removeUserItem,
    mergeUserItems,
    abortDispatch: abort,
    clearAllDispatch: clearAll
  };
}
