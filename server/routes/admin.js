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
// NOTE: tunnel-url.txt 는 이제 Quick Tunnel(유동) 전용 (server/routes/tunnel.js 가 관리).
// Named Tunnel(고정) 은 config.yml 의 hostname 으로 독립 관리 → 두 URL 분리.

// 진행 상태 메모리 보관 (polling 용)
const setupState = { phase: 'idle', loginUrl: null, hostname: null, tunnelId: null, error: null };

function findCloudflaredBin() {
  const candidates = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return 'cloudflared';
}

/** semver 비교: a > b → 1, a < b → -1, 같으면 0. 형식은 x.y.z */
function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────
// Claude CLI helpers (path/version/status detection + install)
// ─────────────────────────────────────────────────────────
const CLAUDE_PATH_CANDIDATES = [
  path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  path.join(os.homedir(), '.local', 'bin', 'claude')
];

function findClaudeBin() {
  for (const p of CLAUDE_PATH_CANDIDATES) {
    if (fssync.existsSync(p)) return p;
  }
  return null;
}

function findNodeBin() {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/opt/node@22/bin/node',
    '/opt/homebrew/opt/node@20/bin/node'
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  // nvm fallback
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fssync.existsSync(nvmDir)) {
    try {
      const versions = fssync.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const candidate = path.join(nvmDir, v, 'bin', 'node');
        if (fssync.existsSync(candidate)) return candidate;
      }
    } catch { /* ignore */ }
  }
  return process.execPath;
}

async function checkClaudeStatus() {
  const bin = findClaudeBin();
  if (!bin) {
    return { status: 'missing', bin: null, version: null, error: null };
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], { timeout: 10000 });
    const out = (stdout || '') + (stderr || '');
    if (/native binary not installed/i.test(out)) {
      return { status: 'broken', bin, version: null, error: 'native binary not installed' };
    }
    const m = out.match(/([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/);
    return { status: 'ok', bin, version: m ? m[1] : out.trim(), error: null };
  } catch (err) {
    const msg = (err.stdout || '') + (err.stderr || '') + (err.message || '');
    const broken = /native binary not installed/i.test(msg);
    return {
      status: broken ? 'broken' : 'error',
      bin,
      version: null,
      error: msg.slice(0, 500)
    };
  }
}

