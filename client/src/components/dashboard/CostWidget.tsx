import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DollarSign } from 'lucide-react';
import { api } from '../../lib/api';
import type { Agent } from '../../lib/types';

/** $0.00 / $12.34 — 소액도 0 으로 뭉개지지 않게 4자리까지 내려감. */
function formatUsd(n: number): string {
  if (!isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

/** 최근 14일치 날짜 키(YYYY-MM-DD) — 로컬 시간대 기준, 오래된 날짜부터. */
function last14Days(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(key);
  }
  return out;
}

export default function CostWidget() {
  const { data: usage } = useQuery({
    queryKey: ['usage-stats'],
    queryFn: () => api.usageStats(),
    refetchInterval: 60_000,
  });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });

  const cost = usage?.cost;

  const topAgents = useMemo(() => {
    if (!cost) return [];
    const nameById = new Map<string, string>(((agents ?? []) as Agent[]).map((a) => [a.id, a.name]));
    return Object.entries(cost.byAgent ?? {})
      .filter(([, usd]) => usd > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, usd]) => ({ id, name: nameById.get(id) ?? id, usd }));
  }, [cost, agents]);

  const days = useMemo(() => {
    const byDay = cost?.byDay ?? {};
    return last14Days().map((key) => ({ key, usd: byDay[key] ?? 0 }));
  }, [cost]);

  // 서버가 아직 cost 를 안 보내거나(구버전) 전부 0 이면 안내만 표시
  const hasData =
    !!cost &&
    (cost.window7d > 0 || cost.window30d > 0 || days.some((d) => d.usd > 0) || topAgents.length > 0);

  const maxDay = Math.max(...days.map((d) => d.usd), 0);
  const maxAgent = Math.max(...topAgents.map((a) => a.usd), 0);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
        <DollarSign size={14} className="text-emerald-400" />
        <div className="text-sm font-semibold text-zinc-300">비용</div>
        <div className="ml-auto text-xs text-zinc-600">USD</div>
      </div>

      {!hasData ? (
        <div className="text-sm text-zinc-600 italic text-center py-8 px-4">
          비용 데이터 수집 전
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {/* 7일 / 30일 합계 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">7일</div>
              <div className="text-lg font-semibold text-emerald-300 font-mono">
                {formatUsd(cost!.window7d ?? 0)}
              </div>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">30일</div>
              <div className="text-lg font-semibold text-zinc-200 font-mono">
                {formatUsd(cost!.window30d ?? 0)}
              </div>
            </div>
          </div>

          {/* 일별 막대 (최근 14일) */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
              일별 &middot; 최근 14일
            </div>
            <div className="flex items-end gap-1 h-20">
              {days.map((d) => {
                const pct = maxDay > 0 ? (d.usd / maxDay) * 100 : 0;
                return (
                  <div
                    key={d.key}
                    className="flex-1 h-full flex items-end"
                    title={`${d.key} · ${formatUsd(d.usd)}`}
                  >
                    <div
                      className={`w-full rounded-t ${d.usd > 0 ? 'bg-emerald-600/70' : 'bg-zinc-800'}`}
                      style={{ height: `${Math.max(pct, d.usd > 0 ? 4 : 2)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-zinc-600 font-mono mt-1">
              <span>{days[0]?.key.slice(5)}</span>
              <span>{days[days.length - 1]?.key.slice(5)}</span>
            </div>
          </div>

          {/* 에이전트별 상위 5 */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
              에이전트 상위 5
            </div>
            {topAgents.length === 0 ? (
              <div className="text-[11px] text-zinc-600 italic py-2">에이전트별 비용 없음</div>
            ) : (
              <div className="space-y-1.5">
                {topAgents.map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-400 w-24 truncate shrink-0" title={a.id}>
                      {a.name}
                    </span>
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-600/70"
                        style={{ width: `${maxAgent > 0 ? (a.usd / maxAgent) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-zinc-400 font-mono w-14 text-right shrink-0">
                      {formatUsd(a.usd)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
