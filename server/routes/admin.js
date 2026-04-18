/**
 * Admin Router — 서버 관리 작업 (재시작, Named Tunnel 설치/제거)
 *
 * 엔드포인트:
 *   POST /restart             — 서버 재시작 (soft: pending-resume 저장 / force: 무시 후 즉시)
 *   POST /tunnel/cf/login     — cloudflared tunnel login 트리거 (브라우저 URL 반환)
 *   GET  /tunnel/cf/status    — cloudflared 설정 상태 (cert.pem / 터널 / DNS)
 *   POST /tunnel/cf/setup     — Named Tunnel 전체 자동 구축 (hostname 주면 다 해줌)
 *   POST /tunnel/cf/teardown  — Named Tunnel 제거 (터널 삭제 + plist unload)
 */
import { Router } from 'express';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

const CF_DIR = path.join(os.homedir(), '.cloudflared');
const CERT_PATH = path.join(CF_DIR, 'cert.pem');
const CONFIG_PATH = path.join(CF_DIR, 'config.yml');
const TUNNEL_NAME = 'claw-web';
const LA_LABEL = 'com.claw-web.tunnel';
const LA_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LA_LABEL}.plist`);

// 진행 상태 메모리 보관 (polling 용)
const setupState = { phase: 'idle', loginUrl: null, hostname: null, tunnelId: null, error: null };

function findCloudflaredBin() {
  const candidates = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return 'cloudflared';
}

export function createAdminRouter({ runner }) {
  const router = Router();

  // ───────────────────────────────────────────────────────
  // POST /restart — 서버 재시작
  // body: { force?: boolean }
  //   force=false (기본): SIGTERM → shutdown handler → pending-resume 저장 → launchd 재시작
  //   force=true        : pending-resume 무시 + 활성 에이전트 abort + 즉시 exit
  // ───────────────────────────────────────────────────────
  router.post('/restart', (req, res) => {
    const force = req.body?.force === true;
    const activeCount = runner.activeIds().length;
    logger.warn({ force, activeCount }, 'admin: restart requested via API');

    res.json({
      ok: true,
      mode: force ? 'force' : 'soft',
      activeAgents: activeCount,
      msg: force
        ? `강제 재시작 — 활성 에이전트 ${activeCount}개 즉시 종료`
        : `소프트 재시작 — 활성 ${activeCount}개는 재기동 후 자동 이어가기`
    });

    // 응답 전송 후 재시작 트리거
    setTimeout(() => {
      if (force) {
        // pending-resume 파일 있으면 삭제 (이어가기 방지)
        try {
          const resumeFile = path.join(process.cwd(), 'logs', 'pending-resume.json');
          if (fssync.existsSync(resumeFile)) fssync.unlinkSync(resumeFile);
        } catch { /* ignore */ }
        // 활성 runner abort
        for (const sid of runner.activeIds()) {
          try { runner.abort(sid); } catch { /* ignore */ }
        }
        // 500ms 후 즉시 exit (shutdown handler 스킵)
        setTimeout(() => process.exit(0), 500);
      } else {
        // 정상 shutdown handler 경유
        process.kill(process.pid, 'SIGTERM');
      }
    }, 200);
  });

  // ───────────────────────────────────────────────────────
  // GET /tunnel/cf/status — Cloudflare 설정 상태
  // ───────────────────────────────────────────────────────
  router.get('/tunnel/cf/status', async (req, res) => {
    const bin = findCloudflaredBin();
    const binInstalled = fssync.existsSync(bin) || bin === 'cloudflared';
    const authed = fssync.existsSync(CERT_PATH);

    let tunnelId = null;
    let hostname = null;
    if (authed && binInstalled) {
      try {
        const { stdout } = await execFileAsync(bin, ['tunnel', 'list', '--output', 'json'], { timeout: 10000 });
        const tunnels = JSON.parse(stdout);
        const t = tunnels.find((x) => x.name === TUNNEL_NAME);
        if (t) tunnelId = t.id;
      } catch { /* no tunnel yet */ }
    }
    if (fssync.existsSync(CONFIG_PATH)) {
      try {
        const cfg = fssync.readFileSync(CONFIG_PATH, 'utf8');
        const m = cfg.match(/hostname:\s*(\S+)/);
        if (m) hostname = m[1];
      } catch { /* ignore */ }
    }
    const plistLoaded = fssync.existsSync(LA_PATH);

    res.json({
      binInstalled,
      authed,
      tunnelId,
      hostname,
      plistInstalled: plistLoaded,
      setupState: { ...setupState }
    });
  });

  // ───────────────────────────────────────────────────────
  // POST /tunnel/cf/login — cloudflared tunnel login 실행
  // 브라우저가 열리면서 반환되는 URL 추출 → 프론트엔드가 표시
  // cert.pem 파일 polling 은 /status 엔드포인트로 확인
  // ───────────────────────────────────────────────────────
  router.post('/tunnel/cf/login', async (req, res) => {
    if (fssync.existsSync(CERT_PATH)) {
      return res.json({ ok: true, alreadyAuthed: true });
    }
    const bin = findCloudflaredBin();
    setupState.phase = 'awaiting-auth';
    setupState.loginUrl = null;
    setupState.error = null;

    const proc = spawn(bin, ['tunnel', 'login'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = false;

    const handle = (chunk) => {
      const text = chunk.toString();
      const m = text.match(/https:\/\/dash\.cloudflare\.com\/argotunnel[^\s]*/);
      if (m && !captured) {
        captured = true;
        setupState.loginUrl = m[0];
        logger.info({ url: m[0] }, 'admin: cf login URL captured');
      }
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);

    proc.on('exit', (code) => {
      if (fssync.existsSync(CERT_PATH)) {
        setupState.phase = 'authed';
      } else {
        setupState.phase = 'auth-failed';
        setupState.error = `cloudflared exited ${code} without cert`;
      }
    });

    // 3초 대기 후 URL 반환 (로그 캡처 시간 확보)
    setTimeout(() => {
      res.json({
        ok: true,
        loginUrl: setupState.loginUrl,
        message: setupState.loginUrl
          ? '브라우저가 열렸습니다. 도메인 선택 후 권한 부여를 클릭하세요.'
          : 'cloudflared tunnel login 실행 중 — URL 캡처 실패. 잠시 후 /status 폴링하세요.'
      });
    }, 3000);
  });

  // ───────────────────────────────────────────────────────
  // POST /tunnel/cf/setup — Named Tunnel 전체 설정
  // body: { hostname: 'claw.mydomain.com' }
  // 요구사항: 이미 cert.pem 이 있어야 함 (미리 /login 호출)
  // ───────────────────────────────────────────────────────
  router.post('/tunnel/cf/setup', async (req, res) => {
    const hostname = (req.body?.hostname || '').trim();
    if (!hostname || !/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(hostname)) {
      return res.status(400).json({ error: 'hostname is required (예: claw.mydomain.com)' });
    }
    if (!fssync.existsSync(CERT_PATH)) {
      return res.status(400).json({ error: 'cert.pem not found — call /tunnel/cf/login first' });
    }
    const bin = findCloudflaredBin();
    setupState.phase = 'creating';
    setupState.hostname = hostname;
    setupState.error = null;

    try {
      // 1) tunnel list → 기존 claw-web 재사용 or 새로 create
      let tunnelId = null;
      try {
        const { stdout } = await execFileAsync(bin, ['tunnel', 'list', '--output', 'json'], { timeout: 10000 });
        const tunnels = JSON.parse(stdout);
        const t = tunnels.find((x) => x.name === TUNNEL_NAME);
        if (t) tunnelId = t.id;
      } catch { /* no tunnels yet */ }

      if (!tunnelId) {
        setupState.phase = 'creating-tunnel';
        const { stdout } = await execFileAsync(bin, ['tunnel', 'create', TUNNEL_NAME], { timeout: 30000 });
        const m = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        if (!m) throw new Error('tunnel create: ID not captured');
        tunnelId = m[0];
      }
      setupState.tunnelId = tunnelId;
      logger.info({ tunnelId, hostname }, 'admin: tunnel ready');

      // 2) DNS route
      setupState.phase = 'routing-dns';
      await execFileAsync(bin, ['tunnel', 'route', 'dns', TUNNEL_NAME, hostname], { timeout: 30000 })
        .catch((err) => {
          // 이미 라우트가 있는 경우 경고만
          if (!err.stderr?.includes('already exists')) throw err;
        });

      // 3) config.yml 작성
      setupState.phase = 'writing-config';
      const credsPath = path.join(CF_DIR, `${tunnelId}.json`);
      const cfg = `tunnel: ${tunnelId}
