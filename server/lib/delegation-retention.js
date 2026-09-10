import { logger } from './logger.js';

/**
 * Delegation retention: 오래된 위임 워커 세션을 주기적으로 정리한다.
 *
 * 위임이 한 번 돌 때마다 `[위임] ...` 제목의 워커 세션이 하나씩 새로 생긴다.
 * 결과는 이미 플래너에게 회신되고 전문은 delegation-reports/ 에 남으므로,
 * 완료된 지 오래된 워커 세션은 sessions 목록에 쌓이기만 한다.
 *
 * 삭제 조건 (전부 만족해야 함):
 *   1. title 이 '[위임]' 으로 시작
 *   2. delegationTracker 에서 해당 세션이 active(=회신 대기) 상태가 아님
 *   3. 이 세션이 origin 이 되어 굴리고 있는 하위 위임도 없음
 *   4. runner 가 지금 돌리고 있지 않음
 *   5. updatedAt 이 retentionDays 를 넘김
 *
 * 하나라도 판단이 애매하면(updatedAt 파싱 실패 등) 남긴다 — 실행 중이거나
 * 아직 회신하지 않은 세션을 지우면 플래너가 영원히 기다리게 되기 때문에
 * 정리 실패보다 오삭제가 훨씬 비싸다.
 *
 * @param {object} opts
 * @param {object} opts.sessionsStore
 * @param {object} opts.delegationTracker
 * @param {object} [opts.runner]           isRunning(sessionId) 제공 시 실행 중 세션 보호
 * @param {number} opts.retentionDays      0 이면 기능 끄기
 * @param {boolean} [opts.dryRun]          true 면 삭제 없이 대상 수만 로깅 (기본 true)
 * @param {number} [opts.intervalMs]       정리 주기 (기본 6h)
 * @param {() => number} [opts.now]        테스트용 시계 주입
 */
export function createDelegationRetention({
  sessionsStore,
  delegationTracker,
  runner = null,
  retentionDays,
  dryRun = true,
  intervalMs = 6 * 60 * 60 * 1000,
  now = () => Date.now()
}) {
  const days = Number(retentionDays) || 0;
  let timer = null;

  function isProtected(session, activeTargets) {
    if (activeTargets.has(session.id)) return 'awaiting-report';
    if (delegationTracker?.hasActiveByOrigin?.(session.id)) return 'has-active-subdelegation';
    if (runner?.isRunning?.(session.id)) return 'running';
    return null;
  }

  function collectCandidates() {
    const cutoff = now() - days * 24 * 60 * 60 * 1000;
    const activeTargets = new Set(
      (delegationTracker?.list?.() ?? []).map((e) => e.targetSessionId)
    );
    const candidates = [];
    let protectedCount = 0;

    for (const session of sessionsStore.list(null, { includeArchived: true })) {
      if (!String(session?.title ?? '').startsWith('[위임]')) continue;
      if (isProtected(session, activeTargets)) { protectedCount++; continue; }
      const updatedAt = Date.parse(session.updatedAt ?? '');
      if (!Number.isFinite(updatedAt)) continue;
      if (updatedAt >= cutoff) continue;
      candidates.push(session);
    }
    return { candidates, protectedCount };
  }

  async function runOnce() {
    if (days <= 0) return { deleted: 0, candidates: 0, protected: 0, dryRun, disabled: true };

    const { candidates, protectedCount } = collectCandidates();
    if (candidates.length === 0) {
      return { deleted: 0, candidates: 0, protected: protectedCount, dryRun, disabled: false };
    }

    if (dryRun) {
      logger.info(
        { candidates: candidates.length, protected: protectedCount, retentionDays: days },
        'delegation-retention: dry-run — would delete expired delegation sessions'
      );
      return { deleted: 0, candidates: candidates.length, protected: protectedCount, dryRun: true, disabled: false };
    }

    let deleted = 0;
    for (const session of candidates) {
      try {
        await sessionsStore.remove(session.id);
        deleted++;
      } catch (err) {
        logger.warn({ err: err.message, sessionId: session.id }, 'delegation-retention: remove failed');
      }
    }
    logger.info(
      { deleted, candidates: candidates.length, protected: protectedCount, retentionDays: days },
      'delegation-retention: removed expired delegation sessions'
    );
    return { deleted, candidates: candidates.length, protected: protectedCount, dryRun: false, disabled: false };
  }

  return {
    start() {
      if (days <= 0) {
        logger.info('delegation-retention: disabled (retentionDays=0)');
        return;
      }
      setTimeout(() => {
        runOnce().catch((err) => logger.error({ err }, 'delegation-retention: initial run failed'));
      }, 60_000).unref?.();
      timer = setInterval(() => {
        runOnce().catch((err) => logger.error({ err }, 'delegation-retention: cycle failed'));
      }, intervalMs);
      timer.unref?.();
      logger.info({ retentionDays: days, dryRun, intervalMs }, 'delegation-retention: started');
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce
  };
}
