import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, CheckCircle2, XCircle, Play, Folder, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import type { Account } from '../../lib/types';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { useProgressToastStore } from '../../store/progress-toast-store';

function relativeTime(iso: string | null): string {
  if (!iso) return '없음';
  const diff = Date.now() - new Date(iso).getTime();
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

const STATUS_BADGE: Record<Account['status'], string> = {
  active: 'bg-emerald-900/60 text-emerald-300 border border-emerald-800',
  cooldown: 'bg-amber-900/60 text-amber-300 border border-amber-800',
  disabled: 'bg-zinc-800 text-zinc-500 border border-zinc-700',
};
const STATUS_LABEL: Record<Account['status'], string> = {
  active: '활성',
  cooldown: '쿨다운',
  disabled: '비활성',
};

export function AccountsTab() {
  const { data: accounts = [], isLoading } = useQuery<Account[]>({
    queryKey: ['accounts'],
    queryFn: api.listAccounts,
    refetchInterval: 5000,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newConfigDir, setNewConfigDir] = useState('');
  const [loginHint, setLoginHint] = useState<{ configDir: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});

  // Cooldown countdown — seeded from polled data, ticks every second
  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  useEffect(() => {
    setCountdowns((prev) => {
      const next = { ...prev };
      accounts.forEach((acc) => {
        if (acc.status === 'cooldown' && acc.cooldownRemaining != null) {
          next[acc.id] = acc.cooldownRemaining;
        } else if (acc.status !== 'cooldown') {
          delete next[acc.id];
        }
      });
      return next;
    });
  }, [accounts]);

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

  const createMut = useProgressMutation<Account, Error, { label: string; configDir?: string }>({
    title: '계정 생성 중...',
    successMessage: '계정이 생성되었습니다',
    invalidateKeys: [['accounts']],
    mutationFn: ({ label, configDir }) => api.createAccount({ label, configDir }),
    onSuccess: (account) => {
      setShowCreate(false);
      setNewLabel('');
      setNewConfigDir('');
      setLoginHint({ configDir: account.configDir });
    },
  });

  const patchMut = useProgressMutation<Account, Error, { id: string; status: Account['status'] }>({
    title: '상태 변경 중...',
    successMessage: '상태가 변경되었습니다',
    invalidateKeys: [['accounts']],
    mutationFn: ({ id, status }) => api.patchAccount(id, { status }),
  });

  const deleteMut = useProgressMutation<void, Error, string>({
    title: '계정 삭제 중...',
    successMessage: '계정이 삭제되었습니다',
    invalidateKeys: [['accounts']],
    mutationFn: (id) => api.deleteAccount(id),
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

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">
          Claude 계정(CLAUDE_CONFIG_DIR)을 여러 개 등록해 에이전트별로 할당하거나 스케줄러가 자동 분배합니다.
        </p>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 shrink-0 ml-3"
        >
          <Plus size={13} /> 추가
        </button>
      </div>

      {showCreate && (
        <div className="border border-zinc-700 rounded-lg p-3 space-y-2 bg-zinc-900/60">
          <input
            autoFocus
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="계정 이름 (예: Account #2)"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-sm"
          />
          <input
            value={newConfigDir}
            onChange={(e) => setNewConfigDir(e.target.value)}
            placeholder="configDir 경로 (비워두면 자동 생성)"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-sm font-mono text-zinc-400"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShowCreate(false); setNewLabel(''); setNewConfigDir(''); }}
              className="px-3 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700"
            >
              취소
            </button>
            <button
              disabled={!newLabel.trim() || createMut.isPending}
              onClick={() => createMut.mutate({ label: newLabel.trim(), configDir: newConfigDir.trim() || undefined })}
              className="px-3 py-1 text-xs rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40"
            >
              생성
            </button>
          </div>
        </div>
      )}

      {loginHint && (
        <LoginHintBanner configDir={loginHint.configDir} onClose={() => setLoginHint(null)} />
      )}

      {!isLoading && accounts.length === 0 && !showCreate && (
        <p className="text-sm text-zinc-600 text-center py-6">등록된 계정이 없습니다.</p>
      )}

      {accounts.map((acc) => {
        const testRes = testResults[acc.id];
        const countdown = countdowns[acc.id];
        return (
          <div
            key={acc.id}
            className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-900/40"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${STATUS_BADGE[acc.status]}`}>
                  {STATUS_LABEL[acc.status]}
                  {acc.status === 'cooldown' && countdown != null && countdown > 0 && (
                    <span className="ml-1 opacity-70">{fmtSeconds(countdown)}</span>
                  )}
                </span>
                <span className="font-medium text-sm truncate">{acc.label}</span>
                <span className="text-[10px] text-zinc-600 font-mono shrink-0">{acc.id}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  title="연결 테스트"
                  onClick={() => testMut.mutate(acc.id)}
                  disabled={testMut.isPending && testMut.variables === acc.id}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                >
                  <Play size={13} />
                </button>
                <button
                  title={acc.status === 'disabled' ? '활성화' : '비활성화'}
                  onClick={() =>
                    patchMut.mutate({ id: acc.id, status: acc.status === 'disabled' ? 'active' : 'disabled' })
                  }
                  disabled={patchMut.isPending}
                  className="px-2 py-0.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
                >
                  {acc.status === 'disabled' ? '활성화' : '비활성화'}
                </button>
                <button
                  onClick={() => deleteMut.mutate(acc.id)}
                  disabled={deleteMut.isPending}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Folder size={11} className="shrink-0" />
              <span className="font-mono truncate flex-1">{acc.configDir || '—'}</span>
              {acc.configDir && (
                <CopyLoginCmd configDir={acc.configDir} />
              )}
            </div>

            <div className="flex items-center gap-3 text-[10px] text-zinc-600">
              <span>마지막 사용: {relativeTime(acc.lastUsedAt)}</span>
              <span>이번 시간 {acc.usage.messagesUsed}건</span>
              <span>우선순위 {acc.priority}</span>
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
    </div>
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

function CopyLoginCmd({ configDir }: { configDir: string }) {
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
    });
  };
  return (
    <button onClick={copy} title="claude login 명령 복사" className="text-zinc-600 hover:text-zinc-300 shrink-0">
      {copied ? <CheckCircle2 size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}
