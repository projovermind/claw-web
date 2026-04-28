/**
 * PTY WebSocket bridge — Phase 2
 *
 * Endpoint: /ws/pty?cwd=<path>&cols=<n>&rows=<n>
 *
 * Message protocol (JSON):
 *   client → server:
 *     { type: 'input', data: string }
 *     { type: 'resize', cols: number, rows: number }
 *     { type: 'ping' }
 *   server → client:
 *     { type: 'hello', pid: number, cwd: string }
 *     { type: 'output', data: string }
 *     { type: 'exit', code: number, signal: string | null }
 *     { type: 'error', message: string }
 */
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import url from 'node:url';
import { logger } from '../lib/logger.js';
import { authorizeWsUpgrade } from '../middleware/auth.js';

const MAX_SESSIONS_PER_CLIENT = 4;

let pty;
let ptyError = null;
try {
  pty = await import('node-pty');
} catch (err) {
  ptyError = err;
  logger.warn({ err: err.message }, 'pty: node-pty import failed — terminal disabled');
}

export function attachPtyWs(server, { webConfig, adminUsersStore, sessionRegistry }) {
  if (!pty) {
    // Still register the upgrade so the client gets a clean 503 instead of hanging.
    server.on('upgrade', (req, socket) => {
      if (!req.url || !req.url.startsWith('/ws/pty')) return;
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nnode-pty not available: ' + (ptyError?.message || 'unknown'));
      socket.destroy();
    });
    return { close() {} };
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/pty')) return;
    if (webConfig && !authorizeWsUpgrade(req, webConfig, { adminUsersStore, sessionRegistry })) {
      logger.warn('pty: upgrade rejected (auth)');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const parsed = url.parse(req.url, true);
    const q = parsed.query || {};
    let cwd = typeof q.cwd === 'string' && q.cwd ? q.cwd : process.env.HOME || process.cwd();

    // Resolve/validate cwd
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) cwd = process.env.HOME || process.cwd();
    } catch {
      cwd = process.env.HOME || process.cwd();
    }

    const cols = Math.max(20, Math.min(500, parseInt(q.cols, 10) || 100));
    const rows = Math.max(5, Math.min(200, parseInt(q.rows, 10) || 30));

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    let term;
    try {
      term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });
    } catch (err) {
      logger.error({ err: err.message, cwd }, 'pty: spawn failed');
      try {
        ws.send(JSON.stringify({ type: 'error', message: `PTY spawn failed: ${err.message}` }));
      } catch { /* ignore */ }
      ws.close();
      return;
    }

    logger.info({ pid: term.pid, cwd, shell, cols, rows }, 'pty: spawned');

    try {
      ws.send(JSON.stringify({ type: 'hello', pid: term.pid, cwd, shell }));
    } catch { /* ignore */ }

    // Backpressure-friendly forwarding of pty stdout/stderr to ws
    term.onData((data) => {
      if (ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: 'output', data }));
      } catch { /* ignore */ }
    });

    term.onExit(({ exitCode, signal }) => {
      logger.info({ pid: term.pid, exitCode, signal }, 'pty: exited');
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal: signal ?? null }));
        }
      } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        try { term.write(msg.data); } catch { /* ignore */ }
      } else if (msg.type === 'resize') {
        const c = Math.max(20, Math.min(500, parseInt(msg.cols, 10) || cols));
        const r = Math.max(5, Math.min(200, parseInt(msg.rows, 10) || rows));
        try { term.resize(c, r); } catch { /* ignore */ }
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
      }
    });

    ws.on('close', () => {
      try { term.kill(); } catch { /* ignore */ }
      logger.info({ pid: term.pid }, 'pty: ws closed, terminal killed');
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message, pid: term.pid }, 'pty: ws error');
    });
  });

  return {
    close() {
      wss.close();
    }
  };
}

// Unused — retained for potential future multi-session-per-ws model
export const _MAX_SESSIONS_PER_CLIENT = MAX_SESSIONS_PER_CLIENT;
