import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Trash2, Terminal } from 'lucide-react';

const TOKEN_KEY = 'hivemind:auth-token';

interface Props {
  /** Initial CWD (must be inside allowedRoots). */
  cwd: string;
  /** Optional initial command. */
  initialCmd?: string;
  /** Class on the wrapper. */
  className?: string;
  /** Called whenever the exec exits. */
  onExit?: (code: number | null, signal: string | null) => void;
}

type Status = 'idle' | 'connecting' | 'running' | 'done' | 'error';

interface OutputLine {
  id: number;
  stream: 'stdout' | 'stderr' | 'info';
  text: string;
}

/**
 * One-shot command runner with streaming stdout/stderr via `/ws/exec`.
 * Not a TTY — use <Terminal /> for interactive shells.
 */
export default function RunPanel({ cwd, initialCmd = '', className, onExit }: Props) {
  const [cmd, setCmd] = useState(initialCmd);
  const [status, setStatus] = useState<Status>('idle');
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lineIdRef = useRef(0);
  const outRef = useRef<HTMLDivElement>(null);

  const pushLine = useCallback((stream: OutputLine['stream'], text: string) => {
    setLines((ls) => {
      const next = [...ls, { id: ++lineIdRef.current, stream, text }];
      if (next.length > 5000) next.splice(0, next.length - 5000);
      return next;
    });
  }, []);

  useEffect(() => {
    // Autoscroll bottom
    const el = outRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = useCallback(() => {
    if (status === 'running' || status === 'connecting') return;
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setLines([]);
    setExitInfo(null);
    setStatus('connecting');
    lineIdRef.current = 0;

    let token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* noop */ }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams();
    if (token) qs.set('token', token);
    const url = `${proto}://${window.location.host}/ws/exec${qs.toString() ? `?${qs}` : ''}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      pushLine('info', `connect failed: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('error');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'run', cmd: trimmed, cwd }));
    };
    ws.onmessage = (ev) => {
      let msg: { type: string; data?: string; code?: number | null; signal?: string | null; message?: string; pid?: number };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'started') {
        setStatus('running');
        pushLine('info', `▶ pid=${msg.pid} · ${cwd}`);
      } else if (msg.type === 'stdout' && typeof msg.data === 'string') {
        pushLine('stdout', msg.data);
      } else if (msg.type === 'stderr' && typeof msg.data === 'string') {
        pushLine('stderr', msg.data);
      } else if (msg.type === 'exit') {
        setExitInfo({ code: msg.code ?? null, signal: msg.signal ?? null });
        setStatus('done');
        pushLine('info', `◼ exited code=${msg.code ?? '?'}${msg.signal ? ` signal=${msg.signal}` : ''}`);
        onExit?.(msg.code ?? null, msg.signal ?? null);
      } else if (msg.type === 'error') {
        pushLine('info', `error: ${msg.message ?? 'unknown'}`);
        setStatus('error');
      }
    };
    ws.onerror = () => {
      setStatus('error');
      pushLine('info', 'websocket error');
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      setStatus((s) => (s === 'running' || s === 'connecting' ? 'done' : s));
    };
  }, [cmd, cwd, status, pushLine, onExit]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type: 'signal', signal: 'SIGTERM' })); } catch { /* noop */ }
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setExitInfo(null);
  }, []);

  useEffect(() => () => {
    // Cleanup on unmount
    try { wsRef.current?.close(); } catch { /* noop */ }
    wsRef.current = null;
  }, []);

  const running = status === 'running' || status === 'connecting';
  const exitColor = useMemo(() => {
    if (!exitInfo) return '';
    if (exitInfo.signal) return 'text-amber-400';
    return exitInfo.code === 0 ? 'text-emerald-400' : 'text-red-400';
  }, [exitInfo]);

  return (
    <div className={`flex flex-col h-full min-h-0 bg-zinc-950 ${className ?? ''}`}>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 bg-zinc-900/40">
        <Terminal size={14} className="text-zinc-400" />
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !running) {
              e.preventDefault();
              run();
            }
          }}
          placeholder="예: npm run build · git status · make test"
          disabled={running}
          className="flex-1 h-7 px-2 bg-zinc-900 border border-zinc-800 rounded font-mono text-xs text-zinc-200 outline-none focus:border-zinc-700 disabled:opacity-50"
        />
        {!running ? (
          <button
            onClick={run}
            disabled={!cmd.trim()}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="실행 (Enter)"
          >
            <Play size={11} /> 실행
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-red-900/40 hover:bg-red-900/60 text-red-300"
            title="중지 (SIGTERM)"
          >
            <Square size={11} /> 중지
          </button>
        )}
        <button
          onClick={clear}
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
          title="출력 지우기"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="px-2 py-1 border-b border-zinc-800/60 bg-zinc-900/20 text-[10px] font-mono text-zinc-500 flex items-center gap-2">
        <span className="truncate">cwd: {cwd}</span>
        <span className="flex-1" />
        {status === 'idle' && <span>준비됨</span>}
        {status === 'connecting' && <span className="text-sky-400">연결 중…</span>}
        {status === 'running' && <span className="text-amber-400">실행 중…</span>}
        {status === 'done' && exitInfo && (
          <span className={exitColor}>
            종료 · code={exitInfo.code ?? '?'}{exitInfo.signal ? ` · signal=${exitInfo.signal}` : ''}
          </span>
        )}
        {status === 'error' && <span className="text-red-400">오류</span>}
      </div>
      <div
        ref={outRef}
        className="flex-1 min-h-0 overflow-auto bg-black/60 p-2 font-mono text-[12px] leading-tight"
      >
        {lines.length === 0 && (
          <div className="text-zinc-600 text-[11px]">출력이 여기에 스트리밍됩니다…</div>
        )}
        {lines.map((l) => (
          <pre
            key={l.id}
            className={`whitespace-pre-wrap ${
              l.stream === 'stderr' ? 'text-red-300' :
              l.stream === 'info' ? 'text-zinc-500 italic' :
              'text-zinc-200'
            }`}
          >{l.text}</pre>
        ))}
      </div>
    </div>
  );
}
