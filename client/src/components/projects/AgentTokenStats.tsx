import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { Agent } from '../../lib/types';

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function AgentTokenStats({ agents }: { agents: Agent[] }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['agent-stats'],
    queryFn: () => api.agentStats(),
    refetchInterval: 30_000,
  });

  const agentIds = new Set(agents.map(a => a.id));
  const stats = (data?.agents ?? []).filter((s: { id: string }) => agentIds.has(s.id));

  if (stats.length === 0) return null;

  const maxTokens = Math.max(...stats.map((s: { totalInputTokens: number; totalOutputTokens: number }) =>
    s.totalInputTokens + s.totalOutputTokens), 1);
  const totalIn = stats.reduce((s: number, a: { totalInputTokens: number }) => s + a.totalInputTokens, 0);
  const totalOut = stats.reduce((s: number, a: { totalOutputTokens: number }) => s + a.totalOutputTokens, 0);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <BarChart3 size={12} className="text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-300">{t('projects.tokenUsage')}</span>
        <span className="text-[11px] text-zinc-500 font-mono ml-auto">
          ↑{fmt(totalIn)} ↓{fmt(totalOut)}
        </span>
      </div>
      <div className="p-3 space-y-2">
        {stats.map((s: { id: string; name: string; totalInputTokens: number; totalOutputTokens: number; sessionCount: number; messageCount: number }) => {
          const total = s.totalInputTokens + s.totalOutputTokens;
          const pct = (total / maxTokens) * 100;
          const agent = agents.find(a => a.id === s.id);
          return (
            <div key={s.id} className="flex items-center gap-2">
              <span className="text-xs shrink-0">{agent?.avatar ?? '🤖'}</span>
              <span className="text-[11px] text-zinc-400 w-20 truncate shrink-0">{s.name}</span>
              <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-600/70 rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-[10px] text-zinc-500 font-mono w-14 text-right shrink-0">
                {fmt(total)}
              </span>
              <span className="text-[10px] text-zinc-600 font-mono w-8 text-right shrink-0">
                {s.sessionCount}s
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
