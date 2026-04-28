/**
 * Filesystem watch WebSocket bridge — Phase 3
 *
 * Endpoint: /ws/fs-watch?root=<abs>
 *
 * Message protocol (JSON):
 *   client → server:
 *     { type: 'subscribe', root: string }   // switch watched root
 *     { type: 'ping' }
 *   server → client:
 *     { type: 'hello', root: string }
 *     { type: 'event', event: 'add'|'change'|'unlink'|'addDir'|'unlinkDir', path: string }
 *     { type: 'ready' }
 *     { type: 'error', message: string }
 *     { type: 'pong' }
 *
 * Each WS owns at most ONE chokidar watcher. Sending `subscribe` switches it.
 * Root must resolve inside webConfig.allowedRoots.
 */
import { WebSocketServer } from 'ws';
import path from 'node:path';
import url from 'node:url';
import { logger } from '../lib/logger.js';
import { authorizeWsUpgrade } from '../middleware/auth.js';

let chokidar;
let chokidarError = null;
try {
  chokidar = (await import('chokidar')).default;
} catch (err) {
  chokidarError = err;
  logger.warn({ err: err.message }, 'fs-watch: chokidar import failed — live watch disabled');
}

const SKIP_DIRS = ['node_modules', '.git', 'dist', '__pycache__', '.next', '.cache', '.turbo'];

export function attachFsWatchWs(server, { webConfig, adminUsersStore, sessionRegistry }) {
  if (!chokidar) {
    server.on('upgrade', (req, socket) => {
      if (!req.url || !req.url.split('?')[0].startsWith('/ws/fs-watch')) return;
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nchokidar not available: ' + (chokidarError?.message || 'unknown'));
      socket.destroy();
    });
    return { close() {} };
  }

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
    if (pathOnly !== '/ws/fs-watch') return;
    if (webConfig && !authorizeWsUpgrade(req, webConfig, { adminUsersStore, sessionRegistry })) {
      logger.warn('fs-watch: upgrade rejected (auth)');
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
    let watcher = null;
    let currentRoot = null;

    const send = (obj) => {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    };

    const stopWatcher = async () => {
      if (!watcher) return;
      try { await watcher.close(); } catch { /* ignore */ }
      watcher = null;
    };

    const startWatcher = async (rawRoot) => {
      if (typeof rawRoot !== 'string' || !rawRoot) {
        send({ type: 'error', message: 'root required' });
        return;
      }
      const absRoot = path.resolve(rawRoot);
      if (!isInsideAllowed(absRoot)) {
        send({ type: 'error', message: `root outside allowedRoots: ${absRoot}` });
        return;
      }
      await stopWatcher();
      currentRoot = absRoot;
      try {
        watcher = chokidar.watch(absRoot, {
          ignored: (p) => {
            const rel = path.relative(absRoot, p);
            if (!rel) return false;
            const parts = rel.split(path.sep);
            return parts.some((seg) => seg.startsWith('.') || SKIP_DIRS.includes(seg));
          },
          ignoreInitial: true,
          persistent: true,
          depth: 10,
          awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 60 }
        });
        watcher.on('all', (event, p) => {
          if (ws.readyState !== 1) return;
          send({ type: 'event', event, path: p });
        });
        watcher.on('ready', () => send({ type: 'ready' }));
        watcher.on('error', (err) => {
          logger.warn({ err: err.message, root: absRoot }, 'fs-watch: watcher error');
          send({ type: 'error', message: err.message });
        });
        send({ type: 'hello', root: absRoot });
        logger.info({ root: absRoot }, 'fs-watch: subscribed');
      } catch (err) {
        logger.error({ err: err.message, root: absRoot }, 'fs-watch: watch failed');
        send({ type: 'error', message: `watch failed: ${err.message}` });
      }
    };

    if (typeof q.root === 'string' && q.root) {
      startWatcher(q.root);
    } else {
      send({ type: 'hello', root: null });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'subscribe') {
        startWatcher(msg.root);
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      }
    });

    ws.on('close', () => {
      stopWatcher();
      logger.info({ root: currentRoot }, 'fs-watch: ws closed');
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message, root: currentRoot }, 'fs-watch: ws error');
    });
  });

  return {
    close() { wss.close(); }
  };
}
