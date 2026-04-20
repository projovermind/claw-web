import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../lib/logger.js';

/** Register POST /restart. */
export function registerRestartRoute(router, { runner }) {
  router.post('/restart', (req, res) => {
    const force = req.body?.force === true;
    const activeCount = runner.activeIds().length;
    logger.warn({ force, activeCount }, 'admin: restart requested via API');

    let warning;
    if (!force) {
      const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      try {
        const files = fssync.readdirSync(launchAgentsDir);
        const found = files.some(f => /^com\.claw-web\..*\.plist$/.test(f));
        if (!found) warning = 'LaunchAgent 미감지 — 재시작 후 수동 기동 필요';
      } catch {
        warning = 'LaunchAgent 미감지 — 재시작 후 수동 기동 필요';
      }
    }

    const respBody = {
      ok: true,
      mode: force ? 'force' : 'soft',
      activeAgents: activeCount,
      msg: force
        ? `강제 재시작 — 활성 에이전트 ${activeCount}개 즉시 종료`
        : `소프트 재시작 — 활성 ${activeCount}개는 재기동 후 자동 이어가기`
    };
    if (warning) respBody.warning = warning;
    res.json(respBody);

    setTimeout(() => {
      if (force) {
        try {
          const resumeFile = path.join(process.cwd(), 'logs', 'pending-resume.json');
          if (fssync.existsSync(resumeFile)) fssync.unlinkSync(resumeFile);
        } catch { /* ignore */ }
        for (const sid of runner.activeIds()) {
          try { runner.abort(sid); } catch { /* ignore */ }
        }
        setTimeout(() => process.exit(0), 500);
      } else {
        process.kill(process.pid, 'SIGTERM');
      }
    }, 200);
  });
}
