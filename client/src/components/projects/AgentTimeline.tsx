import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { Agent, Session } from '../../lib/types';

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}초 전`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}시간 전`;
  return `${Math.floor(diff / 86400_000)}일 전`;
}

export function AgentTimeline({
  agents,
  projectId
}: {
  agents: Agent[];
  projectId: string;
}) {
  const t = useT();
  const projectAgents = agents.filter(a => a.projectId === projectId);
  const agentIds = projectAgents.map(a => a.id);

  // 모든 세션 조회 (에이전트 타임라인용)
  const { data } = useQuery({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 10000
  });

  const allSessions: Session[] = (data as { sessions: Session[] })?.sessions ?? [];

  // 이 프로젝트 에이전트의 세션만 필터 + 최근순 정렬
  const projectSessions = allSessions
    .filter(s => agentIds.includes(s.agentId))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 10);

  const agentMap = new Map(projectAgents.map(a => [a.id, a]));

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <Clock size={14} className="text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-300 flex-1">{t('projects.timeline')}</span>
        <span className="text-[11px] text-zinc-600">{t('projects.timelineAgentCount', { count: projectAgents.length })}</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {projectSessions.length === 0 ? (
          <div className="text-[11px] text-zinc-600 italic text-center py-6">
            {t('projects.timelineEmpty')}
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {projectSessions.map(s => {
              const agent = agentMap.get(s.agentId);
              const msgCount = s.messages?.length ?? 0;
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800/30">
                  <span className="text-base shrink-0">{agent?.avatar ?? '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-300 truncate">{agent?.name ?? s.agentId}</div>
                    <div className="text-[11px] text-zinc-500 truncate flex items-center gap-1">
                      <MessageSquare size={9} />
                      <span>{s.title}</span>
                      <span className="text-zinc-600">· {t('projects.msgCount', { count: msgCount })}</span>
                    </div>
                  </div>
                  <div className="text-[11px] text-zinc-600 shrink-0 flex items-center gap-1">
                    {s.isRunning && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
                    {s.updatedAt ? timeAgo(s.updatedAt) : '-'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
