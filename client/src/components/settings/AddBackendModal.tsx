import { useState } from 'react';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { X, AlertTriangle, Folder } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import PathPicker from '../common/PathPicker';

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-zinc-600 mt-1">{hint}</div>}
    </label>
  );
}

const DEFAULT_MODELS = {
  default: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-5',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
};

export function AddBackendModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [form, setForm] = useState({
    type: 'openai-compatible' as 'openai-compatible' | 'claude-cli',
    id: '',
    label: '',
    priority: 50,
    configDir: '',
    models: { ...DEFAULT_MODELS },
    baseURL: '',
    envKey: '',
    secret: '',
    defaultModel: '',
  });
  const [showPathPicker, setShowPathPicker] = useState(false);

  const isClaudeCli = form.type === 'claude-cli';

  const add = useProgressMutation<unknown, Error, void>({
    title: '백엔드 연결 중...',
    successMessage: '연결 완료',
    invalidateKeys: [['backends'], ['accounts']],
    mutationFn: (): Promise<unknown> =>
      isClaudeCli
        ? api.createAccount({
            label: form.label,
            priority: form.priority,
            configDir: form.configDir.trim() || undefined,
            models: form.models,
          })
        : api.createBackend({
            id: form.id,
            type: 'openai-compatible',
            label: form.label,
            baseURL: form.baseURL,
            envKey: form.envKey,
            secret: form.secret.trim() || undefined,
            models: {
              default: form.defaultModel,
              opus: form.defaultModel,
              sonnet: form.defaultModel,
              haiku: form.defaultModel,
            },
          }),
    onSuccess: () => onClose(),
  });

  const valid = isClaudeCli
    ? !!(form.label)
    : !!(form.id && form.label && form.baseURL && form.envKey && form.defaultModel);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        onClick={onClose}
      >
        <div
          className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-xl max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
            <h3 className="text-lg font-semibold">{t('addBackend.title')}</h3>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
              <X size={18} />
            </button>
          </div>

          <div className="p-5 space-y-3">
            {/* 타입 선택 */}
            <Labeled label="타입">
              <select
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as 'openai-compatible' | 'claude-cli' })
                }
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="claude-cli">Claude CLI (서브 계정)</option>
              </select>
            </Labeled>

            {/* ── Claude CLI 전용 폼 ── */}
            {isClaudeCli ? (
              <>
                <Labeled label="계정 이름">
                  <input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    placeholder="예: 서브 계정 1"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                  />
                </Labeled>

                {/* Config 저장소 선택 — 초보자는 비워두면 자동 처리 */}
                <Labeled
                  label="Config 저장소 (configDir) — 선택사항"
                  hint="💡 처음이라면 비워두세요. 자동으로 ~/.claude-claw/account-{id} 폴더가 생성됩니다. 기존 Claude 설정 폴더가 있을 때만 직접 선택하세요."
                >
                  <div className="flex gap-2">
                    <input
                      value={form.configDir}
                      onChange={(e) => setForm({ ...form, configDir: e.target.value })}
                      placeholder="비워두면 자동 (권장)"
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPathPicker(true)}
                      className="flex items-center gap-1 px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 shrink-0"
                      title="폴더 찾아보기"
                    >
                      <Folder size={13} />
                      찾기
                    </button>
                  </div>
                </Labeled>

                {/* 모델 설정 */}
                <div className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-950/40">
                  <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">모델 설정</div>
                  {(['default', 'opus', 'sonnet', 'haiku'] as const).map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-500 w-14 shrink-0 font-mono">{key}</span>
                      <input
                        value={form.models[key] ?? ''}
                        onChange={(e) =>
                          setForm({ ...form, models: { ...form.models, [key]: e.target.value } })
                        }
                        placeholder={DEFAULT_MODELS[key]}
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono"
                      />
                    </div>
                  ))}
                  <div className="text-[10px] text-zinc-600 pt-1">
                    에이전트가 opus/sonnet/haiku를 요청할 때 실제로 사용할 모델명
                  </div>
                </div>

                <Labeled label="우선순위" hint="숫자가 높을수록 우선 배정됩니다 (기본: 50)">
                  <input
                    type="number"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                  />
                </Labeled>
              </>
            ) : (
              /* ── OpenAI Compatible 폼 ── */
              <>
                <Labeled label={t('addBackend.id')}>
                  <input
                    value={form.id}
                    onChange={(e) => setForm({ ...form, id: e.target.value })}
                    placeholder="ex: groq"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  />
                </Labeled>
                <Labeled label={t('addBackend.label')}>
                  <input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    placeholder="Groq"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                  />
                </Labeled>
                <Labeled label={t('addBackend.baseUrl')}>
                  <input
                    value={form.baseURL}
                    onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                    placeholder="https://api.groq.com/openai/v1/"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  />
                </Labeled>
                <Labeled label={t('addBackend.envKey')} hint={t('addBackend.envKeyHint')}>
                  <input
                    value={form.envKey}
                    onChange={(e) => setForm({ ...form, envKey: e.target.value })}
                    placeholder="GROQ_API_KEY"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  />
                </Labeled>
                <Labeled label={t('addBackend.secret')} hint={t('addBackend.secretHint')}>
                  <input
                    type="password"
                    value={form.secret}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
                    placeholder="sk-..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  />
                </Labeled>
                <Labeled label={t('addBackend.defaultModel')}>
                  <input
                    value={form.defaultModel}
                    onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
                    placeholder="llama-3.3-70b-versatile"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  />
                </Labeled>
                <div className="text-[11px] text-amber-400 flex items-start gap-1.5 pt-1">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>{t('addBackend.warn')}</span>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800 sticky bottom-0 bg-zinc-900">
            <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">
              {t('addBackend.cancel')}
            </button>
            <button
              disabled={!valid || add.isPending}
              onClick={() => add.mutate()}
              className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
            >
              {add.isPending ? t('addBackend.submitting') : t('addBackend.submit')}
            </button>
          </div>
        </div>
      </div>

      {/* PathPicker 모달 (z-index가 더 높아야 함) */}
      <PathPicker
        open={showPathPicker}
        initialPath={form.configDir || undefined}
        onSelect={(p) => setForm({ ...form, configDir: p })}
        onClose={() => setShowPathPicker(false)}
      />
    </>
  );
}
