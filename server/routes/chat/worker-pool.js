import { logger } from '../../lib/logger.js';
import { sessionContextUsage } from '../../lib/context-window.js';

/**
 * 위임 워커 세션 재사용 풀.
 *
 * 위임 한 건마다 워커 세션을 새로 만들면 CLI 는 매번 fresh 세션을 연다 =
 * persona/skills/base/carl/pinned 재주입 + 워커가 코드베이스를 처음부터 재탐색.
 * 실측(36시간)에서 워커 세션은 전부 단발성(p50 2메시지)이었고 위임 300건이
 * 콜드스타트 300회가 됐다. snm_lead 한 명만 85번.
 *
 * 같은 originSession 이 같은 대상 에이전트에게 다시 위임하면 직전 워커 세션을
 * 그대로 재사용한다 — claudeSessionId 가 남아 있으므로 --resume 으로 붙고,
 * startRunner 의 isFirstMsg 가 false 가 되어 시스템 프롬프트 재주입도 없다.
 *
 * 무한 재사용은 반대 방향으로 비싸다(컨텍스트가 쌓여 압축 → 캐시 손실). 그래서
 * TTL·최대 재사용 횟수·컨텍스트 사용률 상한을 넘으면 새 세션으로 로테이션한다.
 *
 * 풀에 넣지 않는 것:
 *   - Ralph loop 위임 (세션에 loop 상태가 붙어 여러 턴을 스스로 굴린다)
 *   - claudeSessionId 가 없는 세션 (resume 대상이 없으니 재사용해도 콜드스타트)
 */

const DEFAULT_TTL_MIN = 90;
const DEFAULT_MAX_USES = 5;

/** 재사용 후보 세션의 컨텍스트 사용률 상한(%). 넘으면 새 세션으로 돌린다. */
const MAX_CONTEXT_PCT = 50;

/** 풀 크기 상한 — 프로세스 수명 내내 끝난 세션 ID 가 쌓이는 것을 막는다. */
const MAX_KEYS = 500;
const MAX_PER_KEY = 10;

/**
 * 재사용 세션에 새 작업을 넣을 때 앞에 붙이는 경계선.
 *
 * 막아야 하는 것은 "앞 작업의 결과를 다시 보고하는 것" 하나뿐이다. 예전 문구는
 * "이전 작업을 이어서 하지 마세요" 까지 금지해서, 리드가 같은 작업을 다시 맡기는
 * **재시도 위임**(에스컬레이션 후 재발주 등)이 오면 워커가 "이미 했다" 고 답하고
 * 끝내 버렸다 — 재시도 지시가 프롬프트에 의해 무효화되는 상태였다.
 */
export const REUSE_TASK_PREFIX =
  '[새 지시 — 앞의 작업은 이미 끝나 보고됐습니다. 이전 맥락(코드베이스 구조 등)은 참고만 하고, ' +
  '앞 작업의 결과를 다시 보고하지 마세요. 아래 지시만 수행하세요. ' +
  '아래가 앞과 같은 작업이면 재시도 지시입니다 — "이미 했습니다" 로 끝내지 말고 다시 수행하세요.]';

