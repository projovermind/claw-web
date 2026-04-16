/**
 * Auto-Update — GitHub 릴리즈 기반 자동 업데이트
 *
 * 1시간마다 GitHub API로 최신 릴리즈 확인
 * 새 버전이면 git pull + npm install + 클라이언트 빌드 + 서버 재시작
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const REPO = 'projovermind/claw-web';
const CHECK_INTERVAL = 60 * 60 * 1000; // 1시간
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const currentVersion = getCurrentVersion();
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return null;

    const release = await res.json();
    const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';

    if (compareVersions(latestVersion, currentVersion) > 0) {
      logger.info({ current: currentVersion, latest: latestVersion }, 'auto-update: new version available');
      return { current: currentVersion, latest: latestVersion, tag: release.tag_name };
    }
    return null;
  } catch {
    return null;
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, timeout: 120000, encoding: 'utf8' });
}

function performUpdate(tag) {
  try {
    logger.info({ tag }, 'auto-update: starting...');
    run('git', ['fetch', 'origin']);
    run('git', ['reset', '--hard', 'origin/main']);
    run('npm', ['install', '--omit=dev']);
    run('npm', ['--prefix', 'client', 'install']);
    run('npm', ['run', 'build']);
    logger.info({ tag }, 'auto-update: done, restarting...');
    setTimeout(() => process.exit(0), 1000); // LaunchAgent KeepAlive가 재시작
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'auto-update: failed');
    return false;
  }
}

export function startAutoUpdate() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    logger.info('auto-update: no .git, skipping');
    return { stop: () => {} };
  }

  let timer = null;
  async function tick() {
    const update = await checkForUpdate();
    if (update) performUpdate(update.tag);
  }

  const initial = setTimeout(() => {
    tick();
    timer = setInterval(tick, CHECK_INTERVAL);
  }, 30000);

  return {
    stop() { clearTimeout(initial); if (timer) clearInterval(timer); },
    checkNow: tick
  };
}
