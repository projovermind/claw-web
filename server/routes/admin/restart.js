import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { logger } from '../../lib/logger.js';

// 이 파일 경로 기준으로 REPO_ROOT 고정 — process.cwd() 는 launchd 설정에 따라
// /Users/subinggrae 일 수 있어 index.js 의 `REPO_ROOT + /logs` 와 불일치 위험.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

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
        : `소프트 재시작 — 활성 ${activeCount}개는 재기동 후 자동 이어가기 (쿨다운: 60초/3회·10분 한도)`
    };
    if (warning) respBody.warning = warning;
    res.json(respBody);

    setTimeout(() => {
      const logsDir = path.join(REPO_ROOT, 'logs');
      try { fssync.mkdirSync(logsDir, { recursive: true }); } catch { /* ignore */ }
      if (force) {
        // 강제 재시작: pending-resume 삭제 + 활성 에이전트 abort + 즉시 exit
        try {
          const resumeFile = path.join(logsDir, 'pending-resume.json');
          if (fssync.existsSync(resumeFile)) fssync.unlinkSync(resumeFile);
        } catch { /* ignore */ }
        for (const sid of runner.activeIds()) {
          try { runner.abort(sid); } catch { /* ignore */ }
        }
        setTimeout(() => process.exit(0), 500);
      } else {
        // 소프트 재시작: 이어가기 플래그 기록 → boot 시 autoResume=true 강제로 되살아남
        // 이 플래그 없으면 다음 기동에서 "(응답이 중단되었습니다)"만 찍히고 끝남.
        try {
          fssync.writeFileSync(
            path.join(logsDir, '.soft-restart'),
            JSON.stringify({ at: new Date().toISOString(), activeCount }),
            'utf8'
          );
        } catch (err) {
          logger.warn({ err: err.message }, 'failed to write soft-restart flag');
        }
        process.kill(process.pid, 'SIGTERM');
      }
    }, 200);
  });
}