export function createWorkerPool(ctx) {
  /** `${originSessionId}::${agentId}::${tier}` → [{ sessionId, uses, lastUsedAt }] (LRU 순서) */
  const pool = new Map();
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

  function settings() {
    const chat = ctx.webConfig?.chat ?? {};
    const ttlMin = Number(chat.delegationReuseTtlMin);
    const maxUses = Number(chat.delegationReuseMaxUses);
    return {
      enabled: chat.delegationReuse !== false,
      ttlMs: (Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : DEFAULT_TTL_MIN) * 60_000,
      maxUses: Number.isFinite(maxUses) && maxUses >= 1 ? Math.floor(maxUses) : DEFAULT_MAX_USES
    };
  }

  /**
   * 티어까지 키에 넣는다. 빼면 상위 티어로 다시 맡긴 작업이 **하위 티어로 돌던
   * 그 세션을 resume** 해 버린다 — CLI 세션은 열릴 때의 모델을 이어 쓰므로 급이
   * 올라가지 않고, 약한 모델이 쌓아 둔 실패 맥락까지 그대로 물려받는다.
   *
   * tier 는 '실제로 돌아간 급'(위임 지정 ?? 에이전트 기본)이어야 한다. 그래야
   * 티어를 생략한 위임과 같은 급을 명시한 위임이 한 세션을 나눠 쓴다.
   */
  function keyOf(originSessionId, targetAgentId, tier = null) {
    return `${originSessionId}::${targetAgentId}::${tier ?? '-'}`;
  }

  /** 최근 쓴 키를 뒤로 보내 LRU 순서를 유지한다(Map 은 삽입 순서를 지킨다). */
  function touch(key, entries) {
    pool.delete(key);
    pool.set(key, entries);
    while (pool.size > MAX_KEYS) {
      const oldest = pool.keys().next().value;
      pool.delete(oldest);
    }
  }

  /**
   * 재사용 불가 사유. null 이면 재사용 가능.
   * 'busy'/'delegation-active' 는 지금만 안 되는 것이라 풀에 남기고,
   * 나머지는 앞으로도 안 되므로 호출자가 풀에서 버린다.
   */
  function blockReason(entry, cfg) {
    const session = ctx.sessionsStore?.get(entry.sessionId);
    if (!session) return 'session-gone';
    if (session.archived) return 'archived';
    if (!session.claudeSessionId) return 'no-resume-target';
    if (session.loop?.enabled) return 'loop-session';
    if (entry.uses >= cfg.maxUses) return 'max-uses';
    if (now() - entry.lastUsedAt > cfg.ttlMs) return 'ttl-expired';
    if (ctx.delegationTracker?.getByTarget?.(entry.sessionId)) return 'delegation-active';
    if (ctx.isSessionBusy?.(entry.sessionId)) return 'busy';
    const usage = sessionContextUsage(session);
    if (usage && usage.pct >= MAX_CONTEXT_PCT) return 'context-heavy';
    return null;
  }

  const TRANSIENT = new Set(['busy', 'delegation-active']);

  /**
   * 재사용할 워커 세션을 하나 꺼낸다. 없으면 null — 호출자가 새로 만든 뒤
   * registerWorkerSession 으로 풀에 넣는다.
   *
   * @returns {{session: object, uses: number}|null}
   */
  function acquireWorkerSession(originSessionId, targetAgentId, tier = null) {
    const cfg = settings();
    if (!cfg.enabled) return null;
    const key = keyOf(originSessionId, targetAgentId, tier);
    const entries = pool.get(key);
    if (!entries?.length) return null;

    let picked = null;
    const kept = [];
    for (const entry of entries) {
      if (picked) { kept.push(entry); continue; }
      const reason = blockReason(entry, cfg);
      if (!reason) { picked = entry; kept.push(entry); continue; }
      if (TRANSIENT.has(reason)) { kept.push(entry); continue; }
      logger.debug(
        { sessionId: entry.sessionId, targetAgentId, tier, uses: entry.uses, reason },
        'worker-pool: dropped candidate'
      );
    }

    if (kept.length) touch(key, kept);
    else pool.delete(key);
    if (!picked) return null;

    picked.uses += 1;
    picked.lastUsedAt = now();
    const session = ctx.sessionsStore.get(picked.sessionId);
    // get() 이 방금 성공했던 세션이라 여기서 사라질 일은 사실상 없지만,
    // 비어 있는 세션을 반환하면 호출자가 그대로 dispatch 해 버린다.
    if (!session) return null;
    return { session, uses: picked.uses };
  }

  /** 새로 만든 워커 세션을 재사용 후보로 등록한다. tier 는 이 세션이 돌아간 급. */
  function registerWorkerSession(originSessionId, targetAgentId, sessionId, tier = null) {
    const cfg = settings();
    if (!cfg.enabled) return;
    const key = keyOf(originSessionId, targetAgentId, tier);
    const entries = pool.get(key) ?? [];
    entries.push({ sessionId, uses: 1, lastUsedAt: now() });
    while (entries.length > MAX_PER_KEY) entries.shift();
    touch(key, entries);
  }

  /**
   * 워커가 작업을 정상으로 끝낸 시각으로 TTL 시계를 다시 맞춘다.
   *
   * lastUsedAt 을 '위임을 보낸 시각' 에만 찍으면 TTL 이 재는 것은 유휴 시간이
   * 아니라 '작업 시간 + 유휴 시간' 이 된다. 실측 durationMs 는 p50 10.2분 /
   * max 67.5분이라 오래 도는 워커는 일을 끝내기도 전에 만료됐다(재기동 후
   * 위임 8건 전부 reused:0). TTL 은 놀고 있던 시간만 재야 한다.
   */
  function releaseWorkerSession(sessionId) {
    const at = now();
    for (const entries of pool.values()) {
      for (const entry of entries) {
        if (entry.sessionId === sessionId) entry.lastUsedAt = at;
      }
    }
  }

  /**
   * 워커 세션을 풀에서 제거한다. 중단·크래시로 끝난 세션은 CLI 세션 파일이
   * 깨졌을 수 있어 재사용 대상에서 빼야 한다.
   */
  function forgetWorkerSession(sessionId) {
    for (const [key, entries] of pool) {
      const next = entries.filter((e) => e.sessionId !== sessionId);
      if (next.length === entries.length) continue;
      if (next.length) pool.set(key, next);
      else pool.delete(key);
    }
  }

  /** 테스트/디버그용 스냅샷. */
  function workerPoolStats() {
    return {
      keys: pool.size,
      sessions: [...pool.values()].reduce((n, list) => n + list.length, 0)
    };
  }

  return {
    acquireWorkerSession,
    registerWorkerSession,
    releaseWorkerSession,
    forgetWorkerSession,
    workerPoolStats
  };
}
