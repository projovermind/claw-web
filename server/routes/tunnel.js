import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

  return router;
}
