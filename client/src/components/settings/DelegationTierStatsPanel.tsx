import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * 티어를 나눈 효과가 실제로 있는지 보는 최소 패널: 티어별 위임 건수·
 * 에스컬레이션(티어 오버라이드) 비율·토큰 소비. 60초 폴링 — 위임 빈도에
 * 비해 실시간성이 중요하지 않다.
 */
export function DelegationTierStatsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['delegation-tier-stats'],
    queryFn: () => api.delegationTierStats().catch(() => null),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false
  });

  if (isLoading) return null;
  if (!data || data.totals.delegationCount === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-zinc-300">티어별 위임 통계</div>
        <div className="text-[11px] text-zinc-500">
          전체 {data.totals.delegationCount}건 · 에스컬레이션 {(data.totals.escalationRate * 100).toFixed(0)}%
        </div>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-zinc-500 text-[10px] uppercase tracking-wider">
            <th className="text-left font-normal pb-1">티어</th>
            <th className="text-right font-normal pb-1">위임 건수</th>
            <th className="text-right font-normal pb-1" title="위임 JSON 이 티어를 명시적으로 지정한 건수">티어 지정</th>
            <th className="text-right font-normal pb-1" title="워커가 <escalate> 를 남기고 완료된 건수 — 이 티어로 모자랐다는 실제 신호">에스컬레이션</th>
            <th className="text-right font-normal pb-1">토큰</th>
          </tr>
        </thead>
        <tbody>
          {data.tiers.map((row) => (
            <tr key={row.tier} className="border-t border-zinc-800/60">
              <td className="py-1.5 font-mono text-zinc-300">{row.tier}</td>
              <td className="py-1.5 text-right text-zinc-300">{row.delegationCount}</td>
              <td className="py-1.5 text-right text-zinc-400">{row.tierSpecifiedCount}</td>
              <td className="py-1.5 text-right text-zinc-400">
                {row.escalatedCount} ({(row.escalationRate * 100).toFixed(0)}%)
              </td>
              <td className="py-1.5 text-right font-mono text-zinc-400">{fmtTokens(row.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
