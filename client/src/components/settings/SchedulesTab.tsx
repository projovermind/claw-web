import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { Plus, Trash2, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface Schedule {
  id: string;
  name: string;
  cron: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export function SchedulesTab() {
  const t = useT();
  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: api.listSchedules
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.agents
  });

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', cron: '0 * * * *', agentId: '', prompt: '' });

  const createMut = useProgressMutation<unknown, Error, { name: string; cron: string; agentId: string; prompt: string }>({
    title: '스케줄 등록 중...',
    successMessage: '등록 완료',
    invalidateKeys: [['schedules']],
    mutationFn: (data) => api.createSchedule(data),
    onSuccess: () => {
      setShowCreate(false);
      setForm({ name: '', cron: '0 * * * *', agentId: '', prompt: '' });
    }
  });

  const toggleMut = useProgressMutation<unknown, Error, { id: string; enabled: boolean }>({
    title: '스케줄 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['schedules']],
    mutationFn: ({ id, enabled }) => api.patchSchedule(id, { enabled }),
  });

  const deleteMut = useProgressMutation<unknown, Error, string>({
    title: '스케줄 삭제 중...',
    successMessage: '삭제 완료',
    invalidateKeys: [['schedules']],
    optimistic: {
      queryKey: ['schedules'],
      updater: (old: Schedule[], id: string) => old?.filter((s) => s.id !== id) ?? old,
    },
    mutationFn: (id) => api.deleteSchedule(id),
  });

  const fmtTime = (ts: string | null) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  };

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">{t('schedulesTab.desc')}</p>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
        >
          <Plus size={14} /> {t('schedulesTab.add')}
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
          <div className="flex gap-2">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('schedulesTab.namePlaceholder')}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs"
            />
            <input
              value={form.cron}
              onChange={(e) => setForm({ ...form, cron: e.target.value })}
              placeholder="cron (0 * * * *)"
              className="w-40 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs font-mono"
            />
          </div>
          <select
            value={form.agentId}
            onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs"
          >
            <option value="">{t('schedulesTab.selectAgent')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder={t('schedulesTab.promptPlaceholder')}
            rows={2}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs resize-none"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1">
              {t('schedulesTab.cancel')}
            </button>
            <button
              onClick={() => createMut.mutate(form)}
              disabled={!form.cron.trim() || !form.prompt.trim()}
              className="text-xs bg-emerald-900/50 text-emerald-200 px-3 py-1 rounded disabled:opacity-40"
            >
              {t('schedulesTab.save')}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
        {schedules.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-zinc-500">{t('schedulesTab.empty')}</div>
        )}
        {schedules.map((sched) => (
          <div key={sched.id} className="flex items-center gap-3 px-4 py-3">
            <Clock size={14} className="text-zinc-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-zinc-200">{sched.name}</div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-0.5">
                <span className="font-mono">{sched.cron}</span>
                {sched.agentId && <span>| {sched.agentId}</span>}
                {sched.lastRunAt && <span>| {fmtTime(sched.lastRunAt)}</span>}
              </div>
            </div>
            <button
              onClick={() => toggleMut.mutate({ id: sched.id, enabled: !sched.enabled })}
              className={`rounded px-3 py-1 text-[11px] ${
                sched.enabled ? 'bg-emerald-900/40 text-emerald-200' : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {sched.enabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => deleteMut.mutate(sched.id)}
              className="text-zinc-500 hover:text-red-400"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
