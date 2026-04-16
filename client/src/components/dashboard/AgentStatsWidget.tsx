import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(ts: string | null): string {
  if (!ts) return '-';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

export default function AgentStatsWidget() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['agent-stats'],
    queryFn: () => api.agentStats(),
    refetchInterval: 30_000,
  });

  const agents = data?.agents ?? [];
  const maxTokens = agents.length > 0
    ? Math.max(...agents.map((a) => a.totalInputTokens + a.totalOutputTokens), 1)
    : 1;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
        <BarChart3 size={14} className="text-zinc-500" />
        <div className="text-sm font-semibold text-zinc-300">{t('agentStats.title')}</div>
        <div className="ml-auto text-xs text-zinc-600">{agents.length}</div>
      </div>
      <div className="max-h-[400px] overflow-y-auto">
        {agents.length === 0 ? (
          <div className="text-sm text-zinc-600 italic text-center py-8">
            {t('agentStats.empty')}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800/60">
                <th className="text-left px-3 py-2 font-medium">{t('agentStats.colAgent')}</th>
                <th className="text-right px-3 py-2 font-medium">{t('agentStats.colSessions')}</th>
                <th className="text-right px-3 py-2 font-medium">{t('agentStats.colMsgs')}</th>
                <th className="text-left px-3 py-2 font-medium min-w-[120px]">{t('agentStats.colTokens')}</th>
                <th className="text-right px-3 py-2 font-medium">{t('agentStats.colLast')}</th>
              </tr>
            </thead>
            <tbody>
              {agents.slice(0, 20).map((a) => {
                const total = a.totalInputTokens + a.totalOutputTokens;
                const pct = (total / maxTokens) * 100;
                return (
                  <tr key={a.id} className="border-b border-zinc-800/30 hover:bg-zinc-900/40">
                    <td className="px-3 py-1.5 text-zinc-300 truncate max-w-[140px]" title={a.id}>
                      {a.name}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-400 font-mono">
                      {a.sessionCount}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-400 font-mono">
                      {a.messageCount}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-600/70 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-zinc-500 font-mono text-[11px] w-12 text-right shrink-0">
                          {formatTokens(total)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-500 font-mono">
                      {timeAgo(a.lastActive)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
