import fssync from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';

/** Register POST /restart. */
export function registerRestartRoute(router, { runner }) {
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