credentials-file: ${credsPath}

ingress:
  - hostname: ${hostname}
    service: http://localhost:3838
  - service: http_status:404
`;
      await fs.writeFile(CONFIG_PATH, cfg, 'utf8');

      // 4) LaunchAgent 설치 (기존 있으면 unload 후 load)
      setupState.phase = 'installing-plist';
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LA_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>${TUNNEL_NAME}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claw-web-tunnel.log</string>
  <key>StandardErrorPath</key><string>/tmp/claw-web-tunnel.log</string>
</dict>
</plist>
`;
      await fs.writeFile(LA_PATH, plist, 'utf8');
      // unload (있으면) + load
      await execFileAsync('launchctl', ['unload', LA_PATH], { timeout: 5000 }).catch(() => {});
      await execFileAsync('launchctl', ['load', LA_PATH], { timeout: 5000 });

      setupState.phase = 'ready';
      logger.info({ hostname, tunnelId }, 'admin: Named Tunnel setup complete');

      res.json({
        ok: true,
        hostname,
        tunnelId,
        url: `https://${hostname}`,
        phases: ['creating-tunnel', 'routing-dns', 'writing-config', 'installing-plist', 'ready']
      });
    } catch (err) {
      setupState.phase = 'failed';
      setupState.error = err.message || String(err);
      logger.error({ err: err.message }, 'admin: tunnel setup failed');
      res.status(500).json({ error: err.message, phase: setupState.phase });
    }
  });

  // ───────────────────────────────────────────────────────
  // POST /tunnel/cf/teardown — Named Tunnel 제거 + plist unload
  // ───────────────────────────────────────────────────────
  router.post('/tunnel/cf/teardown', async (req, res) => {
    const bin = findCloudflaredBin();
    try {
      if (fssync.existsSync(LA_PATH)) {
        await execFileAsync('launchctl', ['unload', LA_PATH], { timeout: 5000 }).catch(() => {});
        await fs.unlink(LA_PATH).catch(() => {});
      }
      // tunnel delete — 연결된 DNS 레코드/credentials도 삭제
      try {
        await execFileAsync(bin, ['tunnel', 'delete', '-f', TUNNEL_NAME], { timeout: 15000 });
      } catch { /* 이미 없음 */ }
      if (fssync.existsSync(CONFIG_PATH)) await fs.unlink(CONFIG_PATH).catch(() => {});
      setupState.phase = 'idle';
      setupState.tunnelId = null;
      setupState.hostname = null;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
