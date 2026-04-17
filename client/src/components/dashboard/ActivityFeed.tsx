import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  UserPlus,
  UserMinus,
  Pencil,
  Copy,
  FolderPlus,
  FolderMinus,
  Folder,
  Sparkles,
  Users,
  MessageSquare,
  Upload,
  Settings,
  Activity
} from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { ActivityEntry } from '../../lib/types';

const TOPIC_META: Record<
  string,
  { icon: LucideIcon; color: string; key: string; detail?: (e: ActivityEntry) => string }
> = {
  'agent.created':    { icon: UserPlus,      color: 'text-emerald-400', key: 'activity.agentCreated',    detail: (e) => String(e.agentId ?? '') },
  'agent.updated':    { icon: Pencil,        color: 'text-zinc-400',    key: 'activity.agentUpdated',    detail: (e) => String(e.agentId ?? '') },
  'agent.deleted':    { icon: UserMinus,     color: 'text-red-400',     key: 'activity.agentDeleted',    detail: (e) => String(e.agentId ?? '') },
  'agent.cloned':     { icon: Copy,          color: 'text-sky-400',     key: 'activity.agentCreated',    detail: (e) => `${e.sourceId} → ${e.newId}` },
  'project.created':  { icon: FolderPlus,    color: 'text-emerald-400', key: 'activity.projectCreated',  detail: (e) => (e.project as { name?: string })?.name ?? '' },
  'project.updated':  { icon: Folder,        color: 'text-zinc-400',    key: 'activity.projectUpdated',  detail: (e) => (e.project as { name?: string })?.name ?? '' },
  'project.deleted':  { icon: FolderMinus,   color: 'text-red-400',     key: 'activity.projectDeleted',  detail: (e) => String(e.projectId ?? '') },
  'skill.created':    { icon: Sparkles,      color: 'text-amber-400',   key: 'activity.skillCreated',    detail: (e) => (e.skill as { name?: string })?.name ?? '' },
  'skill.updated':    { icon: Sparkles,      color: 'text-amber-400',   key: 'activity.skillUpdated',    detail: (e) => (e.skill as { name?: string })?.name ?? '' },
  'skill.deleted':    { icon: Sparkles,      color: 'text-red-400',     key: 'activity.skillDeleted',    detail: (e) => String(e.skillId ?? '') },
  'skill.bulkAssign': { icon: Users,         color: 'text-amber-400',   key: 'activity.skillCreated',    detail: (e) => `${e.skillId} → ${(e.agentIds as string[])?.length ?? 0}` },
  'skill.bulkUnassign':{ icon: Users,        color: 'text-zinc-500',    key: 'activity.skillDeleted',    detail: (e) => `${e.skillId} → ${(e.agentIds as string[])?.length ?? 0}` },
  'chat.started':     { icon: MessageSquare, color: 'text-emerald-400', key: 'activity.chatStarted',     detail: (e) => String(e.sessionId ?? '') },
  'chat.done':        { icon: MessageSquare, color: 'text-zinc-500',    key: 'activity.chatDone',        detail: (e) => String(e.sessionId ?? '') },
  'chat.error':       { icon: MessageSquare, color: 'text-red-400',     key: 'activity.chatError',       detail: (e) => String(e.error ?? '') },
  'chat.aborted':     { icon: MessageSquare, color: 'text-amber-400',   key: 'activity.chatError',       detail: (e) => String(e.sessionId ?? '') },
  'session.created':  { icon: MessageSquare, color: 'text-emerald-400', key: 'activity.sessionCreated',  detail: (e) => (e.session as { title?: string })?.title ?? '' },
  'session.deleted':  { icon: MessageSquare, color: 'text-red-400',     key: 'activity.sessionDeleted',  detail: (e) => String(e.sessionId ?? '') },
  'upload.created':   { icon: Upload,        color: 'text-sky-400',     key: 'activity.uploadCreated',   detail: (e) => String(e.filename ?? '') },
  'upload.deleted':   { icon: Upload,        color: 'text-zinc-500',    key: 'activity.uploadDeleted',   detail: (e) => String(e.id ?? '') },
  'backends.updated': { icon: Settings,      color: 'text-zinc-400',    key: 'activity.backendsUpdated' },
  'settings.updated': { icon: Settings,      color: 'text-zinc-400',    key: 'activity.settingsUpdated' }
};

function timeAgo(ts: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return t('time.secondsAgo', { n: Math.floor(diff / 1000) });
  if (diff < 3600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3600_000) });
  return t('time.daysAgo', { n: Math.floor(diff / 86400_000) });
}

export default function ActivityFeed({ limit = 30 }: { limit?: number }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.activity(limit),
    refetchInterval: 5000
  });

  const entries = data ?? [];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
        <Activity size={14} className="text-zinc-500" />
        <div className="text-sm font-semibold text-zinc-300">{t('activity.title')}</div>
        <div className="ml-auto text-xs text-zinc-600">{entries.length}</div>
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        {entries.length === 0 ? (
          <div className="text-sm text-zinc-600 italic text-center py-8">
            {t('activity.empty')}
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {entries.map((entry, i) => {
              const meta = TOPIC_META[entry.topic] ?? {
                icon: Activity,
                color: 'text-zinc-500',
                key: '',
                detail: () => entry.topic
              };
              const Icon = meta.icon;
              const label = meta.key ? t(meta.key) : entry.topic;
              const detail = meta.detail?.(entry) ?? '';
              return (
                <div
                  key={`${entry.ts}-${i}`}
                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-zinc-900/40 transition-colors"
                >
                  <Icon size={14} className={`${meta.color} shrink-0 mt-0.5`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-300 truncate">
                      {label}{detail ? ` · ${detail}` : ''}
                    </div>
                    <div className="text-[11px] text-zinc-600 font-mono mt-0.5">
                      {timeAgo(entry.ts, t)}
                    </div>
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
