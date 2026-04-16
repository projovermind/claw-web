import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, Zap, MessageSquare, Loader2, Clock, Server, Globe, Shield } from 'lucide-react';
import { api } from '../lib/api';
import { useWsStore } from '../store/ws-store';
import { useChatStore } from '../store/chat-store';
import { useT } from '../lib/i18n';
import type { Session, Agent, Project } from '../lib/types';
import ActivityFeed from '../components/dashboard/ActivityFeed';
import AgentStatsWidget from '../components/dashboard/AgentStatsWidget';

export default function DashboardPage() {
  const t = useT();
  const navigate = useNavigate();
  const wsState = useWsStore((s) => s.state);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const setCurrentAgent = useChatStore((s) => s.setCurrentAgent);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 5000
  });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: sessionsRaw } = useQuery({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 3000
  });
  const { data: tunnelData } = useQuery({
    queryKey: ['tunnel-url'],
    queryFn: api.tunnelUrl,
    refetchInterval: 30_000,
  });
  const { data: backends } = useQuery({
    queryKey: ['backends'],
    queryFn: api.backends,
    refetchInterval: 30_000,
  });

  const allSessions: Session[] = sessionsRaw?.sessions ?? [];
  const activeIds: string[] = sessionsRaw?.activeIds ?? [];
  const runningSessions = allSessions.filter((s) => s.isRunning);
  const recentSessions = allSessions
    .slice()
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 10);
  const quickAccessSessions = recentSessions.slice(0, 5);

  const agentById = new Map<string, Agent>((agents ?? []).map((a) => [a.id, a]));
  const getAgent = (id: string) => agentById.get(id);

  // Project activity: message count per project in last 24h
  const projectActivity = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const projectMap = new Map<string, { name: string; color: string; count: number }>();
    for (const p of (projects ?? []) as Project[]) {
      projectMap.set(p.id, { name: p.name, color: p.color ?? '#6ee7b7', count: 0 });
    }
    for (const session of allSessions) {
      const agentProjectId = agentById.get(session.agentId)?.projectId;
      if (!agentProjectId || !projectMap.has(agentProjectId)) continue;
      const msgs = session.messages ?? [];
      for (const m of msgs) {
        if (m.ts && new Date(m.ts).getTime() > cutoff) {
          projectMap.get(agentProjectId)!.count += 1;
        }
      }
    }
    return Array.from(projectMap.values())
      .filter((p) => p.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [allSessions, projects, agentById]);

  const maxProjectMsgs = projectActivity.length > 0
    ? Math.max(...projectActivity.map((p) => p.count), 1)
    : 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">{t('dashboard.title')}</h2>
        <WsBadge state={wsState} />
      </div>

      {/* Quick Access */}
      {quickAccessSessions.length > 0 && (
        <div>
          <SectionHeader icon={<Clock size={14} className="text-sky-400" />} label={t('dashboard.quickAccess')} count={quickAccessSessions.length} />
          <div className="flex gap-2 overflow-x-auto pb-1">
            {quickAccessSessions.map((s) => {
              const agent = getAgent(s.agentId);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    setCurrentAgent(s.agentId);
                    setCurrentSession(s.id);
                    navigate('/chat');
                  }}
                  className="shrink-0 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/70 px-3 py-2 text-xs text-zinc-300 transition-colors"
                >
                  <span>{agent?.avatar ?? '🤖'}</span>
                  <span className="truncate max-w-[120px]">{s.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stat widgets */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label={t('dashboard.stat.agents')} value={agents?.length ?? '...'} />
        <StatCard
          label={t('dashboard.stat.botStatus')}
          value={health?.botOnline ? t('dashboard.stat.botOnline') : t('dashboard.stat.botOffline')}
          accent={health?.botOnline ? 'emerald' : 'red'}
        />
        <StatCard
          label={t('dashboard.stat.running')}
          value={runningSessions.length}
          accent={runningSessions.length > 0 ? 'amber' : undefined}
        />
        <StatCard label={t('dashboard.stat.sessions')} value={allSessions.length} />
      </div>

      {/* Active runs */}
      <div>
        <SectionHeader icon={<Zap size={14} className="text-amber-400" />} label={t('dashboard.activeRuns')} count={runningSessions.length} />
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          {runningSessions.length === 0 ? (
            <div className="text-[11px] text-zinc-600 italic px-2 py-4 text-center">
              {t('dashboard.noActiveRuns')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {runningSessions.map((s) => (
                <SessionRow key={s.id} session={s} agent={getAgent(s.agentId)} running />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* System Status + Project Activity side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* System Status */}
        <div>
          <SectionHeader icon={<Server size={14} className="text-zinc-400" />} label={t('dashboard.systemStatus')} />
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-2.5">
            <StatusRow
              icon={<Server size={12} />}
              label={t('dashboard.uptime')}
              value={health ? formatUptime(health.webUptime) : '...'}
            />
            <StatusRow
              icon={<Globe size={12} />}
              label={t('dashboard.tunnel')}
              value={tunnelData?.url ? truncateUrl(tunnelData.url) : 'N/A'}
              accent={tunnelData?.url ? 'emerald' : undefined}
            />
            <StatusRow
              icon={<Shield size={12} />}
              label={t('dashboard.backend')}
              value={backends?.activeBackend ?? '...'}
            />
            <StatusRow
              icon={<Zap size={12} />}
              label={t('dashboard.austerityLabel')}
              value={backends?.austerityMode ? t('dashboard.on') : t('dashboard.off')}
              accent={backends?.austerityMode ? 'amber' : undefined}
            />
          </div>
        </div>

        {/* Project Activity (24h) */}
        <div>
          <SectionHeader icon={<Activity size={14} className="text-emerald-400" />} label={t('dashboard.projectActivity')} count={projectActivity.length} />
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
            {projectActivity.length === 0 ? (
              <div className="text-[11px] text-zinc-600 italic text-center py-4">
                {t('dashboard.noProjectActivity')}
              </div>
            ) : (
              <div className="space-y-2">
                {projectActivity.slice(0, 8).map((p) => (
                  <div key={p.name} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-400 w-24 truncate shrink-0">{p.name}</span>
                    <div className="flex-1 h-3 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-600/60"
                        style={{ width: `${(p.count / maxProjectMsgs) * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-zinc-500 font-mono w-8 text-right shrink-0">{p.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent sessions + Activity feed side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <SectionHeader icon={<Activity size={14} />} label={t('dashboard.recentSessions')} count={recentSessions.length} />
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            {recentSessions.length === 0 ? (
              <div className="text-sm text-zinc-600 italic px-2 py-6 text-center">
                {t('dashboard.noSessions')}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {recentSessions.map((s) => (
                  <SessionRow key={s.id} session={s} agent={getAgent(s.agentId)} running={activeIds.includes(s.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
        <ActivityFeed limit={40} />
      </div>

      {/* Agent Stats Widget */}
      <div>
        <AgentStatsWidget />
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url.slice(0, 30);
  }
}

function StatusRow({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: 'emerald' | 'amber';
}) {
  const valColor = accent === 'emerald'
    ? 'text-emerald-400'
    : accent === 'amber'
      ? 'text-amber-400'
      : 'text-zinc-300';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500">{icon}</span>
      <span className="text-zinc-500 w-20">{label}</span>
      <span className={`font-mono ${valColor}`}>{value}</span>
    </div>
  );
}

function SectionHeader({ icon, label, count }: { icon: React.ReactNode; label: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wider text-zinc-500">
      {icon}
      <span>{label}</span>
      {typeof count === 'number' && (
        <span className="text-[11px] text-zinc-600">({count})</span>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent
}: {
  label: string;
  value: React.ReactNode;
  accent?: 'emerald' | 'amber' | 'red';
}) {
  const accentCls = {
    emerald: 'border-emerald-900/40 bg-emerald-900/10',
    amber: 'border-amber-900/40 bg-amber-900/10',
    red: 'border-red-900/40 bg-red-900/10'
  };
  const cls = accent ? accentCls[accent] : 'border-zinc-800 bg-zinc-900/50';
  return (
    <div className={`rounded-lg border ${cls} p-4`}>
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function SessionRow({ session, agent, running }: { session: Session; agent?: Agent; running?: boolean }) {
  const t = useT();
  return (
    <Link
      to={`/chat`}
      className="flex items-center gap-3 rounded px-2 py-2 hover:bg-zinc-900 transition-colors group"
    >
      <span className="text-xl">{agent?.avatar ?? '🤖'}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">{session.title}</div>
        <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
          <span className="truncate">{agent?.name ?? session.agentId}</span>
          <span className="text-zinc-700">·</span>
          <span className="font-mono">{session.id.slice(0, 14)}</span>
        </div>
      </div>
      {running && (
        <span className="flex items-center gap-1 text-[11px] text-amber-300">
          <Loader2 size={10} className="animate-spin" />
          {t('dashboard.runningLabel')}
        </span>
      )}
      <MessageSquare size={12} className="text-zinc-700 group-hover:text-zinc-500" />
    </Link>
  );
}

function WsBadge({ state }: { state: 'connecting' | 'open' | 'closed' }) {
  const t = useT();
  const cfg = {
    open: { color: 'bg-emerald-500', label: t('dashboard.ws.live') },
    connecting: { color: 'bg-amber-500', label: t('dashboard.ws.connecting') },
    closed: { color: 'bg-red-500', label: t('dashboard.ws.disconnected') }
  }[state];
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      <span className={`w-2 h-2 rounded-full ${cfg.color} animate-pulse`} />
      {cfg.label}
    </div>
  );
}
