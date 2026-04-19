import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, XCircle, Download, LogIn, RefreshCw, Terminal } from 'lucide-react';
import { api } from '../../lib/api';

type StatusKind = 'ok' | 'broken' | 'missing' | 'error';

/**
 * Claude CLI 상태 카드
 * - 설치 여부 / 버전 / 깨진 상태 감지
 * - 설치 · 재설치 · 로그인(Terminal 열기) 버튼
 * - 설치 진행 중에는 WebSocket 스트림 로그를 모달로 표시
 */
export function ClaudeStatusCard() {
  const qc = useQueryClient();
  const { data: status, refetch } = useQuery({
    queryKey: ['claude-status'],
    queryFn: api.claudeStatus,
    refetchInterval: 5000
  });

  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // WebSocket 스트림 (claude.install.log / claude.install.done) 수신
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      try {
        const msg = JSON.parse(ev.data) as { type: string; line?: string; status?: { status: StatusKind; bin: string | null; version: string | null } };
        if (msg.type === 'claude.install.log' && msg.line) {
          setLogs((prev) => [...prev, msg.line!]);
        } else if (msg.type === 'claude.install.done') {
          setLogs((prev) => [...prev, `\n=== 완료: ${msg.status?.status ?? 'unknown'} ===`]);
          qc.invalidateQueries({ queryKey: ['claude-status'] });
        }
      } catch {
        /* ignore */
      }
    }
    // 기존 WS 에 piggyback — 글로벌 window.addEventListener 가 아닌 직접 새 연결
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('hivemind:auth-token');
    const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws${suffix}`);
    ws.addEventListener('message', onMessage);
    return () => {
      ws.removeEventListener('message', onMessage);
      ws.close();
    };
  }, [qc]);

  // 로그 자동 스크롤
  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, showLogs]);

  const installMut = useMutation({
    mutationFn: (reinstall: boolean) => api.claudeInstall(reinstall),
    onMutate: () => {
      setLogs([]);
      setShowLogs(true);
    },
    onSuccess: () => refetch()
  });
  const loginMut = useMutation({ mutationFn: () => api.claudeLogin() });

  if (!status) return null;

  const kind: StatusKind = status.status;
  const kindMeta: Record<StatusKind, { icon: React.ReactNode; label: string; color: string }> = {
    ok:      { icon: <CheckCircle2 size={18} />, label: '정상',     color: 'text-emerald-400 border-emerald-800 bg-emerald-950/30' },
    broken:  { icon: <AlertTriangle size={18} />, label: '깨짐',     color: 'text-amber-400  border-amber-800  bg-amber-950/30'  },
    missing: { icon: <XCircle size={18} />,       label: '미설치',   color: 'text-zinc-400   border-zinc-700   bg-zinc-900/40'   },
    error:   { icon: <AlertTriangle size={18} />, label: '에러',     color: 'text-red-400    border-red-800    bg-red-950/30'    }
  };
  const m = kindMeta[kind];

  return (
    <>
      <div className={`rounded-lg border ${m.color} p-4 space-y-3`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {m.icon}
            <span className="text-sm font-semibold">Claude CLI — {m.label}</span>
            {status.installing && (
              <span className="text-[10px] uppercase tracking-wider text-emerald-300 animate-pulse">설치 중…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {kind === 'ok' && (
              <button
                onClick={() => loginMut.mutate()}
                className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs flex items-center gap-1"
                title="Terminal.app 에서 `claude login` 실행"
              >
                <LogIn size={12} /> Claude 로그인
              </button>
            )}
            {(kind === 'missing') && (
              <button
                onClick={() => installMut.mutate(false)}
                disabled={status.installing}
                className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-1.5 text-xs flex items-center gap-1"
              >
                <Download size={12} /> Claude CLI 설치
              </button>
            )}
            {(kind === 'broken' || kind === 'error' || kind === 'ok') && (
              <button
                onClick={() => installMut.mutate(true)}
                disabled={status.installing}
                className="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 px-3 py-1.5 text-xs flex items-center gap-1"
              >
                <RefreshCw size={12} /> 재설치
              </button>
            )}
            {logs.length > 0 && (
              <button
                onClick={() => setShowLogs(true)}
                className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs flex items-center gap-1"
              >
                <Terminal size={12} /> 로그
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-zinc-400">
          <div>
            <div className="uppercase tracking-wider text-zinc-500">경로</div>
            <div className="font-mono truncate">{status.bin ?? '—'}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider text-zinc-500">버전</div>
            <div className="font-mono">{status.version ?? '—'}</div>
          </div>
          <div>
            <div className="uppercase tracking-wider text-zinc-500">상태</div>
            <div className="font-mono">{kind}</div>
          </div>
        </div>
        {status.error && (
          <div className="text-[11px] text-amber-400 font-mono whitespace-pre-wrap break-all">
            {status.error}
          </div>
        )}
        {kind === 'missing' && (
          <div className="text-[11px] text-zinc-500">
            Claude CLI 는 웹 UI 안에서 직접 설치할 수 있습니다. [설치] 버튼을 누르면 npm install 이 자동 실행되고 설치 완료 후 로그인까지 이어서 진행 가능합니다.
          </div>
        )}
      </div>

      {/* 설치 진행 로그 모달 */}
      {showLogs && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowLogs(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Terminal size={14} /> Claude CLI 설치 로그
              </div>
              <button onClick={() => setShowLogs(false)} className="text-zinc-400 hover:text-white text-xs">닫기</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] whitespace-pre-wrap text-zinc-300 bg-zinc-950">
              {logs.length === 0 ? (
                <div className="text-zinc-500">설치를 시작하면 로그가 여기에 표시됩니다.</div>
              ) : (
                logs.map((l, i) => <div key={i}>{l}</div>)
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
