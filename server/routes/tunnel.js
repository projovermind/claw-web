import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// Module-level process tracker
let tunnelProc = null;
let tunnelState = { running: false, type: null, url: null, pid: null };

/**
 * Exposes the current Cloudflare quick-tunnel URL captured by the cloudflared
 * wrapper (~/bin/cloudflared-start.sh). The wrapper grep's cloudflared's log
 * for a trycloudflare.com hostname and writes it to `tunnel-url.txt`. This
 * endpoint just reads that file so the UI can surface the current URL.
 *
 * If the file is missing/empty, the tunnel isn't up yet (cloudflared is
 * still negotiating) and we return { url: null }.
 */
const URL_FILE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'hivemind',
  'tunnel-url.txt'
);

export function createTunnelRouter() {
  const router = Router();

  router.get('/url', async (req, res, next) => {
    try {
      let url = null;
      try {
        const raw = await fs.readFile(URL_FILE, 'utf8');
        const trimmed = raw.trim();
        if (trimmed) url = trimmed;
      } catch {
        // File missing — tunnel not running yet
      }
      res.json({ url, file: URL_FILE });
    } catch (err) {
      next(err);
    }
  });

  // POST /start
  router.post('/start', (req, res) => {
    if (tunnelState.running) {
      return res.status(409).json({ error: 'Tunnel already running', state: tunnelState });
    }

    const { type, domain } = req.body ?? {};
    if (type !== 'ngrok' && type !== 'cloudflared') {
      return res.status(400).json({ error: 'type must be "ngrok" or "cloudflared"' });
    }

    let cmd, args;
    if (type === 'ngrok') {
      cmd = 'ngrok';
      args = domain ? ['http', '3838', `--url=${domain}`] : ['http', '3838'];
    } else {
      cmd = 'cloudflared';
      args = ['tunnel', '--url', 'http://localhost:3838'];
    }

    tunnelState = { running: true, type, url: null, pid: null };

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProc = proc;
    tunnelState.pid = proc.pid;

    const parseUrl = (data) => {
      const text = data.toString();
      // ngrok: look for https://*.ngrok.io or custom domain
      const ngrokMatch = text.match(/https?:\/\/[a-zA-Z0-9\-\.]+\.ngrok(?:\.io|[-\w]*)?[^\s]*/);
      // cloudflared: look for trycloudflare.com or custom domain
      const cfMatch = text.match(/https?:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com[^\s]*/);
      // generic fallback
      const genericMatch = text.match(/https?:\/\/[a-zA-Z0-9\-\.]+\.[a-z]{2,}[^\s]*/);
      const found = ngrokMatch?.[0] ?? cfMatch?.[0] ?? genericMatch?.[0];
      if (found && !tunnelState.url) {
        tunnelState.url = found.trim();
      }
    };

    proc.stdout.on('data', parseUrl);
    proc.stderr.on('data', parseUrl);

    proc.on('exit', () => {
      tunnelProc = null;
      tunnelState = { running: false, type: null, url: null, pid: null };
    });

    res.json({ ok: true, state: tunnelState });
  });

  // POST /stop
  router.post('/stop', (req, res) => {
    if (!tunnelState.running || !tunnelProc) {
      return res.status(409).json({ error: 'No tunnel running' });
    }
    tunnelProc.kill();
    tunnelProc = null;
    tunnelState = { running: false, type: null, url: null, pid: null };
    res.json({ ok: true });
  });

  // GET /status
  router.get('/status', (req, res) => {
    res.json(tunnelState);
  });

  return router;
}
