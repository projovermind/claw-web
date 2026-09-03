import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { HOOK_EVENTS } from '../../lib/types';
import type { HookConfig } from '../../lib/types';

/** 다중선택 chip — 비어있으면 "전체 에이전트" 를 뜻한다. */
function AgentChips({
  agents,
  selected,
  onToggle
}: {
  agents: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (agents.length === 0) {
    return <div className="text-[11px] text-zinc-600">에이전트 없음</div>;
  }
  return (
    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
      {agents.map((a) => {
        const on = selected.includes(a.id);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onToggle(a.id)}
            className={`px-1.5 py-0.5 rounded text-[11px] border ${
              on
                ? 'bg-emerald-900/40 text-emerald-200 border-emerald-800'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200'
            }`}
          >
            {a.name}
          </button>
        );
      })}
    </div>
  );
}

export function HooksTab() {
  const t = useT();
  const { data: hooks = [] } = useQuery<HookConfig[]>({
    queryKey: ['hooks'],
    queryFn: api.listHooks
  });
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.agents });

  const [showCreate, setShowCreate] = useState(false);
  const [newEvent, setNewEvent] = useState<string>('PreToolUse');
  const [newMatcher, setNewMatcher] = useState('*');
  const [newCommand, setNewCommand] = useState('');
  const [newAsync, setNewAsync] = useState(false);
  const [newTimeout, setNewTimeout] = useState('');
  const [newAgentIds, setNewAgentIds] = useState<string[]>([]);

  const resetForm = () => {
    setNewCommand('');
    setNewMatcher('*');
    setNewAsync(false);
    setNewTimeout('');
    setNewAgentIds([]);
  };

  const createMut = useProgressMutation<
    unknown,
    Error,
    Omit<HookConfig, 'id' | 'enabled'> & { enabled?: boolean }
  >({
    title: '훅 저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['hooks']],
    mutationFn: (data) => api.createHook(data),
    onSuccess: () => {
      setShowCreate(false);
      resetForm();
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
      updater: (old: HookConfig[], id: string) => old?.filter((h) => h.id !== id) ?? old,
    },
    mutationFn: (id) => api.deleteHook(id),
  });

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const parsedTimeout = Number(newTimeout);
  const timeoutValid = newTimeout === '' || (Number.isFinite(parsedTimeout) && parsedTimeout > 0);

  const submit = () => {
    createMut.mutate({
      event: newEvent,
      matcher: newMatcher,
      action: 'shell',
      command: newCommand,
      async: newAsync,
      ...(newTimeout !== '' ? { timeout: parsedTimeout } : {}),
      ...(newAgentIds.length > 0 ? { agentIds: newAgentIds } : {})
    });
  };

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

      <div className="rounded border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px] text-zinc-400">
        저장된 훅은 에이전트 실행 시 CLI settings 로 주입됩니다.
      </div>

      {showCreate && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
          <div className="flex gap-2">
            <select
              value={newEvent}
              onChange={(e) => setNewEvent(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs"
            >
              {HOOK_EVENTS.map((ev) => (
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

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={newAsync}
                onChange={(e) => setNewAsync(e.target.checked)}
              />
              async (완료를 기다리지 않음)
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              timeout
              <input
                value={newTimeout}
                onChange={(e) => setNewTimeout(e.target.value)}
                placeholder="초"
                inputMode="numeric"
                className={`w-16 bg-zinc-800 border rounded px-2 py-1 text-xs ${
                  timeoutValid ? 'border-zinc-700' : 'border-red-800 text-red-300'
                }`}
              />
            </label>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-zinc-500">
              적용 에이전트 — {newAgentIds.length === 0 ? '전체 (선택 없음)' : `${newAgentIds.length}개 선택`}
            </div>
            <AgentChips
              agents={agents}
              selected={newAgentIds}
              onToggle={(id) =>
                setNewAgentIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                )
              }
            />
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1">
              {t('hooksTab.cancel')}
            </button>
            <button
              onClick={submit}
              disabled={!newCommand.trim() || !timeoutValid}
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
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[11px]">{hook.event}</span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[11px]">{hook.matcher}</span>
                {hook.async && (
                  <span className="px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 text-[11px]">async</span>
                )}
                {hook.timeout ? (
                  <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[11px]">{hook.timeout}s</span>
                ) : null}
              </div>
              <div className="text-xs font-mono text-zinc-300 mt-1 truncate">{hook.command}</div>
              <div className="text-[11px] text-zinc-600 mt-0.5 truncate">
                {hook.agentIds && hook.agentIds.length > 0
                  ? hook.agentIds.map((id) => agentNameById.get(id) ?? id).join(', ')
                  : '전체 에이전트'}
              </div>
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
