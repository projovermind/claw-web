import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const execFileAsync = promisify(execFile);

// ── Cloudflare tunnel paths ──
export const CF_DIR = path.join(os.homedir(), '.cloudflared');
export const CERT_PATH = path.join(CF_DIR, 'cert.pem');
export const CONFIG_PATH = path.join(CF_DIR, 'config.yml');
export const TUNNEL_NAME = 'claw-web';
export const LA_LABEL = 'com.claw-web.tunnel';
export const LA_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LA_LABEL}.plist`);

// 상주 방식은 OS 마다 다르다. 예전엔 plist 만 썼는데, WSL 에서는
// ~/Library/LaunchAgents 가 없어서 터널을 만들어 놓고 상주 등록에서 죽었다.
export const SERVICE_KIND = process.platform === 'darwin' ? 'launchd'
  : process.platform === 'linux' ? 'systemd'
  : 'none';
export const SYSTEMD_UNIT = 'claw-web-tunnel.service';
export const SYSTEMD_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
/** 이 OS 에서 터널 상주 등록이 되어 있는가. */
export const TUNNEL_SERVICE_PATH = SERVICE_KIND === 'systemd' ? SYSTEMD_PATH : LA_PATH;

export function findCloudflaredBin() {
  const candidates = [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',        // apt/deb 설치 (WSL)
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return 'cloudflared';
}

/**
 * 터널을 부팅 후에도 살아 있게 등록한다.
 * macOS → LaunchAgent, Linux/WSL → systemd user unit.
 * 실패하면 던진다 — 조용히 넘기면 DNS 만 죽은 터널을 가리키게 된다.
 */
export async function installTunnelService(bin, configPath) {
  if (SERVICE_KIND === 'launchd') {
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
    <string>--config</string>
    <string>${configPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claw-web-tunnel.log</string>
  <key>StandardErrorPath</key><string>/tmp/claw-web-tunnel.log</string>
</dict>
</plist>
`;
    await fs.mkdir(path.dirname(LA_PATH), { recursive: true });
    await fs.writeFile(LA_PATH, plist, 'utf8');
    await execFileAsync('launchctl', ['unload', LA_PATH], { timeout: 5000 }).catch(() => {});
    await execFileAsync('launchctl', ['load', LA_PATH], { timeout: 5000 });
    return 'launchd';
  }

  if (SERVICE_KIND === 'systemd') {
    const unit = `[Unit]
Description=claw-web cloudflared tunnel
After=network.target

[Service]
Type=simple
ExecStart=${bin} --no-autoupdate --config ${configPath} tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    await fs.mkdir(path.dirname(SYSTEMD_PATH), { recursive: true });
    await fs.writeFile(SYSTEMD_PATH, unit, 'utf8');
    const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}` };
    await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 10000, env });
    await execFileAsync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { timeout: 20000, env });
    // 터미널을 닫아도 유지되게 — 실패해도 치명적이진 않다.
    await execFileAsync('loginctl', ['enable-linger', os.userInfo().username], { timeout: 10000 }).catch(() => {});
    return 'systemd';
  }

  throw new Error(`터널 상주 등록을 지원하지 않는 OS 입니다 (${process.platform}). 수동으로 cloudflared 를 띄워야 합니다.`);
}

/** 상주 등록 해제. 없으면 조용히 넘어간다. */
export async function uninstallTunnelService() {
  if (SERVICE_KIND === 'launchd') {
    if (!fssync.existsSync(LA_PATH)) return;
    await execFileAsync('launchctl', ['unload', LA_PATH], { timeout: 5000 }).catch(() => {});
    await fs.unlink(LA_PATH).catch(() => {});
    return;
  }
  if (SERVICE_KIND === 'systemd') {
    if (!fssync.existsSync(SYSTEMD_PATH)) return;
    await execFileAsync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { timeout: 20000 }).catch(() => {});
    await fs.unlink(SYSTEMD_PATH).catch(() => {});
  }
}

/** semver 비교: a > b → 1, a < b → -1, 같으면 0. 형식은 x.y.z */
export function compareVersions(a, b) {
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

// ── Claude CLI detection ──
const CLAUDE_PATH_CANDIDATES = [
  path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  path.join(os.homedir(), '.local', 'bin', 'claude')
];

export function findClaudeBin() {
  for (const p of CLAUDE_PATH_CANDIDATES) {
    if (fssync.existsSync(p)) return p;
  }
  return null;
}

export function findNodeBin() {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/opt/node@22/bin/node',
    '/opt/homebrew/opt/node@20/bin/node'
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
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

export async function checkClaudeStatus() {
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
