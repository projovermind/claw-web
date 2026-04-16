import fs from 'node:fs/promises';

const CACHE_MS = 30_000;

export function createHealthCheck({ botPidFile }) {
  let cache = null;
  let cacheAt = 0;

  async function checkBot() {
    try {
      const raw = await fs.readFile(botPidFile, 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return { botOnline: false, botPid: null };
      try {
        process.kill(pid, 0);
        return { botOnline: true, botPid: pid };
      } catch {
        return { botOnline: false, botPid: null };
      }
    } catch {
      return { botOnline: false, botPid: null };
    }
  }

  return {
    async check({ noCache = false } = {}) {
      if (!noCache && cache && Date.now() - cacheAt < CACHE_MS) return cache;
      cache = {
        ...(await checkBot()),
        webUptime: process.uptime(),
        ts: new Date().toISOString()
      };
      cacheAt = Date.now();
      return cache;
    }
  };
}
