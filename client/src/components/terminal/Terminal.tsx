import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const TOKEN_KEY = 'hivemind:auth-token';

interface Props {
  cwd: string;
  /** Optional class on the wrapper div. */
  className?: string;
  /** Unique key for this terminal instance. Changing it destroys + recreates the terminal. */
  instanceKey?: string;
  onStatusChange?: (status: 'connecting' | 'open' | 'closed' | 'error') => void;
}

/**
 * xterm.js wrapper connected to the PTY WebSocket bridge at `/ws/pty?cwd=...`.
 */
export default function Terminal({ cwd, className, instanceKey, onStatusChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#38bdf8',
        selectionBackground: '#3f3f46'
      },
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Initial fit
    const doFit = () => {
      try {
        fit.fit();
      } catch { /* container not ready */ }
    };
    // Slight delay to allow layout
    requestAnimationFrame(doFit);

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = (() => {
      try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
    })();
    const params = new URLSearchParams();
    params.set('cwd', cwd || '');
    params.set('cols', String(term.cols));
    params.set('rows', String(term.rows));
    if (token) params.set('token', token);
    const wsUrl = `${proto}//${window.location.host}/ws/pty?${params.toString()}`;
    const ws = new WebSocket(wsUrl);

    const setS = (s: 'connecting' | 'open' | 'closed' | 'error') => {
      setStatus(s);
      onStatusChange?.(s);
    };

    ws.onopen = () => {
      setS('open');
      term.focus();
    };

    ws.onmessage = (ev) => {
      let msg: { type: string; data?: string; message?: string; code?: number; pid?: number; cwd?: string } | null = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg) return;
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[33m[process exited code=${msg.code}]\x1b[0m\r\n`);
        setS('closed');
      } else if (msg.type === 'error') {
        setErrMsg(msg.message || 'terminal error');
        term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
        setS('error');
      } else if (msg.type === 'hello') {
        term.write(`\x1b[90m[connected pid=${msg.pid} cwd=${msg.cwd}]\x1b[0m\r\n`);
      }
    };

    ws.onerror = () => {
      setS('error');
    };

    ws.onclose = () => {
      setS('closed');
    };

    const dataDisposable = term.onData((data) => {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type: 'input', data })); } catch { /* ignore */ }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* ignore */ }
    });

    // Window + parent size changes
    const ro = new ResizeObserver(() => {
      doFit();
    });
    ro.observe(el);
    const onWindowResize = () => doFit();
    window.addEventListener('resize', onWindowResize);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      try { ws.close(); } catch { /* ignore */ }
      term.dispose();
    };
    // Purposely not including onStatusChange — treat it as a stable callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, instanceKey]);

  return (
    <div className={`relative w-full h-full bg-zinc-950 ${className ?? ''}`}>
      <div ref={containerRef} className="absolute inset-0 p-2" />
      {status !== 'open' && (
        <div className="absolute top-1 right-2 text-[11px] text-zinc-500 font-mono pointer-events-none">
          {status === 'connecting' && 'connecting…'}
          {status === 'closed' && 'disconnected'}
          {status === 'error' && (errMsg || 'error')}
        </div>
      )}
    </div>
  );
}
