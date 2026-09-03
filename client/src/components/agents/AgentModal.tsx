import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../../lib/api';
import type { Agent, PermissionMode } from '../../lib/types';
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
  pinnedFiles: string[];
  gitDiffAutoAttach: boolean;
  bridgeAutoAttach: boolean;
  permissionMode: PermissionMode;
  /** 순서 보존을 위해 배열로 편집하고 제출 시 객체로 변환. */
  env: { key: string; value: string }[];
}

const PERMISSION_MODES: { value: PermissionMode; label: string; help: string }[] = [
  { value: 'default', label: 'default', help: '위험 도구마다 승인 요청 (기본)' },
  { value: 'auto', label: 'auto', help: '분류기가 위험 행동만 차단' },
  { value: 'acceptEdits', label: 'acceptEdits', help: '파일 편집은 자동 승인' },
  { value: 'plan', label: 'plan', help: '계획만 세우고 실행하지 않음' },
  { value: 'bypassPermissions', label: 'bypassPermissions', help: '모든 승인 생략 — 주의' }
];

/** 서버 스키마와 동일: 대문자/숫자/밑줄, 숫자로 시작 불가. */
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const ENV_RESERVED = ['PATH', 'HOME', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR'];
const ENV_MAX = 32;
const ENV_VALUE_MAX = 2000;

/** 빈 키는 무시. 반환값이 null 이면 저장 불가. */
export function envRowError(row: { key: string; value: string }): string | null {
  if (!row.key.trim()) return null;
  if (!ENV_KEY_RE.test(row.key)) return '대문자/숫자/_ 만, 숫자로 시작 불가';
  if (ENV_RESERVED.includes(row.key)) return `${row.key} 는 사용할 수 없음`;
  if (row.value.length > ENV_VALUE_MAX) return `값은 ${ENV_VALUE_MAX}자 이하`;
  return null;
}

export function envRowsToRecord(rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.key.trim()) out[r.key] = r.value;
  }
  return out;
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
  disallowedTools: [],
  pinnedFiles: [],
  gitDiffAutoAttach: false,
  bridgeAutoAttach: false,
  permissionMode: 'default',
  env: []
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
          disallowedTools: agent.disallowedTools ?? [],
          pinnedFiles: agent.pinnedFiles ?? [],
          gitDiffAutoAttach: agent.gitDiffAutoAttach ?? false,
          bridgeAutoAttach: agent.bridgeAutoAttach ?? false,
          permissionMode: agent.permissionMode ?? 'default',
          env: Object.entries(agent.env ?? {}).map(([key, value]) => ({ key, value }))
        }
      : emptyAgentForm()
  );
  // form.model 정규화 + form.backend 자동 매칭
  // ① 현재 backend 에 form.model(alias 또는 ID) 가 있으면 alias 로 정규화
  // ② 없으면 전체 백엔드 스캔해서 해당 alias/ID 를 가진 첫 백엔드로 form.backend 재설정
  //    (agent.backendId 가 비어있어 'claude' 로 폴백된 경우, 실제 alias 를 가진 백엔드로 교정)
  useEffect(() => {
    if (!backendsState?.backends) return;
    const currentB = backendsState.backends[form.backend];
    const inCurrent =
      currentB?.models &&
      (currentB.models[form.model] ||
        Object.values(currentB.models).includes(form.model));
    if (inCurrent) {
      // 전체 ID 로 저장돼 있다면 alias 로 되돌림
      if (currentB?.models?.[form.model]) return;
      const alias = Object.entries(currentB!.models!).find(([, v]) => v === form.model)?.[0];
      if (alias && alias !== form.model) setForm((f) => ({ ...f, model: alias }));
      return;
    }
    // 현재 backend 에 없음 → 다른 백엔드 스캔
    for (const [bid, b] of Object.entries(backendsState.backends)) {
      if (!b?.models) continue;
      if (b.models[form.model]) {
        setForm((f) => ({ ...f, backend: bid }));
        return;
      }
      const alias = Object.entries(b.models).find(([, v]) => v === form.model)?.[0];
      if (alias) {
        setForm((f) => ({ ...f, backend: bid, model: alias }));
        return;
      }
    }
  }, [backendsState, form.backend, form.model]);

  // Models available for the currently selected backend
  // claude-cli 포함 모든 백엔드: models 딕셔너리 사용, 없으면 기본 3종 제공
  const availableModels = useMemo(() => {
    const b = backendsState?.backends?.[form.backend];
    const entries = b ? Object.entries(b.models ?? {}) : [];
    if (entries.length === 0) {
      // models 미설정 백엔드(기본 claude 포함) → fable/opus/sonnet/haiku 폴백
      return [
        { value: 'fable',  label: 'fable' },
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
  const envErrors = form.env.map(envRowError);
  const duplicateEnvKey = (() => {
    const seen = new Set<string>();
    for (const r of form.env) {
      const k = r.key.trim();
      if (!k) continue;
      if (seen.has(k)) return k;
      seen.add(k);
    }
    return null;
  })();
  const envValid = envErrors.every((e) => e === null) && !duplicateEnvKey && form.env.length <= ENV_MAX;
  const valid = !!form.id.trim() && !!form.name.trim() && envValid;

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

          {/* Auto-injected working context (Phase 1) */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-zinc-200">작업 컨텍스트 자동 주입</div>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                매 세션 첫 턴 또는 매 메시지에 자동으로 파일 내용 / git diff 를 프롬프트에 포함시킵니다.
              </p>
            </div>

            <Field
              label="고정 파일 (Pinned Files)"
              help="working dir 기준 상대경로 — 한 줄에 하나씩. 첫 턴에 파일 내용이 자동 첨부되고 --resume 으로 캐시됩니다. (파일당 64KB, 총 256KB 한도)"
            >
              <textarea
                value={form.pinnedFiles.join('\n')}
                onChange={(e) =>
                  setForm({
                    ...form,
                    pinnedFiles: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  })
                }
                rows={4}
                placeholder="src/components/App.tsx&#10;server/routes/settings.js"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                style={{ fontSize: '13px' }}
              />
            </Field>

            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.gitDiffAutoAttach}
                onChange={(e) => setForm({ ...form, gitDiffAutoAttach: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-zinc-200">Git diff 자동 첨부</span>
                <span className="block text-[11px] text-zinc-500">
                  매 메시지 전송 시 현재 워킹 디렉토리의 <code>git diff</code> 를 프롬프트 앞에 붙입니다 (unstaged + staged, 32KB 한도).
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.bridgeAutoAttach}
                onChange={(e) => setForm({ ...form, bridgeAutoAttach: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-zinc-200">VS Code Bridge 자동 첨부</span>
                <span className="block text-[11px] text-zinc-500">
                  VS Code 확장이 push 한 IDE 상태(열린 파일 · 활성 파일 · 커서 · 선택 영역)를 매 메시지 앞에 붙입니다. 5분 내 push가 있어야 활성화됩니다.
                </span>
              </span>
            </label>
          </div>

          {/* 권한 모드 + 에이전트 환경변수 */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <Field
              label="권한 모드"
              help={PERMISSION_MODES.find((m) => m.value === form.permissionMode)?.help}
            >
              <select
                value={form.permissionMode}
                onChange={(e) =>
                  setForm({ ...form, permissionMode: e.target.value as PermissionMode })
                }
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </Field>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                  환경 변수 ({form.env.length}/{ENV_MAX})
                </span>
                <button
                  type="button"
                  disabled={form.env.length >= ENV_MAX}
                  onClick={() => setForm({ ...form, env: [...form.env, { key: '', value: '' }] })}
                  className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                >
                  + 추가
                </button>
              </div>
              <div className="space-y-1.5">
                {form.env.length === 0 && (
                  <div className="text-[11px] text-zinc-600">
                    없음 — 이 에이전트 실행 프로세스에만 병합됩니다.
                  </div>
                )}
                {form.env.map((row, i) => (
                  <div key={i}>
                    <div className="flex gap-1.5">
                      <input
                        value={row.key}
                        onChange={(e) => {
                          const env = form.env.slice();
                          env[i] = { ...row, key: e.target.value.toUpperCase() };
                          setForm({ ...form, env });
                        }}
                        placeholder="MY_API_KEY"
                        className={`w-1/3 bg-zinc-950 border rounded px-2 py-1.5 text-xs font-mono ${
                          envErrors[i] || (duplicateEnvKey && row.key.trim() === duplicateEnvKey)
                            ? 'border-red-800'
                            : 'border-zinc-800'
                        }`}
                      />
                      <input
                        value={row.value}
                        onChange={(e) => {
                          const env = form.env.slice();
                          env[i] = { ...row, value: e.target.value };
                          setForm({ ...form, env });
                        }}
                        placeholder="값"
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setForm({ ...form, env: form.env.filter((_, j) => j !== i) })
                        }
                        className="px-2 text-zinc-500 hover:text-red-400"
                        aria-label="환경 변수 삭제"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {envErrors[i] && (
                      <div className="text-[11px] text-red-400 mt-0.5">{envErrors[i]}</div>
                    )}
                  </div>
                ))}
                {duplicateEnvKey && (
                  <div className="text-[11px] text-red-400">중복된 키: {duplicateEnvKey}</div>
                )}
              </div>
              <p className="text-[11px] text-zinc-600 mt-1">
                PATH / HOME / NODE_OPTIONS / CLAUDE_CONFIG_DIR 은 서버가 거부합니다.
              </p>
            </div>
          </div>

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
