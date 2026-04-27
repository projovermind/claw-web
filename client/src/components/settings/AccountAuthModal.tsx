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
  // 기본 탭: Pro/Max 구독자가 다수 → 백업/복원 우선 노출.
  //  managed API 토큰이 이미 설정돼 있으면 token 탭으로.
  const [tab, setTab] = useState<Tab>(backend.oauthSource === 'managed' ? 'token' : 'backup');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
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

        <div className="border-b border-zinc-800 px-2 flex gap-1 text-xs overflow-x-auto">
          <TabButton current={tab} value="backup" onClick={() => setTab('backup')} icon={<Download size={12} />} label="백업/복원" badge="Pro/Max" badgeTone="emerald" />
          <TabButton current={tab} value="terminal" onClick={() => setTab('terminal')} icon={<Terminal size={12} />} label="Terminal" badge="신규" badgeTone="sky" />
          <TabButton current={tab} value="headless" onClick={() => setTab('headless')} icon={<Globe size={12} />} label="헤드리스" badge="실험적" badgeTone="amber" />
          <TabButton current={tab} value="token" onClick={() => setTab('token')} icon={<Key size={12} />} label="토큰 붙여넣기" badge="API" badgeTone="amber" />
        </div>

        <div className="mx-4 mt-3 rounded border border-sky-900/50 bg-sky-950/30 p-2.5 text-[11px] text-sky-200 leading-relaxed">
          <div className="font-semibold mb-1">📌 어떤 방법을 써야 하나요?</div>
          <ul className="space-y-0.5 list-disc pl-4">
            <li><span className="text-emerald-300 font-semibold">Pro/Max 구독권</span> — <span className="font-semibold">백업/복원</span> 또는 <span className="font-semibold">헤드리스/Terminal 로그인</span> (구독 한도 사용)</li>
            <li><span className="text-amber-300 font-semibold">API 토큰</span> (sk-ant-oat01-...) — <span className="font-semibold">토큰 붙여넣기</span> (API 크레딧 결제, 구독권과 별개)</li>
          </ul>
          <div className="mt-1 text-sky-300/70">
            ※ 구독권 토큰은 <span className="font-semibold">웹 콘솔에서 조회·복사 불가</span>합니다 — 오직 <code className="text-sky-300">claude login</code> 으로만 발급되며, 이미 로그인된 머신의 <code>.credentials.json</code> 을 백업/복원하는 게 가장 실용적입니다.
          </div>
        </div>

        {/* configDir 상태 — 자동 생성됨/사용자지정 표시 (초보자 안내) */}
        <div className="mx-4 mt-3 rounded border border-zinc-800 bg-zinc-950/60 p-2.5 text-[11px] text-zinc-400 leading-relaxed">
          <div className="flex items-start gap-2">
            <span className="text-zinc-500 shrink-0">📁</span>
            <div className="flex-1 min-w-0">
              {backend.configDirAutoCreated ? (
                <>
                  <span className="text-emerald-300 font-semibold">자동 생성됨</span>
                  <span className="text-zinc-500"> — 별도 설정 없이 사용 가능합니다.</span>
                </>
              ) : (
                <>
                  <span className="text-sky-300 font-semibold">사용자 지정</span>
                  <span className="text-zinc-500"> — 직접 지정한 경로를 사용합니다.</span>
                </>
              )}
              <div className="mt-0.5 font-mono text-zinc-500 truncate" title={backend.configDir}>
                {backend.configDir || '—'}
              </div>
            </div>
          </div>
        </div>

        {backend.cred?.keychainShared && (
          <div className="mx-4 mt-3 rounded border border-amber-900/50 bg-amber-950/30 p-2.5 text-[11px] text-amber-200 flex items-start gap-2">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <div className="leading-relaxed">
              <div className="font-semibold">macOS Keychain 공유 경고</div>
              현재 토큰이 macOS 시스템 키체인(<code className="text-amber-300">"Claude Code-credentials"</code>)에 저장돼 있습니다.
              이 항목은 <span className="font-semibold">시스템 전역 1개</span>만 존재해 — 다른 백엔드에서 <code>claude login</code> 을 실행하면 <span className="font-semibold">덮어쓰기</span> 됩니다.
              여러 구독 계정을 관리한다면 <span className="font-semibold text-amber-100">"백업/복원"</span> 탭으로 <code>.credentials.json</code> 을 백엔드별 configDir 에 격리 보관하는 것을 권장합니다.
            </div>
          </div>
        )}

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
  current, value, onClick, icon, label, badge, badgeTone = 'emerald',
}: {
  current: Tab; value: Tab; onClick: () => void; icon: React.ReactNode; label: string;
  badge?: string; badgeTone?: 'emerald' | 'sky' | 'amber';
}) {
  const active = current === value;
  const toneClass =
    badgeTone === 'amber' ? 'bg-amber-900/50 text-amber-300'
    : badgeTone === 'sky' ? 'bg-sky-900/50 text-sky-300'
    : 'bg-emerald-900/50 text-emerald-300';
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 px-3 py-2 transition-colors border-b-2 whitespace-nowrap shrink-0 ${
        active ? 'border-sky-500 text-sky-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
      {badge && <span className={`ml-1 px-1 rounded text-[9px] whitespace-nowrap ${toneClass}`}>{badge}</span>}
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
      <div className="rounded border border-amber-900/50 bg-amber-950/30 p-3 text-[12px] text-amber-200/90 leading-relaxed">
        <div className="font-semibold mb-1">⚠️ 이 방법은 API 결제용입니다 (구독권 아님)</div>
        Anthropic Console 의 <span className="font-semibold">"OAuth Tokens"</span> 메뉴에서 발급한
        long-lived 토큰(<code className="text-amber-300">sk-ant-oat01-...</code>) 은 <span className="font-semibold">API 크레딧으로 결제</span>됩니다 — Pro/Max 구독권 한도와 별개.
        <div className="mt-1 text-amber-300/70">
          ※ Pro/Max 구독권을 쓰려면 <span className="font-semibold">"백업/복원"</span> 또는 <span className="font-semibold">"헤드리스 로그인"</span> 탭을 사용하세요.
        </div>
        <div className="mt-1 text-amber-300/60">
          토큰은 secrets.json 에 백엔드별 격리 저장되며 spawn 시 <code className="text-amber-300">CLAUDE_CODE_OAUTH_TOKEN</code> 으로 주입됩니다.
        </div>
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
      <div className="rounded border border-amber-900/50 bg-amber-950/30 p-3 text-[12px] text-amber-200 leading-relaxed flex items-start gap-2">
        <AlertCircle size={13} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold mb-1">⚠️ Claude Code 2.x 호환성 문제</div>
          이 방식은 <code className="text-amber-300">claude login</code> 서브커맨드를 가정하고 만들어졌으나,
          Claude Code v2.x 부터는 로그인이 <span className="font-semibold">TUI 내부의 <code>/login</code> 슬래시</span>로 이전돼
          헤드리스 캡쳐가 <span className="font-semibold">대부분의 환경에서 동작하지 않습니다</span>.
          <div className="mt-1 text-amber-300/80">
            👉 권장: <span className="font-semibold">"Terminal 로그인"</span> 탭에서 Terminal 을 열어 <code>/login</code> 직접 수행 → 완료 후 "백업/복원" 으로 다른 머신에 이전.
          </div>
        </div>
      </div>

      {!state.started && (
        <>
          <button
            onClick={() => start.mutate()}
            disabled={start.isPending}
            className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 px-3 py-2 text-white"
          >{start.isPending ? '시작 중...' : '헤드리스 로그인 시작'}</button>
          {start.isError && (
            <div className="text-[11px] text-red-400 rounded border border-red-900/50 bg-red-950/30 p-2">
              ❌ 시작 실패: {(start.error as Error).message}
            </div>
          )}
        </>
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
              {sendCode.isError && (
                <div className="text-[11px] text-red-400">전송 실패: {(sendCode.error as Error).message}</div>
              )}
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
  // Claude Code v2.x: `claude login` 서브커맨드는 더 이상 OAuth 플로우를 직접 띄우지 않음.
  //  → `claude` 로 TUI 진입한 뒤 `/login` 슬래시 명령으로 로그인해야 함.
  const cmd = `CLAUDE_CONFIG_DIR=${backend.configDir ?? ''} claude`;
  const loginMut = useMutation({ mutationFn: () => api.loginAccount(backend.id) });

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded border border-sky-900/50 bg-sky-950/30 p-3 text-[12px] text-sky-200 leading-relaxed">
        <div className="font-semibold mb-1">📋 정확한 절차 (Claude Code v2.x)</div>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>아래 버튼으로 Terminal 열기 (<code className="text-sky-300">claude</code> TUI 자동 실행)</li>
          <li>TUI 안에서 <code className="text-sky-300">/login</code> 슬래시 명령 입력</li>
          <li>브라우저 OAuth 완료 → 토큰이 configDir / Keychain 에 자동 저장</li>
          <li>이 모달을 닫고 백엔드 목록에서 ✅ 인증 배지 확인</li>
        </ol>
        <div className="mt-1.5 text-sky-300/70">
          ※ 구버전(<code>claude login</code> 서브커맨드)은 v2.x 부터 동작하지 않습니다.
        </div>
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
      >{loginMut.isPending ? '여는 중...' : 'Terminal 열기 (TUI 자동 실행)'}</button>
      {loginMut.data?.manual && (
        <div className="text-[11px] text-amber-300">macOS 가 아닙니다. 위 명령어를 직접 실행하세요.</div>
      )}
      {loginMut.isError && (
        <div className="text-[11px] text-red-400 rounded border border-red-900/50 bg-red-950/30 p-2">
          ❌ 에러: {(loginMut.error as Error).message}
        </div>
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
        {exportMut.isError && (
          <div className="text-[11px] text-red-400 rounded border border-red-900/50 bg-red-950/30 p-2">
            ❌ 추출 실패: {(exportMut.error as Error).message}
          </div>
        )}
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
