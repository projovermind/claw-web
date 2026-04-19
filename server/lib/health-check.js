import fs from 'node:fs/promises';

const CACHE_MS = 30_000;

export function createHealthCheck({ botPidFile }) {
  let cache = null;
  let cacheAt = 0;

  async function checkBot() {
    // botPidFile 미설정 → 외부 봇 연동 안 쓰는 환경. 'not configured' 로 반환해서
    // 클라이언트가 위젯을 숨기거나 다른 표시로 전환할 수 있게 함.
    if (!botPidFile) return { botOnline: false, botPid: null, botConfigured: false };
    try {
      const raw = await fs.readFile(botPidFile, 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return { botOnline: false, botPid: null, botConfigured: true };
      try {
        process.kill(pid, 0);
        return { botOnline: true, botPid: pid, botConfigured: true };
      } catch {
        return { botOnline: false, botPid: null, botConfigured: true };
      }
    } catch {
      return { botOnline: false, botPid: null, botConfigured: true };
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
