import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface Hook {
  id: string;
  event: string;
  matcher: string;
  action: string;
  command: string;
  enabled: boolean;
}

const EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart'] as const;

export function HooksTab() {
  const t = useT();
  const { data: hooks = [] } = useQuery<Hook[]>({
    queryKey: ['hooks'],
    queryFn: api.listHooks
  });

  const [showCreate, setShowCreate] = useState(false);
  const [newEvent, setNewEvent] = useState<string>('PreToolUse');
  const [newMatcher, setNewMatcher] = useState('*');
  const [newCommand, setNewCommand] = useState('');

  const createMut = useProgressMutation<unknown, Error, { event: string; matcher: string; action: string; command: string }>({
    title: '훅 저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['hooks']],
    mutationFn: (data) => api.createHook(data),
    onSuccess: () => {
      setShowCreate(false);
      setNewCommand('');
      setNewMatcher('*');
    }
  });

  const toggleMut = useProgressMutation<unknown, Error, { id: string; enabled: boolean }>({
    title: '훅 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['hooks']],
    mutationFn: ({ id, enabled }) => api.patchHook(id, { enabled }),
  });

  const deleteMut = useProgressMutation<unknown, Error, string>({
    title: '훅 삭제 중...',
    successMessage: '삭제 완료',
    invalidateKeys: [['hooks']],
    optimistic: {
      queryKey: ['hooks'],
      updater: (old: Hook[], id: string) => old?.filter((h) => h.id !== id) ?? old,
    },
    mutationFn: (id) => api.deleteHook(id),
  });

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">{t('hooksTab.desc')}</p>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
        >
          <Plus size={14} /> {t('hooksTab.add')}
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
          <div className="flex gap-2">
            <select
              value={newEvent}
              onChange={(e) => setNewEvent(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs"
            >
              {EVENTS.map((ev) => (
                <option key={ev} value={ev}>{ev}</option>
              ))}
            </select>
            <input
              value={newMatcher}
              onChange={(e) => setNewMatcher(e.target.value)}
              placeholder="Matcher (Bash, Edit, *)"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs"
            />
          </div>
          <input
            value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            placeholder="Shell command (e.g. echo 'tool: {{tool_name}}')"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs font-mono"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1">
              {t('hooksTab.cancel')}
            </button>
            <button
              onClick={() => createMut.mutate({ event: newEvent, matcher: newMatcher, action: 'shell', command: newCommand })}
              disabled={!newCommand.trim()}
              className="text-xs bg-emerald-900/50 text-emerald-200 px-3 py-1 rounded disabled:opacity-40"
            >
              {t('hooksTab.save')}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
        {hooks.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-zinc-500">{t('hooksTab.empty')}</div>
        )}
        {hooks.map((hook) => (
          <div key={hook.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[11px]">{hook.event}</span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[11px]">{hook.matcher}</span>
              </div>
              <div className="text-xs font-mono text-zinc-300 mt-1 truncate">{hook.command}</div>
            </div>
            <button
              onClick={() => toggleMut.mutate({ id: hook.id, enabled: !hook.enabled })}
              className={`rounded px-3 py-1 text-[11px] ${
                hook.enabled ? 'bg-emerald-900/40 text-emerald-200' : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {hook.enabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => deleteMut.mutate(hook.id)}
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
