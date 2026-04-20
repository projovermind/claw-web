import { Router } from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// Module-level process tracker
let tunnelProc = null;
let tunnelState = { running: false, type: null, url: null, pid: null };

// PID 파일 기반 lock — 서버 프로세스 교체(SIGKILL 포함) 돼도 disk 에 남아
// 다음 기동 시 직전 quick tunnel 자식을 정확히 식별/정리 가능.
// 메모리 tunnelState 만으론 서버 교체 시 동기화 불가 → 고아 누적의 근본 원인이었음.
const PID_FILE = path.join(os.homedir(), '.claw-web', '.quick-tunnel.pid');

function writePidFile(pid, type) {
  try {
    fssync.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fssync.writeFileSync(PID_FILE, JSON.stringify({ pid, type, startedAt: new Date().toISOString() }), 'utf8');
  } catch { /* disk full 등 — 비치명 */ }
}

function clearPidFile() {
  try { fssync.unlinkSync(PID_FILE); } catch { /* 이미 없음 */ }
}

function readPidFile() {
  try {
    if (!fssync.existsSync(PID_FILE)) return null;
    return JSON.parse(fssync.readFileSync(PID_FILE, 'utf8'));
  } catch { return null; }
}

function findCloudflaredBin() {
  const candidates = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return null;
}

function findNgrokBin() {
  const candidates = ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok'];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return null;
}

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

async function writeTunnelUrlFile(url) {
  await fs.mkdir(path.dirname(URL_FILE), { recursive: true });
  await fs.writeFile(URL_FILE, url + '\n', 'utf8');
}

async function clearTunnelUrlFile() {
  try {
    await fs.unlink(URL_FILE);
  } catch {
    // 파일이 없으면 무시
  }
}

/**
 * 임시 터널을 spawn 하고 URL 캡처까지 처리. 라우트 핸들러와 자동 기동에서 공유.
 * 이미 실행 중이면 false 반환.
 */
function spawnTunnel(type, domain = null) {
  if (tunnelState.running) return { ok: false, reason: 'already-running' };

  let cmd, args;
  if (type === 'ngrok') {
    const bin = findNgrokBin();
    if (!bin) return { ok: false, reason: 'ngrok-not-installed' };
    cmd = bin;
    args = domain ? ['http', '3838', `--url=${domain}`] : ['http', '3838'];
  } else if (type === 'cloudflared') {
    const bin = findCloudflaredBin();
    if (!bin) return { ok: false, reason: 'cloudflared-not-installed' };
    cmd = bin;
    args = ['tunnel', '--url', 'http://localhost:3838'];
  } else {
    return { ok: false, reason: 'invalid-type' };
  }

  tunnelState = { running: true, type, url: null, pid: null };
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelProc = proc;
  tunnelState.pid = proc.pid;
  writePidFile(proc.pid, type);

  const parseUrl = (data) => {
    const text = data.toString();
    const ngrokMatch = text.match(/https?:\/\/[a-zA-Z0-9\-\.]+\.ngrok(?:\.io|[-\w]*)?[^\s]*/);
    const cfMatch = text.match(/https?:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com[^\s]*/);
    const genericMatch = text.match(/https?:\/\/[a-zA-Z0-9\-\.]+\.[a-z]{2,}[^\s]*/);
    const found = ngrokMatch?.[0] ?? cfMatch?.[0] ?? genericMatch?.[0];
    if (found && !tunnelState.url) {
      const url = found.trim();
      tunnelState.url = url;
      writeTunnelUrlFile(url).catch(() => {});
    }
  };
  proc.stdout.on('data', parseUrl);
  proc.stderr.on('data', parseUrl);

  proc.on('exit', () => {
    tunnelProc = null;
    tunnelState = { running: false, type: null, url: null, pid: null };
    clearTunnelUrlFile().catch(() => {});
    clearPidFile();
  });

  return { ok: true, state: tunnelState };
}

