/**
 * One-shot command executor with live stdout/stderr streaming — Phase 4
 *
 * Endpoint: /ws/exec
 *
 * Intended for UI-triggered ad-hoc commands (eg. "Run test", "Run build") where
 * the user wants to see streaming output. Distinct from `/ws/pty` which is
 * an interactive TTY. This endpoint spawns a single non-interactive process
 * per WS connection and ends when that process exits.
 *
 * Protocol:
 *   client → server:
 *     { type: 'run', cmd: string, cwd?: string, timeoutMs?: number }  // once per ws
 *     { type: 'stdin', data: string }
 *     { type: 'signal', signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' }
 *     { type: 'ping' }
 *   server → client:
 *     { type: 'hello' }
 *     { type: 'started', pid: number, cwd: string, cmd: string }
 *     { type: 'stdout', data: string }
 *     { type: 'stderr', data: string }
 *     { type: 'exit', code: number | null, signal: string | null }
 *     { type: 'error', message: string }
 *     { type: 'pong' }
 *
 * Security: requires auth (same `authorizeWsUpgrade`), and cwd (if provided)
 * must resolve inside webConfig.allowedRoots. Command runs via the user's
 * shell with `-c`; that's equivalent to what the user could do via the
 * terminal endpoint — no new privilege is granted.
 */
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { logger } from '../lib/logger.js';
import { authorizeWsUpgrade } from '../middleware/auth.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min
const MAX_TIMEOUT_MS = 60 * 60 * 1000;      // 1 hour ceiling

export function attachExecWs(server, { webConfig }) {
  const wss = new WebSocketServer({ noServer: true });

  function resolveAllowedRoots() {
    return (webConfig.allowedRoots ?? []).map((r) => path.resolve(r));
  }
  function isInsideAllowed(absPath) {
    const resolved = path.resolve(absPath);
    const roots = resolveAllowedRoots();
    return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  server.on('upgrade', (req, socket, head) => {
    const pathOnly = (req.url || '').split('?')[0];
    if (pathOnly !== '/ws/exec') return;
    if (webConfig && !authorizeWsUpgrade(req, webConfig)) {
      logger.warn('exec: upgrade rejected (auth)');
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

    let child = null;
    let started = false;
    let timeoutHandle = null;

    const send = (obj) => {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    };

    send({ type: 'hello' });

    const startRun = (params) => {
      if (started) {
        send({ type: 'error', message: 'already started' });
        return;
      }
      started = true;

      const cmd = typeof params.cmd === 'string' ? params.cmd.trim() : '';
      if (!cmd) {
        send({ type: 'error', message: 'cmd required' });
        ws.close();
        return;
      }
      if (cmd.length > 16 * 1024) {
        send({ type: 'error', message: 'cmd too long (16KB max)' });
        ws.close();
        return;
      }

      let cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd();
      cwd = path.resolve(cwd);
      if (!isInsideAllowed(cwd)) {
        send({ type: 'error', message: `cwd outside allowedRoots: ${cwd}` });
        ws.close();
        return;
      }
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
      } catch (err) {
        send({ type: 'error', message: `invalid cwd: ${err.message}` });
        ws.close();
        return;
      }

      const timeoutMs = Math.min(
        Math.max(parseInt(params.timeoutMs, 10) || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
      );

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
      try {
        child = spawn(shell, ['-c', cmd], {
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', CI: 'true', FORCE_COLOR: '1' }
        });
      } catch (err) {
        logger.error({ err: err.message, cwd }, 'exec: spawn failed');
        send({ type: 'error', message: `spawn failed: ${err.message}` });
        ws.close();
        return;
      }

      logger.info({ pid: child.pid, cwd, cmd: cmd.slice(0, 200) }, 'exec: started');
      send({ type: 'started', pid: child.pid, cwd, cmd });

      child.stdout.on('data', (chunk) => send({ type: 'stdout', data: chunk.toString('utf8') }));
      child.stderr.on('data', (chunk) => send({ type: 'stderr', data: chunk.toString('utf8') }));

      child.on('error', (err) => {
        logger.warn({ err: err.message, pid: child?.pid }, 'exec: child error');
        send({ type: 'error', message: err.message });
      });

      child.on('close', (code, signal) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        logger.info({ pid: child?.pid, code, signal }, 'exec: exited');
        send({ type: 'exit', code, signal: signal ?? null });
        try { ws.close(); } catch { /* ignore */ }
        child = null;
      });

      timeoutHandle = setTimeout(() => {
        if (!child) return;
        logger.warn({ pid: child.pid, timeoutMs }, 'exec: timeout — sending SIGTERM then SIGKILL');
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
      }, timeoutMs);
    };

    // Allow kick-off via query string for convenience (no body round-trip)
    if (typeof q.cmd === 'string' && q.cmd) {
      startRun({
        cmd: q.cmd,
        cwd: typeof q.cwd === 'string' ? q.cwd : undefined,
        timeoutMs: parseInt(q.timeoutMs, 10) || undefined
      });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'run') {
        startRun(msg);
      } else if (msg.type === 'stdin' && child && typeof msg.data === 'string') {
        try { child.stdin.write(msg.data); } catch { /* ignore */ }
      } else if (msg.type === 'signal' && child) {
        const sig = ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(msg.signal) ? msg.signal : 'SIGTERM';
        try { child.kill(sig); } catch { /* ignore */ }
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      }
    });

    ws.on('close', () => {
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
      }
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message, pid: child?.pid }, 'exec: ws error');
    });
  });

  return {
    close() { wss.close(); }
  };
}
