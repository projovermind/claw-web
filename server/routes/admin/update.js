import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../lib/logger.js';
import { execFileAsync, compareVersions } from './utils.js';

/** Register /update/* routes on the given router. */
export function registerUpdateRoutes(router) {
  // GET /update/check — GitHub 최신 릴리즈 조회 후 현재 버전과 비교
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
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
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

  // POST /update/install — pkg 다운로드 후 macOS Installer.app 자동 실행
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

  // POST /update/patch — git 기반 자동 패치 (git clone / install.sh 설치 환경)
  router.post('/update/patch', async (_req, res) => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
    if (!fssync.existsSync(path.join(repoRoot, '.git'))) {
      return res.status(400).json({ error: 'git 설치가 아닙니다. pkg 업데이트를 사용하세요.' });
    }

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
}