/**
 * 서버 기동 시 자동으로 임시 cloudflared 터널을 띄움.
 * - cloudflared 없으면 skip
 * - 이 프로세스에서 이미 실행 중이면 skip
 * - 이전 서버가 남긴 quick tunnel 고아가 있으면 SIGTERM 후 재스폰
 *   (서버 재기동 시 stdio pipe 끊어진 cloudflared 는 URL 캡처 불가 → 재사용 불가)
 * - Named Tunnel(고정) 과는 독립 — 둘 다 동시 구동 가능
 */
export async function autoStartQuickTunnel({ logger } = {}) {
  const log = logger || console;
  try {
    if (tunnelState.running) return { skipped: 'already-running' };

    const bin = findCloudflaredBin();
    if (!bin) {
      log.info?.('auto-tunnel: cloudflared not found — skipping auto quick tunnel');
      return { skipped: 'no-cloudflared' };
    }

    // ── 이중 방어선: 고아 누적 완전 차단 ─────────────────────────────
    // 1차: PID 파일 — 이전 서버가 남긴 정확한 PID 식별 (SIGKILL 에도 disk 에 남음)
    // 2차: pgrep — PID 파일이 손상됐거나 다른 수단으로 뜬 cloudflared 까지 포착
    const pidsToKill = new Set();

    const prior = readPidFile();
    if (prior?.pid && prior.pid !== process.pid) {
      try {
        process.kill(prior.pid, 0); // liveness probe
        pidsToKill.add(prior.pid);
        log.warn?.({ pid: prior.pid, startedAt: prior.startedAt },
          'auto-tunnel: stale PID file points to live process — will terminate');
      } catch {
        // 이미 죽음 — PID 파일만 정리
        clearPidFile();
      }
    }

    try {
      const { execFileSync } = await import('node:child_process');
      const stdout = execFileSync('pgrep', ['-f', 'cloudflared tunnel --url http://localhost:3838'],
        { encoding: 'utf8', timeout: 3000 });
      for (const p of stdout.trim().split('\n').filter(Boolean).map(Number)) {
        if (p !== process.pid) pidsToKill.add(p);
      }
    } catch { /* pgrep no match = 깨끗함 */ }

    if (pidsToKill.size > 0) {
      log.warn?.({ count: pidsToKill.size, pids: [...pidsToKill] },
        'auto-tunnel: killing orphan quick tunnel(s) before spawn');
      for (const pid of pidsToKill) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      }
      // 그라운드 프로세스에 SIGTERM 전달 시간
      await new Promise((r) => setTimeout(r, 1500));
      // 살아남은 것 SIGKILL
      for (const pid of pidsToKill) {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* ok */ }
      }
      clearPidFile();
    }

    const result = spawnTunnel('cloudflared');
    if (result.ok) {
      log.info?.({ pid: result.state.pid }, 'auto-tunnel: cloudflared quick tunnel started');
    } else {
      log.warn?.({ reason: result.reason }, 'auto-tunnel: failed to start');
    }
    return result;
  } catch (err) {
    log.error?.({ err: err.message }, 'auto-tunnel: error');
    return { skipped: 'error', error: err.message };
  }
}

/**
 * 서버 종료 시 호출. 자식 tunnel process 를 명시적으로 SIGTERM 하고 PID 파일 제거.
 * 정상 shutdown 경로에서만 동작 — SIGKILL 케이스는 다음 기동 시 auto-cleanup 이 처리.
 */
export function stopQuickTunnel() {
  try {
    if (tunnelProc && typeof tunnelProc.kill === 'function') {
      tunnelProc.kill('SIGTERM');
    }
  } catch { /* 이미 종료됨 */ }
  clearPidFile();
}

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
    const { type, domain } = req.body ?? {};
    if (type !== 'ngrok' && type !== 'cloudflared') {
      return res.status(400).json({ error: 'type must be "ngrok" or "cloudflared"' });
    }
    const result = spawnTunnel(type, domain);
    if (!result.ok) {
      const code = result.reason === 'already-running' ? 409 : 400;
      return res.status(code).json({ error: result.reason, state: tunnelState });
    }
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
    clearTunnelUrlFile().catch(() => {});
    res.json({ ok: true });
  });

  // GET /status
  router.get('/status', (req, res) => {
    res.json(tunnelState);
  });

  return router;
}
