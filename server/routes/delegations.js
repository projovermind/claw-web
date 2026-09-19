import { Router } from 'express';
import { computeDelegationTierStats } from '../lib/delegation-tier-stats.js';

/** 완료 이력 응답 기본 개수 — 이력은 링버퍼(300)라 그 이상은 의미가 없다. */
const DEFAULT_RECENT = 50;
const MAX_RECENT = 300;

/** 텔레메트리 필드만 뽑아 쓰기 좋게 정리한다. task 본문은 목록에서 제외. */
function toTelemetry(entry) {
  return {
    id: entry.id,
    originSessionId: entry.originSessionId,
    targetSessionId: entry.targetSessionId,
    targetAgentId: entry.targetAgentId,
    groupId: entry.groupId ?? null,
    depth: entry.depth ?? null,
    status: entry.status,
    queuedAt: entry.queuedAt ?? entry.createdAt ?? null,
    startedAt: entry.startedAt ?? entry.createdAt ?? null,
    completedAt: entry.completedAt ?? null,
    queueMs: entry.queueMs ?? null,
    durationMs: entry.durationMs ?? null
  };
}

export function createDelegationsRouter({ delegationTracker, sessionsStore }) {
  const router = Router();
  router.get('/', (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(MAX_RECENT, Math.max(0, Math.floor(raw))) : DEFAULT_RECENT;
    // 실행 중인 위임에는 durationMs 가 아직 없다 — 소요시간을 보려면 완료 이력이
    // 같이 나와야 하므로 한 응답에 함께 싣는다.
    res.json({
      delegations: delegationTracker.list(),
      // limit=0 은 "이력 필요 없음". listRecent(0) 은 slice(-0) 이라 전체를 돌려주므로
      // 여기서 걸러야 한다.
      recent: limit > 0 ? delegationTracker.listRecent(limit).map(toTelemetry) : []
    });
  });

  // 티어별 위임 건수·에스컬레이션(티어 오버라이드) 비율·토큰 소비 — 티어를
  // 나눈 효과가 실제로 있는지 숫자로 보기 위한 집계.
  router.get('/tier-stats', (req, res) => {
    res.json(computeDelegationTierStats({ delegationTracker, sessionsStore }));
  });

  return router;
}
