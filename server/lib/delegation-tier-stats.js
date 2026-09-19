/**
 * Aggregates delegationTracker entries by tier so the effect of tiering can be
 * read as numbers: how many delegations ran at each tier, how often the
 * planner explicitly requested a tier vs. how often a worker actually got
 * stuck and escalated (two different axes — see field notes below), and how
 * many tokens each tier actually burned.
 */

const UNKNOWN_TIER = 'unknown';

function sumSessionTokens(session) {
  if (!Array.isArray(session?.messages)) return 0;
  let total = 0;
  for (const m of session.messages) {
    total += (m?.usage?.inputTokens ?? 0) + (m?.usage?.outputTokens ?? 0);
  }
  return total;
}

/**
 * @param {object} deps
 * @param {import('./delegation-tracker.js').ReturnType} deps.delegationTracker
 * @param {{ get(id: string): object | null }} deps.sessionsStore
 * @param {number} [deps.historyLimit] - how far back into finished delegations to look (capped at the tracker's own 300-entry ring buffer)
 */
export function computeDelegationTierStats({ delegationTracker, sessionsStore, historyLimit = 300 }) {
  const entries = [...delegationTracker.list(), ...delegationTracker.listRecent(historyLimit)];

  const perTier = new Map();
  function bucket(tier) {
    const key = tier || UNKNOWN_TIER;
    if (!perTier.has(key)) {
      perTier.set(key, {
        tier: key,
        delegationCount: 0,
        escalatedCount: 0,
        tierSpecifiedCount: 0,
        totalTokens: 0,
        _seenSessions: new Set()
      });
    }
    return perTier.get(key);
  }

  for (const entry of entries) {
    const b = bucket(entry.tier);
    b.delegationCount += 1;
    // tierOverridden = 위임 JSON 이 티어를 "지정"했는가. 상위 티어를 요청했다는
    // 뜻일 뿐, 실제로 그 티어가 막혀서 <escalate> 를 남겼는지와는 다른 축이다.
    if (entry.tierOverridden) b.tierSpecifiedCount += 1;
    // escalated = 워커가 <escalate> 를 남기고 완료된 위임인가 (tracker 가
    // 완료 시점에 기록). 이것만이 "이 티어로는 모자랐다" 는 실제 신호다.
    if (entry.escalated) b.escalatedCount += 1;

    // A resumed worker session keeps the same tier for its whole life (tier
    // changes require a fresh session), so a session's tokens belong to one
    // tier bucket — dedupe by session id to avoid recounting on every
    // delegation that reused it.
    if (entry.targetSessionId && !b._seenSessions.has(entry.targetSessionId)) {
      b._seenSessions.add(entry.targetSessionId);
      b.totalTokens += sumSessionTokens(sessionsStore.get(entry.targetSessionId));
    }
  }

  const tiers = [...perTier.values()]
    .map(({ tier, delegationCount, escalatedCount, tierSpecifiedCount, totalTokens }) => ({
      tier,
      delegationCount,
      escalatedCount,
      escalationRate: delegationCount > 0 ? escalatedCount / delegationCount : 0,
      tierSpecifiedCount,
      totalTokens
    }))
    .sort((a, b) => b.delegationCount - a.delegationCount);

  const totals = tiers.reduce(
    (acc, t) => ({
      delegationCount: acc.delegationCount + t.delegationCount,
      escalatedCount: acc.escalatedCount + t.escalatedCount,
      tierSpecifiedCount: acc.tierSpecifiedCount + t.tierSpecifiedCount,
      totalTokens: acc.totalTokens + t.totalTokens
    }),
    { delegationCount: 0, escalatedCount: 0, tierSpecifiedCount: 0, totalTokens: 0 }
  );

  return {
    tiers,
    totals: {
      ...totals,
      escalationRate: totals.delegationCount > 0 ? totals.escalatedCount / totals.delegationCount : 0
    }
  };
}
