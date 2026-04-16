import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../../lib/api';
import type { Agent } from '../../lib/types';
import SkillPicker from '../common/SkillPicker';
import ToolPicker from '../common/ToolPicker';
import { useT } from '../../lib/i18n';

export interface AgentFormState {
  id: string;
  name: string;
  avatar: string;
  model: string;
  backend: string;
  systemPrompt: string;
  skillIds: string[];
  allowedTools: string[];
  disallowedTools: string[];
}

export const emptyAgentForm = (): AgentFormState => ({
  id: '',
  name: '',
  avatar: '🤖',
  model: 'sonnet',
  backend: 'claude',
  systemPrompt: '',
  skillIds: [],
  allowedTools: [],
  disallowedTools: []
});

function Field({
  label,
  help,
  children
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{label}</span>
      {children}
      {help && <span className="block text-[11px] text-zinc-600 mt-1 leading-snug">{help}</span>}
    </label>
  );
}

export function AgentModal({
  mode,
  agent,
  onClose,
  onSubmit,
  busy
}: {
  mode: 'create' | 'edit';
  agent?: Agent;
  onClose: () => void;
  onSubmit: (form: AgentFormState) => void;
  busy: boolean;
}) {
  const t = useT();
  const { data: backendsState } = useQuery({ queryKey: ['backends'], queryFn: api.backends });
  const { data: skills } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const backendList = useMemo(() => Object.values(backendsState?.backends ?? {}), [backendsState]);

  // Inherited skills / tools = defaults from the project this agent is in
  const inheritedProject = useMemo(() => {
    if (!agent?.projectId) return null;
    return (projects ?? []).find((p) => p.id === agent.projectId) ?? null;
  }, [agent, projects]);
  const inheritedIds = inheritedProject?.defaultSkillIds ?? [];
  const inheritedAllowedTools = inheritedProject?.defaultAllowedTools ?? [];
  const inheritedDisallowedTools = inheritedProject?.defaultDisallowedTools ?? [];
  const [form, setForm] = useState<AgentFormState>(() =>
    agent
      ? {
          id: agent.id,
          name: agent.name ?? '',
          avatar: agent.avatar ?? '🤖',
          model: agent.model ?? 'sonnet',
          backend: agent.backendId ?? 'claude',
          systemPrompt: agent.systemPrompt ?? '',
          skillIds: agent.skillIds ?? [],
          allowedTools: agent.allowedTools ?? [],
          disallowedTools: agent.disallowedTools ?? []
        }
      : emptyAgentForm()
  );
  // Models available for the currently selected backend
  const availableModels = useMemo(() => {
    const b = backendsState?.backends?.[form.backend];
    if (!b) return [];
    return Object.entries(b.models).map(([alias, modelId]) => ({
      value: alias,
      label: alias === modelId ? alias : `${alias}  →  ${modelId}`
    }));
  }, [backendsState, form.backend]);
  const valid = form.id.trim() && form.name.trim();

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h3 className="text-lg font-semibold">
            {mode === 'create' ? t('agents.modal.create') : `${t('agents.modal.edit')}: ${agent?.name}`}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label={t('agents.field.id')}
              help={t('agents.help.id')}
            >
              <input
                disabled={mode === 'edit'}
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                placeholder="hivemind, algo, router, ..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono disabled:opacity-50"
              />
            </Field>
            <Field label={t('agents.field.name')} help={t('agents.help.name')}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="하이브마인드, 알고리즘 개발자..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label={t('agents.field.avatar')} help={t('agents.help.avatar')}>
              <input
                value={form.avatar}
                onChange={(e) => setForm({ ...form, avatar: e.target.value })}
                maxLength={4}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-2xl text-center"
              />
            </Field>
            <Field label={t('agents.field.backend')} help={t('agents.help.backend')}>
              <select
                value={form.backend}
                onChange={(e) => {
                  const newBackend = e.target.value;
                  // Reset model to first available in new backend
                  const b = backendsState?.backends?.[newBackend];
                  const firstModel = b ? Object.keys(b.models)[0] ?? 'sonnet' : 'sonnet';
                  setForm({ ...form, backend: newBackend, model: firstModel });
                }}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                {backendList.length === 0 && <option value="claude">Claude (CLI)</option>}
                {backendList.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                    {b.envStatus === 'unset' ? ' ⚠' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('agents.field.model')} help={t('agents.help.model')}>
              <select
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              >
                {availableModels.length === 0 && (
                  <option value={form.model}>{form.model || '—'}</option>
                )}
                {availableModels.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('agents.field.systemPrompt')} help={t('agents.help.systemPrompt')}>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              rows={14}
              placeholder={t('agents.field.systemPrompt.placeholder')}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono leading-relaxed"
              style={{ fontSize: '13px' }}
            />
          </Field>

          <Field
            label="Skills"
            help={
              inheritedIds.length > 0
                ? `선택된 스킬들이 채팅 호출 시 systemPrompt에 concat돼. 현재 프로젝트의 기본 스킬 ${inheritedIds.length}개는 자동 상속됨 (체크 해제 불가).`
                : '선택된 스킬들이 채팅 호출 시 systemPrompt에 concat됨. 프로젝트에 배치하면 해당 프로젝트의 기본 스킬이 자동 상속돼.'
            }
          >
            <SkillPicker
              allSkills={skills ?? []}
              selectedIds={form.skillIds}
              inheritedIds={inheritedIds}
              onChange={(ids) => setForm({ ...form, skillIds: ids })}
            />
          </Field>

          {/* Tool permissions section */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-zinc-200">도구 설정</div>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                이 에이전트가 호출할 수 있는 Claude 도구를 제한. Claude CLI에{' '}
                <code>--allowedTools</code> / <code>--disallowedTools</code>로 전달됨.
                {inheritedProject && (inheritedAllowedTools.length > 0 || inheritedDisallowedTools.length > 0) && (
                  <>
                    {' '}프로젝트 <strong>{inheritedProject.name}</strong>의 기본 도구가 자동 상속됨 (↑ 표시).
                  </>
                )}
              </p>
            </div>

            <Field
              label="허용 도구 (allowedTools)"
              help="체크된 도구만 Claude가 호출 가능. 비어있으면 Claude 기본값 (전부 허용)."
            >
              <ToolPicker
                selected={form.allowedTools}
                onChange={(tools) => setForm({ ...form, allowedTools: tools })}
                inherited={inheritedAllowedTools}
              />
            </Field>

            <Field
              label="차단 도구 (disallowedTools)"
              help="체크된 도구는 명시적으로 차단. allowedTools보다 우선. 예: router 에이전트는 Edit/Write/Bash 차단."
            >
              <ToolPicker
                selected={form.disallowedTools}
                onChange={(tools) => setForm({ ...form, disallowedTools: tools })}
                inherited={inheritedDisallowedTools}
              />
            </Field>
          </div>

          {mode === 'edit' && (
            <div className="text-[11px] text-zinc-500 border-t border-zinc-800 pt-3">
              {t('agents.modal.locationHint')}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">
            {t('common.cancel')}
          </button>
          <button
            disabled={!valid || busy}
            onClick={() => onSubmit(form)}
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
          >
            {busy ? t('common.saving') : mode === 'create' ? t('common.create') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
