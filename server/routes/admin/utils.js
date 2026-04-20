import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fssync from 'node:fs';
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

export function findCloudflaredBin() {
  const candidates = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return 'cloudflared';
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
