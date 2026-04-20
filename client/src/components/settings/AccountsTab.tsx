import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, CheckCircle2, XCircle, Play, Folder } from 'lucide-react';
import { api } from '../../lib/api';
import type { Account } from '../../lib/types';

const STATUS_LABEL: Record<Account['status'], string> = {
  active: '활성',
  cooldown: '쿨다운',
  disabled: '비활성',
};
const STATUS_COLOR: Record<Account['status'], string> = {
  active: 'text-emerald-400',
  cooldown: 'text-amber-400',
  disabled: 'text-zinc-500',
};

export function AccountsTab() {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ['accounts'],
    queryFn: api.listAccounts,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newConfigDir, setNewConfigDir] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const createMut = useMutation({
    mutationFn: () => api.createAccount({ label: newLabel.trim(), configDir: newConfigDir.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setShowCreate(false);
      setNewLabel('');
      setNewConfigDir('');
    },
  });

  const patchMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Account['status'] }) =>
      api.patchAccount(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const testMut = useMutation({
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
          Claude 계정(CLAUDE_CONFIG_DIR)을 여러 개 등록해 에이전트별로 할당할 수 있습니다.
        </p>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
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
              onClick={() => createMut.mutate()}
              className="px-3 py-1 text-xs rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40"
            >
              생성
            </button>
          </div>
        </div>
      )}

      {accounts.length === 0 && !showCreate && (
        <p className="text-sm text-zinc-600 text-center py-6">등록된 계정이 없습니다.</p>
      )}

      {accounts.map((acc) => {
        const testRes = testResults[acc.id];
        return (
          <div
            key={acc.id}
            className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-900/40"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-xs font-medium shrink-0 ${STATUS_COLOR[acc.status]}`}>
                  {STATUS_LABEL[acc.status]}
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
                <select
                  value={acc.status}
                  onChange={(e) => patchMut.mutate({ id: acc.id, status: e.target.value as Account['status'] })}
                  className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs"
                >
                  <option value="active">활성</option>
                  <option value="cooldown">쿨다운</option>
                  <option value="disabled">비활성</option>
                </select>
                <button
                  onClick={() => deleteMut.mutate(acc.id)}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Folder size={11} className="shrink-0" />
              <span className="font-mono truncate">{acc.configDir || '—'}</span>
            </div>

            {acc.lastUsedAt && (
              <div className="text-[10px] text-zinc-600">
                마지막 사용: {new Date(acc.lastUsedAt).toLocaleString('ko-KR')}
                {' · '}이번 시간 {acc.usage.messagesUsed}건
              </div>
            )}

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