export function createAdminRouter({ runner, eventBus }) {
  const router = Router();

  // 현재 설치 진행 상태 (동시 설치 방지)
  const installState = { running: false, startedAt: null };

  function emit(topic, payload) {
    if (eventBus) eventBus.publish(topic, payload);
  }

  // ───────────────────────────────────────────────────────
  // GET /update/check — GitHub 최신 릴리즈 조회 후 현재 버전과 비교
  // ───────────────────────────────────────────────────────
  router.get('/update/check', async (_req, res) => {
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      let current = 'unknown';
      try {
        const raw = await fs.readFile(pkgPath, 'utf8');
        current = JSON.parse(raw).version || 'unknown';
      } catch { /* ignore */ }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let release = null;
      try {
        const resp = await fetch(
          'https://api.github.com/repos/projovermind/claw-web/releases/latest',
          { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'claw-web' }, signal: controller.signal }
        );
        if (resp.ok) release = await resp.json();
      } finally {
        clearTimeout(timeout);
      }

      if (!release) {
        return res.json({ current, latest: null, hasUpdate: false, error: 'GitHub 응답 실패' });
      }

      const latest = (release.tag_name || '').replace(/^v/, '');
      const pkgAsset = (release.assets || []).find((a) => a.name?.endsWith('.pkg'));
      const hasUpdate = latest && current !== 'unknown' && compareVersions(latest, current) > 0;
      // git 설치 여부 판별 → 자동 패치 가능 여부
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
      const canAutoPatch = fssync.existsSync(path.join(repoRoot, '.git'));
      res.json({
        current,
        latest,
        hasUpdate,
        canAutoPatch,
        downloadUrl: pkgAsset?.browser_download_url || release.html_url,
        pkgUrl: pkgAsset?.browser_download_url || null,
        pkgName: pkgAsset?.name || null,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        notes: release.body || ''
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────
  // POST /update/install — pkg 다운로드 후 macOS Installer.app 자동 실행
  // body: { pkgUrl: 'https://github.com/.../Claw-Web-1.2.x.pkg' }
  // 설치 진행은 Installer.app GUI 로 사용자가 확인. 서버는 pkg 파일 준비 + open 까지.
  // ───────────────────────────────────────────────────────
  router.post('/update/install', async (req, res) => {
    const pkgUrl = (req.body?.pkgUrl || '').trim();
    if (!pkgUrl || !/^https:\/\/github\.com\/.+\.pkg$/.test(pkgUrl)) {
      return res.status(400).json({ error: 'pkgUrl 이 유효하지 않습니다 (github.com/*.pkg 허용)' });
    }

    const dlPath = path.join(os.tmpdir(), `claw-web-update-${Date.now()}.pkg`);
    try {
      logger.info({ pkgUrl, dlPath }, 'admin: downloading update pkg');
      const resp = await fetch(pkgUrl, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`다운로드 실패: HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1024) throw new Error('다운로드된 파일이 너무 작음');
      await fs.writeFile(dlPath, buf);

      // macOS Installer.app 실행 — GUI 가 뜨고 사용자가 계속 진행
      const { spawn } = await import('node:child_process');
      spawn('open', [dlPath], { detached: true, stdio: 'ignore' }).unref();

      logger.info({ dlPath, size: buf.length }, 'admin: Installer.app launched');
      res.json({
        ok: true,
        pkgPath: dlPath,
        size: buf.length,
        message: 'Installer.app 이 열렸습니다. 설치 완료 후 서버가 자동 재시작됩니다.'
      });
    } catch (err) {
      logger.error({ err: err.message }, 'admin: update install failed');
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────
  // POST /update/patch — git 기반 자동 패치 (git clone / install.sh 설치 환경)
  // 다운로드 + 빌드 + 재시작까지 GUI 없이 전부 자동. LaunchAgent KeepAlive 가 재시작 담당.
  // ───────────────────────────────────────────────────────
  router.post('/update/patch', async (_req, res) => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    if (!fssync.existsSync(path.join(repoRoot, '.git'))) {
      return res.status(400).json({ error: 'git 설치가 아닙니다. pkg 업데이트를 사용하세요.' });
    }

    // 응답 먼저 보내고 백그라운드에서 실행 (HTTP 타임아웃 회피)
    res.json({ ok: true, message: 'git pull + build + 재시작 시작. 10~60초 후 자동으로 복귀합니다.' });

    setTimeout(async () => {
      try {
        logger.info({ repoRoot }, 'admin: update/patch starting');
        const opts = { cwd: repoRoot, timeout: 180000, encoding: 'utf8' };
        await execFileAsync('git', ['fetch', 'origin'], opts);
        await execFileAsync('git', ['reset', '--hard', 'origin/main'], opts);
        await execFileAsync('npm', ['install', '--omit=dev'], opts);
        await execFileAsync('npm', ['--prefix', 'client', 'install'], opts);
        await execFileAsync('npm', ['run', 'build'], opts);
        logger.info('admin: update/patch done, restarting');
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        logger.error({ err: err.message }, 'admin: update/patch failed');
      }
    }, 100);
  });

  // ───────────────────────────────────────────────────────
  // GET /claude/status — Claude CLI 설치 상태 조회
  // ───────────────────────────────────────────────────────
  router.get('/claude/status', async (_req, res) => {
    try {
      const info = await checkClaudeStatus();
      res.json({ ...info, installing: installState.running });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────
  // POST /claude/install — Claude CLI 설치/재설치
  // body: { reinstall?: boolean }
  // 진행 로그는 WebSocket 'claude.install.log' 이벤트로 스트리밍
  // 완료 시 'claude.install.done' 이벤트
  // ───────────────────────────────────────────────────────
  router.post('/claude/install', async (req, res) => {
    if (installState.running) {
      return res.status(409).json({ error: 'install already in progress' });
    }

    const reinstall = req.body?.reinstall === true;
    const nodeBin = findNodeBin();
    const nodeDir = path.dirname(nodeBin);
    const npmBin = fssync.existsSync(path.join(nodeDir, 'npm'))
      ? path.join(nodeDir, 'npm')
      : 'npm';

    // arch 감지 → 정확한 native binary 패키지 지정
    const arch = os.arch();
    const platform = os.platform();
    const nativePkg =
      platform === 'darwin' && arch === 'arm64' ? '@anthropic-ai/claude-code-darwin-arm64' :
      platform === 'darwin' && arch === 'x64'   ? '@anthropic-ai/claude-code-darwin-x64'   :
      platform === 'linux'  && arch === 'arm64' ? '@anthropic-ai/claude-code-linux-arm64'  :
      platform === 'linux'  && arch === 'x64'   ? '@anthropic-ai/claude-code-linux-x64'    :
      null;

    installState.running = true;
    installState.startedAt = new Date().toISOString();
    emit('claude.install.log', { line: `[start] reinstall=${reinstall} platform=${platform}-${arch} nativePkg=${nativePkg}` });
    emit('claude.install.log', { line: `[start] node=${nodeBin}` });
    emit('claude.install.log', { line: `[start] npm=${npmBin}` });

    // 응답은 즉시 (실제 설치는 비동기로 진행)
    res.json({ ok: true, message: 'install started', startedAt: installState.startedAt });

    const runStep = (cmd, args, opts = {}) => new Promise((resolve) => {
      emit('claude.install.log', { line: `\n$ ${cmd} ${args.join(' ')}` });
      const child = spawn(cmd, args, {
        env: {
          ...process.env,
          HOME: os.homedir(),
          PATH: `${nodeDir}:${path.join(os.homedir(), '.npm-global', 'bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`
        },
        ...opts
      });
      child.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) emit('claude.install.log', { line });
        }
      });
      child.stderr.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) emit('claude.install.log', { line });
        }
      });
      child.on('close', (code) => resolve(code));
      child.on('error', (err) => {
        emit('claude.install.log', { line: `[error] ${err.message}` });
        resolve(-1);
      });
    });

    try {
      // npm prefix 를 사용자 홈으로 고정 (root 권한 없이 설치)
      const npmGlobalPrefix = path.join(os.homedir(), '.npm-global');
      await fs.mkdir(path.join(npmGlobalPrefix, 'bin'), { recursive: true }).catch(() => {});

      // npm 캐시는 항상 임시 디렉토리 사용 — ~/.npm 에 root-owned 파일이
      // 남아있으면(이전 실패 설치의 잔재) EACCES 로 설치 실패하기 때문.
      // 임시 캐시를 쓰면 이런 이슈를 완전히 회피.
      const npmCacheDir = path.join(os.tmpdir(), `claw-web-npm-cache-${process.pid}`);
      await fs.mkdir(npmCacheDir, { recursive: true }).catch(() => {});
      emit('claude.install.log', { line: `[start] npm cache=${npmCacheDir}` });

      await runStep(npmBin, ['config', 'set', 'prefix', npmGlobalPrefix, '--location=user']);
      await runStep(npmBin, ['config', 'set', 'omit', '', '--location=user']);
      await runStep(npmBin, ['config', 'set', 'ignore-scripts', 'false', '--location=user']);

      // native pkg 를 명시적으로 함께 설치 — install.cjs 가 optionalDependency 를 찾게 됨
      // --cache 로 임시 캐시 강제 → ~/.npm 권한 이슈 우회
      const installArgs = [
        'install', '-g',
        '--include=optional',
        '--foreground-scripts',
        `--cache=${npmCacheDir}`,
        '@anthropic-ai/claude-code'
      ];
      if (nativePkg) installArgs.push(nativePkg);
      const rc1 = await runStep(npmBin, installArgs);
      emit('claude.install.log', { line: `[exit] npm install rc=${rc1}` });

      // 설치 실패 시 ~/.npm 정리 안내 (사용자 도움용)
      if (rc1 !== 0) {
        emit('claude.install.log', {
          line: `\n[hint] 설치 실패. 다음 명령어를 터미널에서 실행한 후 재설치해보세요:\n         sudo chown -R $(id -u):$(id -g) ~/.npm\n         rm -rf ~/.npm/_cacache\n`
        });
      }

      // install.cjs 를 명시 실행 (wrapper stub → real native binary 교체)
      const claudeModuleDir = path.join(npmGlobalPrefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
      const installCjs = path.join(claudeModuleDir, 'install.cjs');
      if (fssync.existsSync(installCjs)) {
        const rc2 = await runStep(nodeBin, [installCjs], { cwd: claudeModuleDir });
        emit('claude.install.log', { line: `[exit] install.cjs rc=${rc2}` });
      } else {
        emit('claude.install.log', { line: `[warn] install.cjs not found at ${installCjs}` });
      }

      // 최종 검증
      const status = await checkClaudeStatus();
      emit('claude.install.log', { line: `[verify] status=${status.status} bin=${status.bin} version=${status.version}` });
      emit('claude.install.done', { status });
    } catch (err) {
      emit('claude.install.log', { line: `[fatal] ${err.message}` });
      emit('claude.install.done', { status: { status: 'error', error: err.message } });
    } finally {
      installState.running = false;
    }
  });

  // ───────────────────────────────────────────────────────
  // POST /claude/login — Terminal.app 에서 `claude login` 실행
  // ───────────────────────────────────────────────────────
  router.post('/claude/login', async (_req, res) => {
    const bin = findClaudeBin();
    if (!bin) {
      return res.status(400).json({ error: 'claude not installed' });
    }
    try {
      const script = `tell application "Terminal" to do script "${bin} login"`;
      await execFileAsync('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { timeout: 5000 });
      res.json({ ok: true, message: 'Terminal opened with claude login' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

      // NOTE: tunnel-url.txt 에 고정 URL 을 쓰지 않는다 — 유동 URL 과 분리 원칙.
      //       프론트는 /api/admin/tunnel/cf/status 로 hostname 을 별도 조회한다.

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
      // tunnel-url.txt 는 유동 URL 전용 — Named Tunnel teardown 으로 건드리지 않음.
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
