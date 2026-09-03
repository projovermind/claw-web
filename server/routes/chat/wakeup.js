import { logger } from '../../lib/logger.js';

/** `<wakeup seconds=30>이유</wakeup>` — quotes around the number are tolerated. */
const WAKEUP_RE = /<wakeup\s+seconds\s*=\s*["']?(\d{1,5})["']?\s*>([\s\S]*?)<\/wakeup>/i;

const MAX_WAKEUPS = 20;
const MIN_SECONDS = 10;
const MAX_SECONDS = 3600;

/**
 * Safety net for turns that end in "I'll wait and let you know" without emitting
 * a marker. The session is non-interactive, so such a turn never resumes on its
 * own and the user is left waiting indefinitely. We only auto-schedule when the
 * text both declares a wait AND promises a follow-up — either cue alone is far
 * too common in ordinary prose.
 */
const TAIL_CHARS = 400;
const WAITING_RE = /기다리|기다려|대기\s*중|돌고\s*있|실행\s*중|진행\s*중|처리\s*중|완료되면|끝나면|나오면|는\s*대로/;
const FOLLOWUP_RE = /알려[드주]|보고[드하]|공유[드하]|이어서|계속하겠|진행하겠|확인하겠|붙이겠|올리겠|정리하겠|말씀드리/;
const AUTO_BASE_SECONDS = 180;

/**
 * 위임 보고가 오기를 기다리는 턴에 거는 폴백. 보고가 정상 도착하면 그 디스패치가
 * 예약을 취소하므로 평소엔 발화하지 않고, 워커가 통째로 사라졌을 때만 플래너를 깨운다.
 */
const DELEGATION_FALLBACK_SECONDS = 900;

function endsInDanglingWait(text) {
  const tail = text.slice(-TAIL_CHARS);
  return WAITING_RE.test(tail) && FOLLOWUP_RE.test(tail);
}

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
   * Who else is expected to wake this session.
   * - 'user': only a human reply can move it forward — never self-schedule.
   * - 'delegation': a worker report should arrive and will supersede any timer,
   *   but that report can be lost, so a long fallback is still armed.
   */
  function wokenByOthers(sessionId, text) {
    if (/<choices>/i.test(text)) return 'user';
    if (/"delegate"\s*:/.test(text)) return 'delegation';
    const running = ctx.delegationTracker
      ?.getByOrigin(sessionId)
      .some(d => d.status === 'running') ?? false;
    return running ? 'delegation' : null;
  }

  /**
   * Called after every assistant response. No marker and no dangling wait ends
   * the chain.
   */
  async function handleWakeup(sessionId, responseText) {
    const text = responseText ?? '';

    // Ralph Loop already drives its own re-entry — a wakeup on top would double-send.
    if (sessionsStore.get(sessionId)?.loop?.enabled) {
      chains.delete(sessionId);
      return;
    }

    const match = text.match(WAKEUP_RE);
    const prev = chains.get(sessionId) ?? { count: 0, recent: [], auto: 0 };

    let seconds;
    let reason;
    let auto;
    const waker = match ? null : wokenByOthers(sessionId, text);

    if (match) {
      seconds = Number(match[1]);
      reason = match[2].trim() || '이어서 작업 계속';
      auto = 0;
    } else if (endsInDanglingWait(text) && waker !== 'user') {
      // Back off harder each time the agent keeps ending on a bare promise.
      auto = prev.auto + 1;
      if (waker === 'delegation') {
        seconds = DELEGATION_FALLBACK_SECONDS;
        reason =
          '위임한 작업의 보고가 아직 도착하지 않았습니다. 위임 상태를 확인하고, 아직 진행 중이면 <wakeup seconds=900>위임 보고 확인</wakeup> 으로 다시 예약하세요. 워커가 죽은 것으로 보이면 직접 처리하거나 사용자에게 상황을 알리세요.';
        logger.info({ sessionId, auto }, 'wakeup: delegation report pending, arming fallback');
      } else {
        seconds = AUTO_BASE_SECONDS * 2 ** (auto - 1);
        reason =
          '직전 턴이 대기 선언으로 끝났습니다. 기다리던 작업의 상태를 확인하고 이어서 진행하세요. 아직 안 끝났으면 응답 끝에 <wakeup seconds=N>확인할 내용</wakeup> 마커를 직접 출력해 다시 예약하세요.';
        logger.info({ sessionId, auto }, 'wakeup: dangling wait detected, auto-scheduling');
      }
    } else {
      chains.delete(sessionId);
      return;
    }

    seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds));

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

    chains.set(sessionId, { count, recent, auto });
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
    eventBus.publish('session.wakeup.scheduled', { sessionId, seconds, count, reason, auto: auto > 0 });
    logger.info({ sessionId, seconds, count, auto }, 'wakeup: scheduled');
  }

  return { handleWakeup, cancelWakeup, clearAllWakeups };
}
