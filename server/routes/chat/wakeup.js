import { logger } from '../../lib/logger.js';

/** `<wakeup seconds=30>이유</wakeup>` — quotes around the number are tolerated. */
const WAKEUP_RE = /<wakeup\s+seconds\s*=\s*["']?(\d{1,5})["']?\s*>([\s\S]*?)<\/wakeup>/i;

const MAX_WAKEUPS = 20;
const MIN_SECONDS = 10;
const MAX_SECONDS = 3600;

/**
 * Session auto-resume. When an assistant response contains a `<wakeup>` marker,
 * schedule a self-injected `[자동 재개]` turn after the requested delay.
 */
export function createWakeup(ctx) {
  const { sessionsStore, eventBus } = ctx;

  // sessionId → NodeJS.Timeout
  const timers = new Map();
  // sessionId → { count, recent: string[] }
  const chains = new Map();
  // sessionId → epoch; bumped on cancel so an in-flight fire() aborts itself
  const epochs = new Map();

  function cancelWakeup(sessionId, reason) {
    const timer = timers.get(sessionId);
    epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
    if (!timer && !chains.has(sessionId)) return false;
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
    chains.delete(sessionId);
    if (timer) logger.info({ sessionId, reason }, 'wakeup: cancelled');
    return !!timer;
  }

  function clearAllWakeups() {
    for (const timer of timers.values()) clearTimeout(timer);
    const count = timers.size;
    timers.clear();
    chains.clear();
    if (count > 0) logger.info({ count }, 'wakeup: all timers cleared');
  }

  /** Two responses count as "no progress" when length and opening text barely move. */
  function similar(a, b) {
    const maxLen = Math.max(a.length, b.length, 1);
    return Math.abs(a.length - b.length) / maxLen <= 0.1 && a.slice(0, 200) === b.slice(0, 200);
  }

  function isStagnated(recent) {
    if (recent.length < 3) return false;
    const [r1, r2, r3] = recent;
    return similar(r1, r2) && similar(r2, r3);
  }

  async function stop(sessionId, note) {
    chains.delete(sessionId);
    await sessionsStore.appendMessage(sessionId, { role: 'assistant', content: note }).catch(() => {});
  }

  async function fire(sessionId, reason, count, epoch) {
    if ((epochs.get(sessionId) ?? 0) !== epoch) return;
    if (!sessionsStore.get(sessionId)) {
      chains.delete(sessionId);
      return;
    }
    const trigger = `[자동 재개] ${reason}`;
    try {
      await sessionsStore.appendMessage(sessionId, { role: 'user', content: trigger });
      // The epoch guard is re-checked at dequeue time: a wakeup that waited
      // behind a running turn must not fire if the user intervened meanwhile.
      ctx.dispatch(sessionId, {
        kind: 'wakeup',
        content: trigger,
        guard: () => (epochs.get(sessionId) ?? 0) === epoch
      });
      eventBus.publish('session.wakeup.fired', { sessionId, count, reason });
      logger.info({ sessionId, count, reason }, 'wakeup: fired');
    } catch (err) {
      eventBus.publish('chat.error', { sessionId, error: `Wakeup failed: ${err.message}` });
    }
  }

  /**
   * Called after every assistant response. No marker ends the chain.
   */
  async function handleWakeup(sessionId, responseText) {
    const text = responseText ?? '';
    const match = text.match(WAKEUP_RE);
    if (!match) {
      chains.delete(sessionId);
      return;
    }

    // Ralph Loop already drives its own re-entry — a wakeup on top would double-send.
    if (sessionsStore.get(sessionId)?.loop?.enabled) return;

    const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(match[1])));
    const reason = match[2].trim() || '이어서 작업 계속';

    const prev = chains.get(sessionId) ?? { count: 0, recent: [] };
    const count = prev.count + 1;
    const recent = [...prev.recent, text].slice(-3);

    if (count > MAX_WAKEUPS) {
      await stop(sessionId, `⚠️ **자동 재개 한계 도달** (${MAX_WAKEUPS}회) — 무한 루프 방지를 위해 중단합니다. 다음 단계를 직접 지시해 주세요.`);
      eventBus.publish('session.wakeup.stopped', { sessionId, reason: 'max_wakeups' });
      logger.warn({ sessionId, count }, 'wakeup: limit exceeded');
      return;
    }
    if (isStagnated(recent)) {
      await stop(sessionId, `⚠️ **자동 재개 중단** — 최근 응답에 진전이 없어 반복을 멈췄습니다 (${count}회). 다음 단계를 직접 지시해 주세요.`);
      eventBus.publish('session.wakeup.stopped', { sessionId, reason: 'stagnated' });
      logger.warn({ sessionId, count }, 'wakeup: stagnation detected');
      return;
    }

    chains.set(sessionId, { count, recent });
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    const epoch = epochs.get(sessionId) ?? 0;
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        fire(sessionId, reason, count, epoch);
      }, seconds * 1000)
    );
    eventBus.publish('session.wakeup.scheduled', { sessionId, seconds, count, reason });
    logger.info({ sessionId, seconds, count }, 'wakeup: scheduled');
  }

  return { handleWakeup, cancelWakeup, clearAllWakeups };
}
