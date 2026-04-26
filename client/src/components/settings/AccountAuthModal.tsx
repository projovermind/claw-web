import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Terminal, Key, Globe, Download, Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { ClaudeCliBackend } from '../../lib/types';

type Tab = 'token' | 'terminal' | 'headless' | 'backup';

/**
 * 계정 인증 통합 관리 모달.
 *  - 토큰 붙여넣기  : Anthropic Console 의 long-lived OAuth 토큰
 *  - Terminal 로그인 : 기존 osascript 기반 (macOS only)
 *  - 헤드리스 로그인 : 서버에서 `claude login` spawn → URL 캡쳐 → 코드 입력
 *  - 백업/복원      : .credentials.json + .claude.json export/import
 */
export function AccountAuthModal({
  backend,
  onClose,
}: {
  backend: ClaudeCliBackend;
  onClose: () => void;
}) {
  // 우선 노출 탭: 이미 토큰이 managed 상태면 token 탭 기본, 아니면 token (가장 간편)
  const [tab, setTab] = useState<Tab>('token');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-zinc-200">인증 관리 — {backend.label}</div>
            <div className="text-[11px] text-zinc-500 font-mono">{backend.id}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={16} />
          </button>
        </div>

        <div className="border-b border-zinc-800 px-2 flex gap-1 text-xs">
          <TabButton current={tab} value="token" onClick={() => setTab('token')} icon={<Key size={12} />} label="토큰 붙여넣기" badge="가장 쉬움" />
          <TabButton current={tab} value="headless" onClick={() => setTab('headless')} icon={<Globe size={12} />} label="헤드리스 로그인" />
          <TabButton current={tab} value="terminal" onClick={() => setTab('terminal')} icon={<Terminal size={12} />} label="Terminal 로그인" />
          <TabButton current={tab} value="backup" onClick={() => setTab('backup')} icon={<Download size={12} />} label="백업/복원" />
        </div>

        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {tab === 'token' && <TokenPasteTab backend={backend} />}
          {tab === 'headless' && <HeadlessLoginTab backend={backend} />}
          {tab === 'terminal' && <TerminalLoginTab backend={backend} />}
          {tab === 'backup' && <BackupRestoreTab backend={backend} />}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  current, value, onClick, icon, label, badge
}: {
  current: Tab; value: Tab; onClick: () => void; icon: React.ReactNode; label: string; badge?: string;
}) {
  const active = current === value;
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 px-3 py-2 transition-colors border-b-2 ${
        active ? 'border-sky-500 text-sky-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge && <span className="ml-1 px-1 rounded bg-emerald-900/50 text-emerald-300 text-[9px]">{badge}</span>}
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// Tab 1: OAuth 토큰 직접 붙여넣기 (managed)
// ─────────────────────────────────────────────────────────
function TokenPasteTab({ backend }: { backend: ClaudeCliBackend }) {
  const qc = useQueryClient();
  const hasManagedToken = backend.oauthSource === 'managed';
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);

  const setMut = useMutation({
    mutationFn: (val: string | null) => api.setAccountOAuthToken(backend.id, val),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backends'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setToken('');
    },
  });

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded border border-sky-900/50 bg-sky-950/30 p-3 text-[12px] text-sky-200/90 leading-relaxed">
        <div className="font-semibold mb-1">💡 가장 간편한 방법</div>
        Anthropic Console에서 long-lived OAuth 토큰을 발급받아 그대로 붙여넣으면 끝입니다.
        Terminal 이나 브라우저 OAuth 플로우 필요 없음. 토큰은 secrets.json 에 백엔드별로 저장되며
        spawn 시 <code className="text-sky-300">CLAUDE_CODE_OAUTH_TOKEN</code> 으로 주입됩니다.
      </div>

      {hasManagedToken && (
        <div className="rounded border border-emerald-900/50 bg-emerald-950/30 p-3 text-[12px] text-emerald-200 flex items-start gap-2">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-semibold">토큰이 저장돼 있습니다</div>
            <div className="text-emerald-300/70 mt-0.5">덮어쓰려면 새 토큰을 입력하고 저장하세요.</div>
          </div>
          <button
            onClick={() => {
              if (confirm('저장된 OAuth 토큰을 삭제하시겠습니까?')) setMut.mutate(null);
            }}
            disabled={setMut.isPending}
            className="px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-200 text-[11px]"
          >
            토큰 제거
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-[11px] text-zinc-400 uppercase tracking-wider">OAuth 토큰</label>
        <div className="flex gap-1">
          <input
            type={reveal ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sk-ant-oat01-..."
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-xs font-mono outline-none focus:border-sky-600"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="px-2 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-[11px]"
          >{reveal ? '숨김' : '표시'}</button>
        </div>
        <button
          onClick={() => setMut.mutate(token.trim() || null)}
          disabled={!token.trim() || setMut.isPending}
          className="w-full rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 px-3 py-2 text-sm text-white"
        >{setMut.isPending ? '저장 중...' : (hasManagedToken ? '토큰 교체' : '토큰 저장')}</button>
        {setMut.isError && (
          <div className="text-[11px] text-red-400">저장 실패: {(setMut.error as Error).message}</div>
        )}
      </div>

      <div className="text-[11px] text-zinc-500 leading-relaxed">
        <div className="font-semibold text-zinc-400 mb-1">발급 방법</div>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li><a className="text-sky-400 hover:underline" href="https://console.anthropic.com" target="_blank" rel="noreferrer">Anthropic Console</a> → Settings → OAuth Tokens</li>
          <li>"Create OAuth Token" → 이름 지정 후 발급</li>
          <li>발급된 <code>sk-ant-oat01-...</code> 를 위에 붙여넣기</li>
        </ol>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Tab 2: Headless 로그인 (서버에서 claude login spawn)
// ─────────────────────────────────────────────────────────
function HeadlessLoginTab({ backend }: { backend: ClaudeCliBackend }) {
  const qc = useQueryClient();
  const [state, setState] = useState<{
    started: boolean;
    status: string;
    urls: string[];
    output: string;
    ttyRequired?: boolean;
    error?: string;
  }>({ started: false, status: 'idle', urls: [], output: '' });
  const [code, setCode] = useState('');
  const pollTimer = useRef<number | null>(null);

  const start = useMutation({
    mutationFn: () => api.startHeadlessLogin(backend.id),
    onSuccess: (res) => {
      setState({
        started: true,
        status: res.status,
        urls: res.urls ?? [],
        output: res.output ?? '',
        ttyRequired: res.ttyRequired,
      });
    },
  });

  const sendCode = useMutation({
    mutationFn: (val: string) => api.sendHeadlessLoginCode(backend.id, val),
    onSuccess: () => setCode(''),
  });

  const abort = useMutation({
    mutationFn: () => api.abortHeadlessLogin(backend.id),
    onSuccess: () => setState({ started: false, status: 'idle', urls: [], output: '' }),
  });

  // Poll every 1.5s while running
  useEffect(() => {
    if (!state.started || state.status === 'success' || state.status === 'failed') {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    pollTimer.current = window.setInterval(async () => {
      try {
        const res = await api.pollHeadlessLogin(backend.id);
        setState((prev) => ({
          ...prev,
          status: res.status,
          urls: res.urls ?? prev.urls,
          output: res.output ?? prev.output,
          error: res.error,
        }));
        if (res.status === 'success') {
          qc.invalidateQueries({ queryKey: ['backends'] });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        }
      } catch { /* ignore poll errors */ }
    }, 1500);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [state.started, state.status, backend.id, qc]);

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-300 leading-relaxed">
        서버에서 <code className="text-amber-300">claude login</code> 을 직접 실행해 OAuth URL 을 캡쳐합니다.
        브라우저에서 로그인 후 받은 코드를 아래에 붙여넣으면 끝.
        <span className="text-zinc-500"> (※ Claude CLI 가 TTY 를 요구하면 실패할 수 있음 — 그 경우 토큰 붙여넣기 또는 Terminal 로그인 사용)</span>
      </div>

      {!state.started && (
        <button
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 px-3 py-2 text-white"
        >{start.isPending ? '시작 중...' : '헤드리스 로그인 시작'}</button>
      )}

      {state.started && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-zinc-500">상태:</span>
            {state.status === 'running' && <span className="text-amber-300 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> 진행 중</span>}
            {state.status === 'success' && <span className="text-emerald-300 flex items-center gap-1"><CheckCircle2 size={11} /> 로그인 성공</span>}
            {state.status === 'failed' && <span className="text-red-300 flex items-center gap-1"><AlertCircle size={11} /> 실패</span>}
          </div>

          {state.ttyRequired && (
            <div className="rounded border border-amber-900/50 bg-amber-950/30 p-3 text-[11px] text-amber-200 flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <div>
                Claude CLI 가 대화형 TTY 를 요구합니다. 헤드리스 모드에선 진행 불가 — <span className="font-semibold">토큰 붙여넣기</span> 또는 <span className="font-semibold">Terminal 로그인</span> 탭을 사용하세요.
              </div>
            </div>
          )}

          {state.urls.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">이 URL 을 브라우저에서 열어 인증 후 받은 코드를 붙여넣으세요:</div>
              {state.urls.map((u, i) => (
                <div key={i} className="flex gap-1">
                  <input
                    readOnly
                    value={u}
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-[11px] font-mono"
                  />
                  <a href={u} target="_blank" rel="noreferrer" className="px-2 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-xs text-white">열기</a>
                  <button
                    onClick={() => navigator.clipboard?.writeText(u)}
                    className="px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300"
                  >복사</button>
                </div>
              ))}
            </div>
          )}

          {state.status === 'running' && (
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-400 uppercase tracking-wider">콜백 코드</label>
              <div className="flex gap-1">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="브라우저에서 받은 코드"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-sky-600"
                />
                <button
                  onClick={() => sendCode.mutate(code.trim())}
                  disabled={!code.trim() || sendCode.isPending}
                  className="px-3 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 text-white text-xs"
                >전송</button>
              </div>
            </div>
          )}

          {state.output && (
            <div>
              <div className="text-[11px] text-zinc-500 mb-1">CLI 출력 (tail)</div>
              <pre className="bg-black/60 border border-zinc-800 rounded p-2 text-[10px] font-mono text-zinc-300 max-h-48 overflow-auto whitespace-pre-wrap">
                {state.output}
              </pre>
            </div>
          )}

          {state.error && <div className="text-[11px] text-red-400">에러: {state.error}</div>}

          <button
            onClick={() => abort.mutate()}
            className="w-full rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
          >중단 / 다시 시작</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Tab 3: Terminal 로그인 (기존 osascript)
// ─────────────────────────────────────────────────────────
function TerminalLoginTab({ backend }: { backend: ClaudeCliBackend }) {
  const cmd = `CLAUDE_CONFIG_DIR=${backend.configDir ?? ''} claude login`;
  const loginMut = useMutation({ mutationFn: () => api.loginAccount(backend.id) });

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-300">
        macOS Terminal 앱을 열어 <code className="text-sky-300">claude login</code> 을 실행합니다.
      </div>
      <div className="flex gap-1">
        <input
          readOnly
          value={cmd}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-[11px] font-mono"
        />
        <button
          onClick={() => navigator.clipboard?.writeText(cmd)}
          className="px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300"
        >복사</button>
      </div>
      <button
        onClick={() => loginMut.mutate()}
        disabled={loginMut.isPending}
        className="w-full rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 px-3 py-2 text-white"
      >{loginMut.isPending ? '여는 중...' : 'Terminal 열기'}</button>
      {loginMut.data?.manual && (
        <div className="text-[11px] text-amber-300">macOS 가 아닙니다. 위 명령어를 직접 실행하세요.</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Tab 4: 백업 / 복원
// ─────────────────────────────────────────────────────────
function BackupRestoreTab({ backend }: { backend: ClaudeCliBackend }) {
  const qc = useQueryClient();
  const [restoreCreds, setRestoreCreds] = useState('');
  const [restoreClaudeJson, setRestoreClaudeJson] = useState('');

  const exportMut = useMutation({
    mutationFn: () => api.exportAccount(backend.id),
  });

  const importMut = useMutation({
    mutationFn: (data: { credentialsJson?: string; claudeJson?: string }) =>
      api.importAccount(backend.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backends'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setRestoreCreds('');
      setRestoreClaudeJson('');
    },
  });

  const downloadJSON = (filename: string, data: object) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>, target: 'creds' | 'claudeJson') => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    // 형식 검증
    try { JSON.parse(text); } catch {
      alert('유효한 JSON 파일이 아닙니다');
      return;
    }
    const b64 = btoa(unescape(encodeURIComponent(text)));
    if (target === 'creds') setRestoreCreds(b64);
    else setRestoreClaudeJson(b64);
  };

  return (
    <div className="space-y-4 text-sm">
      {/* 백업 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-zinc-300">
          <Download size={13} /> 백업 — 현재 계정 자격증명 추출
        </div>
        <button
          onClick={() => exportMut.mutate()}
          disabled={exportMut.isPending}
          className="rounded bg-emerald-800/50 hover:bg-emerald-800/80 disabled:opacity-30 px-3 py-1.5 text-xs text-emerald-100"
        >{exportMut.isPending ? '추출 중...' : '추출'}</button>
        {exportMut.data && (
          <div className="space-y-2 text-[11px]">
            <div className="text-zinc-500">
              configDir: <span className="font-mono text-zinc-300">{backend.configDir || '—'}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {exportMut.data.credentialsJson && (
                <button
                  onClick={() => downloadJSON(`${backend.id}-credentials.json`, JSON.parse(atob(exportMut.data!.credentialsJson!)))}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >.credentials.json 다운로드</button>
              )}
              {exportMut.data.claudeJson && (
                <button
                  onClick={() => downloadJSON(`${backend.id}-claude.json`, JSON.parse(atob(exportMut.data!.claudeJson!)))}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >.claude.json 다운로드</button>
              )}
              {exportMut.data.managedOAuthToken && (
                <button
                  onClick={() => navigator.clipboard?.writeText(exportMut.data!.managedOAuthToken!)}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >Managed OAuth 토큰 복사</button>
              )}
              {!exportMut.data.credentialsJson && !exportMut.data.claudeJson && !exportMut.data.managedOAuthToken && (
                <span className="text-zinc-500 italic">추출할 자격증명이 없습니다</span>
              )}
            </div>
            {exportMut.data.warn && (
              <div className="text-amber-400">{exportMut.data.warn}</div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800" />

      {/* 복원 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-zinc-300">
          <Upload size={13} /> 복원 — 다른 계정/머신에서 가져오기
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-zinc-400">.credentials.json 파일</label>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => handleFileSelect(e, 'creds')}
            className="block text-[11px] text-zinc-400 file:mr-2 file:px-2 file:py-1 file:rounded file:bg-zinc-800 file:text-zinc-300 file:border-0 file:text-[11px]"
          />
          {restoreCreds && <div className="text-[10px] text-emerald-400">✓ 파일 읽음 ({restoreCreds.length} bytes b64)</div>}
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-zinc-400">.claude.json 파일 (선택)</label>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => handleFileSelect(e, 'claudeJson')}
            className="block text-[11px] text-zinc-400 file:mr-2 file:px-2 file:py-1 file:rounded file:bg-zinc-800 file:text-zinc-300 file:border-0 file:text-[11px]"
          />
          {restoreClaudeJson && <div className="text-[10px] text-emerald-400">✓ 파일 읽음</div>}
        </div>
        <button
          onClick={() => importMut.mutate({
            credentialsJson: restoreCreds || undefined,
            claudeJson: restoreClaudeJson || undefined,
          })}
          disabled={(!restoreCreds && !restoreClaudeJson) || importMut.isPending}
          className="rounded bg-amber-800/60 hover:bg-amber-800/80 disabled:opacity-30 px-3 py-1.5 text-xs text-amber-100"
        >{importMut.isPending ? '복원 중...' : '복원'}</button>
        {importMut.data && (
          <div className="text-[11px] text-emerald-400">
            ✓ 복원 완료: {importMut.data.written.join(', ')}
          </div>
        )}
        {importMut.isError && (
          <div className="text-[11px] text-red-400">실패: {(importMut.error as Error).message}</div>
        )}
      </div>
    </div>
  );
}
