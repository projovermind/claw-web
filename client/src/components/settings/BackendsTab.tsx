import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { Plus, Trash2, CheckCircle2, XCircle, Play, Folder, Copy, LogIn, Settings2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { ClaudeCliBackend } from '../../lib/types';
import { BackendCard } from './BackendCard';
import { ModelRow } from './ModelRow';
import { AddBackendModal } from './AddBackendModal';
import { ClaudeStatusCard } from './ClaudeStatusCard';
import PathPicker from '../common/PathPicker';
import { useT } from '../../lib/i18n';
import { useProgressToastStore } from '../../store/progress-toast-store';

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function relativeTime(ts: number | null): string {
  if (!ts) return '없음';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function fmtSeconds(s: number): string {
  if (s <= 0) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

const STATUS_BADGE: Record<ClaudeCliBackend['status'], string> = {
  active: 'bg-emerald-900/60 text-emerald-300 border border-emerald-800',
  cooldown: 'bg-amber-900/60 text-amber-300 border border-amber-800',
  disabled: 'bg-zinc-800 text-zinc-500 border border-zinc-700',
};
const STATUS_LABEL: Record<ClaudeCliBackend['status'], string> = {
  active: '활성',
  cooldown: '쿨다운',
  disabled: '비활성',
};

export function BackendsTab() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['backends'], queryFn: api.backends, refetchInterval: 5000 });
  const { data: usage } = useQuery({ queryKey: ['usage-stats'], queryFn: api.usageStats, refetchInterval: 30000 });
  const [adding, setAdding] = useState(false);
  const [loginHint, setLoginHint] = useState<{ configDir: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  // Cooldown countdown — seeded from polled data, ticks every second
  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  const claudeCliList = data
    ? (Object.values(data.backends).filter((b) => b.type === 'claude-cli') as unknown as ClaudeCliBackend[])
    : [];
  const editingBackend = editingId ? (claudeCliList.find((b) => b.id === editingId) ?? null) : null;

  useEffect(() => {
    setCountdowns((prev) => {
      const next = { ...prev };
      claudeCliList.forEach((b) => {
        if (b.status === 'cooldown' && b.cooldownRemaining != null) {
          next[b.id] = b.cooldownRemaining;
        } else if (b.status !== 'cooldown') {
          delete next[b.id];
        }
      });
      return next;
    });
  }, [claudeCliList]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdowns((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id in next) {
          if (next[id] > 0) { next[id]--; changed = true; }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const setActive = useProgressMutation<unknown, Error, string>({
    title: '백엔드 전환 중...',
    successMessage: '전환 완료',
    invalidateKeys: [['backends']],
    mutationFn: (id: string) => api.setActiveBackend(id),
  });
  const setAusterity = useProgressMutation<unknown, Error, { enabled: boolean; backendId?: string }>({
    title: '절약 모드 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['backends']],
    mutationFn: ({ enabled, backendId }: { enabled: boolean; backendId?: string }) =>
      api.setAusterity(enabled, backendId),
  });
  const removeBackend = useProgressMutation<unknown, Error, string>({
    title: '백엔드 삭제 중...',
    successMessage: '삭제 완료',
    invalidateKeys: [['backends']],
    mutationFn: (id: string) => api.deleteBackend(id),
  });

  const patchStatusMut = useProgressMutation<unknown, Error, { id: string; status: ClaudeCliBackend['status'] }>({
    title: '상태 변경 중...',
    successMessage: '상태가 변경되었습니다',
    invalidateKeys: [['backends']],
    mutationFn: ({ id, status }) => api.patchAccount(id, { status }),
  });

  const testMut = useProgressMutation<{ ok: boolean; output?: string; error?: string }, Error, string>({
    title: '계정 테스트 중...',
    successMessage: '테스트 완료',
    mutationFn: (id: string) => api.testAccount(id),
    onSuccess: (res, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: res.ok, msg: res.output || res.error || '' },
      }));
    },
  });

  const loginMut = useProgressMutation<{ ok: boolean; message?: string; command?: string; manual?: boolean; error?: string }, Error, string>({
    title: '로그인 창 여는 중...',
    successMessage: 'Terminal에서 로그인 진행하세요',
    mutationFn: (id: string) => api.loginAccount(id),
    onSuccess: (res, id) => {
      if (res.manual && res.command) {
        setLoginHint({ configDir: res.command });
      }
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: res.ok, msg: res.message || res.error || '' },
      }));
    },
  });

  if (!data) return <div className="text-zinc-500">Loading...</div>;

  const list = Object.values(data.backends);
  const openaiList = list.filter(
    (b): b is Extract<typeof b, { type: 'openai-compatible' | 'anthropic-compatible' }> =>
      b.type !== 'claude-cli'
  );

  return (
    <div className="space-y-5">
      {/* Claude CLI 상태 — 설치/재설치/로그인 */}
      <ClaudeStatusCard />

      {/* 토큰 사용량 요약 */}
      {usage && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="text-sm font-semibold text-zinc-300">사용량 (토큰 기준)</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded border border-zinc-700 bg-zinc-950/60 p-3 space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider text-[10px]">최근 5시간</div>
              <div className="text-xl font-mono font-bold text-amber-300">{fmtTokens(usage.window5h.total)}</div>
              <div className="text-zinc-500">
                ↑{fmtTokens(usage.window5h.inputTokens)} &nbsp;↓{fmtTokens(usage.window5h.outputTokens)}
              </div>
            </div>
            <div className="rounded border border-zinc-700 bg-zinc-950/60 p-3 space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider text-[10px]">최근 7일</div>
              <div className="text-xl font-mono font-bold text-sky-300">{fmtTokens(usage.window7d.total)}</div>
              <div className="text-zinc-500">
                ↑{fmtTokens(usage.window7d.inputTokens)} &nbsp;↓{fmtTokens(usage.window7d.outputTokens)}
              </div>
            </div>
          </div>
          <div className="text-[10px] text-zinc-600">* Anthropic 계정의 실제 잔여 한도는 별도 확인 필요 (API로 조회 불가)</div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-zinc-300">Global</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Active Backend</div>
            <select
              value={data.activeBackend}
              onChange={(e) => setActive.mutate(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{t('backendsTab.austerityTitle')}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setAusterity.mutate({ enabled: !data.austerityMode, backendId: data.austerityBackend })
                }
                className={`flex-1 rounded px-3 py-2 text-sm ${
                  data.austerityMode
                    ? 'bg-amber-900/40 text-amber-200'
                    : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {data.austerityMode ? 'ON' : 'OFF'} &rarr; {data.austerityBackend}
              </button>
            </div>
          </div>
        </div>
        <p className="text-[11px] text-zinc-500">
          {t('backendsTab.austerityDesc', { backend: data.austerityBackend })}
        </p>
      </div>

      {/* Backends (claude-cli first, openai-compatible after) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-zinc-300">Backends ({list.length})</div>
          <button
            onClick={() => setAdding(true)}
            className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs flex items-center gap-1"
          >
            <Plus size={12} /> {t('backendsTab.addBackend')}
          </button>
        </div>

        {loginHint && (
          <LoginHintBanner
            configDir={loginHint.configDir}
            onClose={() => setLoginHint(null)}
          />
        )}

        {/* Claude CLI cards */}
        {claudeCliList.map((b) => {
          const countdown = countdowns[b.id];
          const testRes = testResults[b.id];
          return (
            <div key={b.id} className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-900/40">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${STATUS_BADGE[b.status]}`}>
                    {STATUS_LABEL[b.status]}
                    {b.status === 'cooldown' && countdown != null && countdown > 0 && (
                      <span className="ml-1 opacity-70">{fmtSeconds(countdown)}</span>
                    )}
                  </span>
                  <span className="font-medium text-sm truncate">{b.label}</span>
                  <span className="text-[10px] text-zinc-600 font-mono shrink-0">{b.id}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    title="Claude 로그인 (Terminal 열기)"
                    onClick={() => loginMut.mutate(b.id)}
                    disabled={loginMut.isPending && loginMut.variables === b.id}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-sky-900/50 hover:bg-sky-800/60 text-sky-300 text-xs border border-sky-800/50"
                  >
                    <LogIn size={12} />
                    연결
                  </button>
                  <button
                    title="연결 테스트"
                    onClick={() => testMut.mutate(b.id)}
                    disabled={testMut.isPending && testMut.variables === b.id}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <Play size={13} />
                  </button>
                  <button
                    title={b.status === 'disabled' ? '활성화' : '비활성화'}
                    onClick={() =>
                      patchStatusMut.mutate({ id: b.id, status: b.status === 'disabled' ? 'active' : 'disabled' })
                    }
                    disabled={patchStatusMut.isPending}
                    className="px-2 py-0.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
                  >
                    {b.status === 'disabled' ? '활성화' : '비활성화'}
                  </button>
                  <button
                    title="편집 (모델/configDir)"
                    onClick={() => setEditingId(b.id)}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <Settings2 size={13} />
                  </button>
                  <button
                    onClick={() => removeBackend.mutate(b.id)}
                    disabled={removeBackend.isPending}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Folder size={11} className="shrink-0" />
                <span className="font-mono truncate flex-1">{b.configDir || '—'}</span>
                {b.configDir && (
                  <CopyLoginCmd configDir={b.configDir} onCopied={() => setLoginHint({ configDir: b.configDir })} />
                )}
              </div>

              {/* 모델 설정 요약 */}
              {b.models && Object.keys(b.models).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(b.models).map(([k, v]) => (
                    <span key={k} className="text-[10px] font-mono bg-zinc-800 text-zinc-400 rounded px-1.5 py-0.5">
                      {k}: {v}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                <span>마지막 사용: {relativeTime(b.lastUsedAt)}</span>
                {b.usage && <span>이번 시간 {b.usage.messagesUsed}건</span>}
                <span>우선순위 {b.priority}</span>
              </div>

              {testRes && (
                <div className={`flex items-start gap-1.5 text-[11px] rounded px-2 py-1 ${testRes.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300'}`}>
                  {testRes.ok ? <CheckCircle2 size={11} className="mt-0.5 shrink-0" /> : <XCircle size={11} className="mt-0.5 shrink-0" />}
                  <span className="font-mono break-all">{testRes.msg || (testRes.ok ? 'OK' : '실패')}</span>
                </div>
              )}
            </div>
          );
        })}

        {/* OpenAI-compatible / Anthropic-compatible cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {openaiList.map((b) => (
            <BackendCard
              key={b.id}
              backend={b}
              isActive={b.id === data.activeBackend}
              isAusterity={b.id === data.austerityBackend}
              allBackends={openaiList}
              onDelete={() => {
                if (confirm(t('backendsTab.deleteConfirm', { label: b.label }))) removeBackend.mutate(b.id);
              }}
            />
          ))}
        </div>
      </div>

      {adding && <AddBackendModal onClose={() => setAdding(false)} />}

      {/* 기존 Claude CLI 계정 편집 모달 */}
      {editingBackend && (
        <EditClaudeCliModal
          backend={editingBackend}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

/** 기존 Claude CLI 계정 편집 (configDir + models) */
function EditClaudeCliModal({ backend, onClose }: { backend: ClaudeCliBackend; onClose: () => void }) {
  const [configDir, setConfigDir] = useState(backend.configDir ?? '');
  const [models, setModels] = useState<Record<string, string>>({ ...backend.models });
  const [showPicker, setShowPicker] = useState(false);
  const [draftAlias, setDraftAlias] = useState('');
  const [draftModel, setDraftModel] = useState('');

  const patch = useProgressMutation<unknown, Error, void>({
    title: '저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['backends'], ['accounts']],
    mutationFn: (): Promise<unknown> =>
      api.patchAccount(backend.id, {
        configDir: configDir.trim() || undefined,
        models,
      }),
    onSuccess: onClose,
  });

  const addModel = () => {
    const key = draftAlias.trim();
    const val = draftModel.trim();
    if (!key || !val) return;
    setModels((prev) => ({ ...prev, [key]: val }));
    setDraftAlias('');
    setDraftModel('');
  };

  const removeModel = (key: string) => {
    setModels((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };

  const updateModel = (key: string, newVal: string) => {
    setModels((prev) => ({ ...prev, [key]: newVal }));
  };

  const renameModel = (oldKey: string, newKey: string) => {
    setModels((prev) => {
      const n: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        n[k === oldKey ? newKey : k] = v;
      }
      return n;
    });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-900">
            <div>
              <h3 className="text-base font-semibold">계정 편집</h3>
              <div className="text-[11px] text-zinc-500 font-mono">{backend.label} · {backend.id}</div>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">✕</button>
          </div>

          <div className="p-5 space-y-4">
            {/* Config 저장소 */}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Config 저장소 (configDir)</div>
              <div className="flex gap-2">
                <input
                  value={configDir}
                  onChange={(e) => setConfigDir(e.target.value)}
                  placeholder="~/.claude-claw/account-..."
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
                <button
                  onClick={() => setShowPicker(true)}
                  className="flex items-center gap-1 px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 shrink-0"
                >
                  <Folder size={13} />
                  찾기
                </button>
              </div>
            </div>

            {/* 모델 단축명 설정 — BackendCard 와 동일한 ModelRow UI */}
            <div className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-950/40">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
                모델 단축명 ({Object.keys(models).length})
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                단축명(opus/sonnet 등) → 실제 모델 ID 매핑. 클릭하면 인라인 수정.
              </p>

              {Object.keys(models).length === 0 && (
                <div className="text-[11px] text-zinc-600 italic">단축명 없음 — 아래에서 추가하세요</div>
              )}

              <div className="space-y-1">
                {Object.entries(models).map(([alias, modelId]) => (
                  <ModelRow
                    key={alias}
                    alias={alias}
                    modelId={modelId}
                    onUpdate={(v) => updateModel(alias, v)}
                    onRename={(newAlias) => renameModel(alias, newAlias)}
                    onRemove={() => removeModel(alias)}
                  />
                ))}
              </div>

              {/* 새 단축명 추가 */}
              <div className="flex gap-1 pt-1">
                <input
                  value={draftAlias}
                  onChange={(e) => setDraftAlias(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addModel()}
                  placeholder="단축명 (예: opus)"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
                />
                <input
                  value={draftModel}
                  onChange={(e) => setDraftModel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addModel()}
                  placeholder="실제 모델 ID (예: claude-opus-4-5)"
                  className="flex-[2] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
                />
                <button
                  onClick={addModel}
                  disabled={!draftAlias.trim() || !draftModel.trim()}
                  className="rounded bg-emerald-900/40 hover:bg-emerald-900/60 disabled:opacity-30 text-emerald-200 px-2 py-1 text-[11px] flex items-center"
                >
                  <Plus size={11} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800 sticky bottom-0 bg-zinc-900">
            <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">취소</button>
            <button
              disabled={patch.isPending}
              onClick={() => patch.mutate()}
              className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
            >
              {patch.isPending ? '저장 중...' : '저장'}
            </button>
          </div>
        </div>
      </div>

      <PathPicker
        open={showPicker}
        initialPath={configDir || undefined}
        onSelect={(p) => setConfigDir(p)}
        onClose={() => setShowPicker(false)}
      />
    </>
  );
}

function LoginHintBanner({ configDir, onClose }: { configDir: string; onClose: () => void }) {
  const cmd = `CLAUDE_CONFIG_DIR=${configDir} claude login`;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="border border-emerald-800 bg-emerald-950/30 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-emerald-400">로그인 필요</span>
        <button onClick={onClose} className="text-[10px] text-zinc-500 hover:text-zinc-300">닫기</button>
      </div>
      <p className="text-[11px] text-zinc-400">아래 명령으로 새 계정에 로그인하세요:</p>
      <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
        <code className="text-[11px] text-emerald-300 font-mono flex-1 break-all">{cmd}</code>
        <button onClick={copy} className="shrink-0 text-zinc-500 hover:text-zinc-200">
          {copied ? <CheckCircle2 size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

function CopyLoginCmd({ configDir, onCopied }: { configDir: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  const { startTask, completeTask } = useProgressToastStore();
  const copy = () => {
    const cmd = `CLAUDE_CONFIG_DIR=${configDir} claude login`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      const id = `copy-${Date.now()}`;
      startTask({ id, title: '클립보드 복사됨' });
      setTimeout(() => completeTask(id, 'claude login 명령이 복사되었습니다'), 50);
      onCopied?.();
    });
  };
  return (
    <button onClick={copy} title="claude login 명령 복사" className="text-zinc-600 hover:text-zinc-300 shrink-0">
      {copied ? <CheckCircle2 size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}
