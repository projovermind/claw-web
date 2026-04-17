import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, ChevronRight, ChevronDown } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { Agent, Project } from '../../lib/types';

interface AgentStat {
  id: string;
  name: string;
  sessionCount: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActive: string | null;
}

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: statsData } = useQuery({
    queryKey: ['agent-stats'],
    queryFn: () => api.agentStats(),
    refetchInterval: 30_000,
  });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  // 프로젝트별 집계
  const projectGroups = useMemo(() => {
    const allStats: AgentStat[] = statsData?.agents ?? [];
    const agentList: Agent[] = agents ?? [];
    const projectList: Project[] = projects ?? [];

    // 에이전트 ID → projectId 매핑
    const agentProject = new Map<string, string | null>();
    for (const a of agentList) {
      agentProject.set(a.id, (a as Agent & { projectId?: string }).projectId ?? null);
    }

    // 프로젝트별 그룹
    const groups: Record<string, { project: Project | null; agents: AgentStat[]; totalTokens: number; totalSessions: number; lastActive: string | null }> = {};
    const unassigned: AgentStat[] = [];

    for (const stat of allStats) {
      const pid = agentProject.get(stat.id);
      if (pid) {
        if (!groups[pid]) {
          const p = projectList.find(x => x.id === pid);
          groups[pid] = { project: p ?? null, agents: [], totalTokens: 0, totalSessions: 0, lastActive: null };
        }
        groups[pid].agents.push(stat);
        groups[pid].totalTokens += stat.totalInputTokens + stat.totalOutputTokens;
        groups[pid].totalSessions += stat.sessionCount;
        if (stat.lastActive && (!groups[pid].lastActive || stat.lastActive > groups[pid].lastActive!)) {
          groups[pid].lastActive = stat.lastActive;
        }
      } else {
        unassigned.push(stat);
      }
    }

    // 정렬 (토큰 많은 순)
    const sorted = Object.entries(groups)
      .map(([pid, g]) => ({ pid, ...g }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    return { groups: sorted, unassigned };
  }, [statsData, agents, projects]);

  const toggle = (pid: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  const maxTokens = Math.max(...projectGroups.groups.map(g => g.totalTokens), 1);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
        <BarChart3 size={14} className="text-zinc-500" />
        <div className="text-sm font-semibold text-zinc-300">{t('agentStats.title')}</div>
        <div className="ml-auto text-xs text-zinc-600">{projectGroups.groups.length} projects</div>
      </div>
      <div className="max-h-[500px] overflow-y-auto">
        {projectGroups.groups.length === 0 && projectGroups.unassigned.length === 0 ? (
          <div className="text-sm text-zinc-600 italic text-center py-8">
            {t('agentStats.empty')}
          </div>
        ) : (
          <div>
            {projectGroups.groups.map(g => {
              const isOpen = expanded.has(g.pid);
              const pct = (g.totalTokens / maxTokens) * 100;
              return (
                <div key={g.pid} className="border-b border-zinc-800/60 last:border-0">
                  {/* 프로젝트 헤더 */}
                  <button
                    onClick={() => toggle(g.pid)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-900/40 transition-colors"
                  >
                    {isOpen ? <ChevronDown size={12} className="text-zinc-500 shrink-0" /> : <ChevronRight size={12} className="text-zinc-500 shrink-0" />}
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: g.project?.color ?? '#666' }} />
                    <span className="text-xs font-semibold text-zinc-300 truncate flex-1 text-left">
                      {g.project?.name ?? g.pid}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">{g.agents.length} agents</span>
                    <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-600/70" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[11px] text-zinc-400 font-mono w-14 text-right">{formatTokens(g.totalTokens)}</span>
                    <span className="text-[10px] text-zinc-500 font-mono w-10 text-right">{timeAgo(g.lastActive)}</span>
                  </button>

                  {/* 확장 시 에이전트 리스트 */}
                  {isOpen && (
                    <div className="bg-zinc-900/30 px-3 py-1.5">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {g.agents
                            .sort((a, b) => (b.totalInputTokens + b.totalOutputTokens) - (a.totalInputTokens + a.totalOutputTokens))
                            .map(a => {
                              const total = a.totalInputTokens + a.totalOutputTokens;
                              const agentPct = g.totalTokens > 0 ? (total / g.totalTokens) * 100 : 0;
                              return (
                                <tr key={a.id} className="border-t border-zinc-800/40 first:border-0">
                                  <td className="py-1 pl-4 text-zinc-400 truncate max-w-[140px]" title={a.id}>
                                    {a.name}
                                  </td>
                                  <td className="py-1 px-2 text-right text-zinc-500 font-mono w-10">
                                    {a.sessionCount}s
                                  </td>
                                  <td className="py-1 px-2 text-right text-zinc-500 font-mono w-10">
                                    {a.messageCount}m
                                  </td>
                                  <td className="py-1 px-2 min-w-[100px]">
                                    <div className="flex items-center gap-1.5">
                                      <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                                        <div className="h-full bg-sky-600/70" style={{ width: `${agentPct}%` }} />
                                      </div>
                                    </div>
                                  </td>
                                  <td className="py-1 pl-2 text-right text-zinc-500 font-mono w-12">
                                    {formatTokens(total)}
                                  </td>
                                  <td className="py-1 pl-2 text-right text-zinc-600 font-mono w-10">
                                    {timeAgo(a.lastActive)}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {/* 미배치 에이전트 */}
            {projectGroups.unassigned.length > 0 && (
              <div className="border-b border-zinc-800/60">
                <button
                  onClick={() => toggle('__unassigned__')}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-900/40"
                >
                  {expanded.has('__unassigned__') ? <ChevronDown size={12} className="text-zinc-500" /> : <ChevronRight size={12} className="text-zinc-500" />}
                  <div className="w-2 h-2 rounded-full bg-zinc-600" />
                  <span className="text-xs font-semibold text-zinc-400 flex-1 text-left">{t('stats.unassigned')}</span>
                  <span className="text-[10px] text-zinc-500">{projectGroups.unassigned.length} agents</span>
                </button>
                {expanded.has('__unassigned__') && (
                  <div className="bg-zinc-900/30 px-3 py-1.5">
                    {projectGroups.unassigned.map(a => (
                      <div key={a.id} className="flex items-center gap-2 py-1 text-[11px]">
                        <span className="pl-4 text-zinc-400 flex-1 truncate">{a.name}</span>
                        <span className="text-zinc-500 font-mono">{formatTokens(a.totalInputTokens + a.totalOutputTokens)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
