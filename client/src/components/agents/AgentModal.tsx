import { useState, useMemo, useEffect } from 'react';
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
  backendId: string;
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
  backendId: '',
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
  const claudeCliBackends = useMemo(
    () => backendList.filter((b) => b.type === 'claude-cli' && b.status !== 'disabled'),
    [backendList]
  );

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
          backendId: agent.backendId ?? agent.accountId ?? '',
          systemPrompt: agent.systemPrompt ?? '',
          skillIds: agent.skillIds ?? [],
          allowedTools: agent.allowedTools ?? [],
          disallowedTools: agent.disallowedTools ?? []
        }
      : emptyAgentForm()
  );
  // form.model이 전체 ID('claude-sonnet-4-6')로 저장된 경우 → alias('sonnet')로 정규화
  useEffect(() => {
    if (!backendsState) return;
    const b = backendsState.backends?.[form.backend];
    if (!b || !b.models) return;
    const alias = Object.entries(b.models).find(([, v]) => v === form.model)?.[0];
    if (alias && alias !== form.model) setForm((f) => ({ ...f, model: alias }));
  }, [backendsState, form.backend]);

  // Models available for the currently selected backend
  // claude-cli 포함 모든 백엔드: models 딕셔너리 사용, 없으면 기본 3종 제공
  const availableModels = useMemo(() => {
    const b = backendsState?.backends?.[form.backend];
    const entries = b ? Object.entries(b.models ?? {}) : [];
    if (entries.length === 0) {
      // models 미설정 백엔드(기본 claude 포함) → opus/sonnet/haiku 폴백
      return [
        { value: 'opus',   label: 'opus' },
        { value: 'sonnet', label: 'sonnet' },
        { value: 'haiku',  label: 'haiku' },
      ];
    }
    return entries.map(([alias, modelId]) => ({
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
                placeholder={t('agents.namePlaceholder')}
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
                  const b = backendsState?.backends?.[newBackend];
                  const modelKeys = b ? Object.keys(b.models ?? {}) : [];
                  const firstModel = modelKeys[0] ?? 'sonnet';
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
          {claudeCliBackends.length > 0 && (
            <Field label="Claude 백엔드" help="이 에이전트에 사용할 Claude CLI 백엔드 (설정 > 백엔드에서 등록)">
              <select
                value={form.backendId}
                onChange={(e) => setForm({ ...form, backendId: e.target.value })}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <option value="">기본 (스케줄러 자동 배정)</option>
                {claudeCliBackends.map((b) => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
            </Field>
          )}

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
            label={t('agents.skills')}
            help={
              inheritedIds.length > 0
                ? t('agents.skillsHelpWithInherit', { count: inheritedIds.length })
                : t('agents.skillsHelpNoInherit')
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
              <div className="text-sm font-semibold text-zinc-200">{t('agents.toolsTitle')}</div>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {t('agents.toolsDesc')}{' '}
                <code>--allowedTools</code> / <code>--disallowedTools</code>.
                {inheritedProject && (inheritedAllowedTools.length > 0 || inheritedDisallowedTools.length > 0) && (
                  <>
                    {' '}{t('agents.toolsDescInherit', { name: inheritedProject.name })}
                  </>
                )}
              </p>
            </div>

            <Field
              label={t('agents.allowedTools')}
              help={t('agents.allowedToolsHelp')}
            >
              <ToolPicker
                selected={form.allowedTools}
                onChange={(tools) => setForm({ ...form, allowedTools: tools })}
                inherited={inheritedAllowedTools}
              />
            </Field>

            <Field
              label={t('agents.disallowedTools')}
              help={t('agents.disallowedToolsHelp')}
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
