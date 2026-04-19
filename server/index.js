import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadWebConfig } from './lib/web-config.js';
import { createConfigStore } from './lib/config-store.js';
import { createMetadataStore } from './lib/metadata-store.js';
import { createProjectsStore } from './lib/projects-store.js';
import { createSessionsStore } from './lib/sessions-store.js';
import { createBackendsStore } from './lib/backends-store.js';
import { createSecretsStore } from './lib/secrets-store.js';
import { createSkillsStore } from './lib/skills-store.js';
import { createSystemSkillsStore } from './lib/system-skills.js';
import { createActivityLog } from './lib/activity-log.js';
import { createRunner } from './lib/runner.js';
import { createProcessTracker } from './lib/process-tracker.js';
import { createEventBus } from './lib/event-bus.js';
import { createHealthCheck } from './lib/health-check.js';
import { logger } from './lib/logger.js';
import { createHealthRouter } from './routes/health.js';
import { createAgentsRouter } from './routes/agents.js';
import { createSettingsRouter } from './routes/settings.js';
import { createProjectsRouter } from './routes/projects.js';
import { createProjectMdRouter } from './routes/project-md.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createChatRouter } from './routes/chat.js';
import { createBackendsRouter } from './routes/backends.js';
import { createUploadsRouter } from './routes/uploads.js';
import { createSkillsRouter } from './routes/skills.js';
import { createActivityRouter } from './routes/activity.js';
import { createFsBrowserRouter } from './routes/fs-browser.js';
import { createTunnelRouter } from './routes/tunnel.js';
import { createAdminRouter } from './routes/admin.js';
import { createDomainRouter } from './routes/domain.js';
import { attachWsHub } from './ws/hub.js';
import { errorHandler } from './middleware/error-handler.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAutoBackup } from './lib/auto-backup.js';
import { createStatsRouter } from './routes/stats.js';
import { createTasksRouter } from './routes/tasks.js';
import { createHooksRouter } from './routes/hooks.js';
import { createMcpRouter } from './routes/mcp.js';
import { createWorktreeRouter } from './routes/worktree.js';
import { createSchedulesRouter } from './routes/schedules.js';
import { createLspRouter } from './routes/lsp.js';
import { createTerraformRouter } from './routes/terraform.js';
import { createUndoRouter } from './routes/undo.js';
import { createHooksStore } from './lib/hooks-store.js';
import { createScheduler } from './lib/scheduler.js';
import { createDelegationTracker } from './lib/delegation-tracker.js';
import { createPushStore } from './lib/push-store.js';
import { createPushRouter } from './routes/push.js';
import { createSessionAnalyzer } from './lib/session-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════
// Auto-migration — 폴더 이름이 바뀌거나 신규 폴더로 이전했을 때,
// REPO_ROOT 에 실데이터가 없으면 인접 후보 폴더에서 자동 import.
// 한 번만 동작 (migration marker 생성).
// ═══════════════════════════════════════════════════════
(function autoMigrate() {
  const marker = path.join(REPO_ROOT, '.migration-done');
  if (fssync.existsSync(marker)) return;

  // "실데이터 있음" 판정: sessions.json 에 세션 1개 이상, 또는 web-metadata 에 agent 1개 이상
  const hasRealData = () => {
    try {
      const s = path.join(REPO_ROOT, 'sessions.json');
      if (fssync.existsSync(s)) {
        const obj = JSON.parse(fssync.readFileSync(s, 'utf8'));
        if (Object.keys(obj?.sessions || {}).length > 0) return true;
      }
      const m = path.join(REPO_ROOT, 'web-metadata.json');
      if (fssync.existsSync(m)) {
        const obj = JSON.parse(fssync.readFileSync(m, 'utf8'));
        if (Object.keys(obj?.agents || {}).length > 0) return true;
      }
    } catch { /* ignore */ }
    return false;
  };

  if (hasRealData()) return; // 이미 데이터 있으면 스킵

  // 후보 경로에서 실데이터 있는 곳 찾기
  const candidates = [
    process.env.CLAW_WEB_MIGRATE_FROM,
    '/Volumes/Core/hivemind-web',
    '/Volumes/Core/claw-web',
    '/Volumes/Core/Claw-Web',
    path.join(process.env.HOME || '', 'hivemind-web'),
    path.join(process.env.HOME || '', 'claw-web')
  ].filter(Boolean).filter((p) => p !== REPO_ROOT);

  let source = null;
  for (const c of candidates) {
    try {
      const s = path.join(c, 'sessions.json');
      if (!fssync.existsSync(s)) continue;
      const obj = JSON.parse(fssync.readFileSync(s, 'utf8'));
      if (Object.keys(obj?.sessions || {}).length > 0) {
        source = c; break;
      }
    } catch { /* ignore */ }
  }

  if (!source) {
    // migration 할 게 없음 (신규 설치) — marker 만 찍어두고 이후엔 체크 스킵
    try { fssync.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
    return;
  }

  logger.warn({ source, dest: REPO_ROOT }, 'auto-migration: copying real data from sibling folder');

  const FILES = [
    'sessions.json', 'web-metadata.json', 'web-config.json', 'secrets.json',
    'projects.json', 'skills.json', 'backends.json', 'hooks.json', 'schedules.json',
    'agents-config.json'
  ];
  const DIRS = ['logs', 'uploads', 'backups'];
  for (const f of FILES) {
    const src = path.join(source, f);
    const dst = path.join(REPO_ROOT, f);
    try {
      if (fssync.existsSync(src) && !fssync.existsSync(dst)) {
        fssync.copyFileSync(src, dst);
      }
      // dst 있고 비어있으면 덮어쓰기
      else if (fssync.existsSync(src) && fssync.existsSync(dst)) {
        const srcSize = fssync.statSync(src).size;
        const dstSize = fssync.statSync(dst).size;
        if (srcSize > dstSize * 2) { // src 가 최소 2배 크면 빈 템플릿으로 간주
          fssync.copyFileSync(src, dst);
        }
      }
    } catch (err) {
      logger.warn({ f, err: err.message }, 'auto-migration file failed');
    }
  }
  for (const d of DIRS) {
    const src = path.join(source, d);
    const dst = path.join(REPO_ROOT, d);
    if (!fssync.existsSync(src)) continue;
    try {
      if (!fssync.existsSync(dst)) fssync.mkdirSync(dst, { recursive: true });
      // shallow copy — 깊은 복사는 미지원, 사용자에게 안내
      for (const name of fssync.readdirSync(src)) {
        const sp = path.join(src, name);
        const dp = path.join(dst, name);
        try {
          if (!fssync.existsSync(dp) && fssync.statSync(sp).isFile()) {
            fssync.copyFileSync(sp, dp);
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      logger.warn({ d, err: err.message }, 'auto-migration dir failed');
    }
  }
  try { fssync.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
  logger.info({ source, dest: REPO_ROOT }, 'auto-migration complete — .migration-done marker created');
})();

const WEB_CONFIG_PATH = path.join(REPO_ROOT, 'web-config.json');
const METADATA_PATH = path.join(REPO_ROOT, 'web-metadata.json');
const PROJECTS_PATH = path.join(REPO_ROOT, 'projects.json');
const SESSIONS_PATH = path.join(REPO_ROOT, 'sessions.json');
const BACKENDS_PATH = path.join(REPO_ROOT, 'backends.json');
const SECRETS_PATH = path.join(REPO_ROOT, 'secrets.json');
const UPLOADS_DIR = path.join(REPO_ROOT, 'uploads');
const SKILLS_PATH = path.join(REPO_ROOT, 'skills.json');
const ACTIVITY_PATH = path.join(REPO_ROOT, 'logs', 'activity.jsonl');
const PROCESS_TRACKER_PATH = path.join(REPO_ROOT, 'logs', 'running-processes.json');

async function main() {
  const webConfig = loadWebConfig(WEB_CONFIG_PATH);

  // ── 자가 보정: REPO_ROOT 가 allowedRoots 에 없으면 자동 추가 ──
  // 폴더 이름 변경 (hivemind-web → claw-web 등) 에 대응하기 위함.
  // web-config.json 을 직접 수정하진 않고 메모리에서만 보정.
  if (!Array.isArray(webConfig.allowedRoots)) webConfig.allowedRoots = [];
  const hasRepoRoot = webConfig.allowedRoots.some((p) => {
    try { return path.resolve(p) === path.resolve(REPO_ROOT); } catch { return false; }
  });
  if (!hasRepoRoot) {
    webConfig.allowedRoots.push(REPO_ROOT + '/');
    logger.info({ repoRoot: REPO_ROOT }, 'auto-added REPO_ROOT to allowedRoots');
  }

  const configStore = await createConfigStore(webConfig.configPath);
  const metadataStore = await createMetadataStore(METADATA_PATH);
  const projectsStore = await createProjectsStore(PROJECTS_PATH);
  const sessionsStore = await createSessionsStore(SESSIONS_PATH);
  const secretsStore = await createSecretsStore({ filePath: SECRETS_PATH });
  const backendsStore = await createBackendsStore(BACKENDS_PATH, { secretsStore });
  const skillsStore = await createSkillsStore(SKILLS_PATH);
  const systemSkillsStore = createSystemSkillsStore();
  try {
    const loaded = await systemSkillsStore.init();
    logger.info({ loaded }, 'system skills initialized');
  } catch (err) {
    logger.warn({ err }, 'system skills init failed (non-fatal)');
  }
  const processTracker = createProcessTracker({ filePath: PROCESS_TRACKER_PATH });
  // Clean up any Claude CLI children that survived a previous crash.
  try {
    const killed = await processTracker.reapOrphans();
    if (killed > 0) {
      logger.warn({ killed }, 'runner: reaped orphaned Claude CLI processes from previous run');
    }
  } catch (err) {
    logger.warn({ err }, 'runner: reapOrphans failed (non-fatal)');
  }
  const runner = createRunner({ processTracker });
  const delegationTracker = createDelegationTracker();
  const pushStore = createPushStore({ webConfig, webConfigPath: WEB_CONFIG_PATH });
  pushStore.setRunnerRef(runner); // 작업 중 알림 억제
  const eventBus = createEventBus();
  const hooksStore = await createHooksStore(path.join(REPO_ROOT, 'hooks.json'));
  const scheduler = createScheduler({
    filePath: path.join(REPO_ROOT, 'schedules.json'),
    eventBus
  });
  const activityLog = createActivityLog({ filePath: ACTIVITY_PATH, eventBus });
  createSessionAnalyzer({ eventBus, sessionsStore, configStore });
  const healthCheck = createHealthCheck({ botPidFile: webConfig.botPidFile });

  // Auto-backup critical JSON files
  const autoBackup = createAutoBackup([
    PROJECTS_PATH, SESSIONS_PATH, METADATA_PATH,
    BACKENDS_PATH, SKILLS_PATH, SECRETS_PATH
  ]);
  autoBackup.start();

  configStore.onChange(() => eventBus.publish('agents.refreshed', {}));
  metadataStore.onChange(() => eventBus.publish('metadata.refreshed', {}));
  projectsStore.onChange(() => eventBus.publish('projects.refreshed', {}));
  sessionsStore.onChange(() => eventBus.publish('sessions.refreshed', {}));
  backendsStore.onChange(() => eventBus.publish('backends.refreshed', {}));
  skillsStore.onChange(() => eventBus.publish('skills.refreshed', {}));

  const app = express();
  app.use(express.json({ limit: '32mb' }));
  if (process.env.NODE_ENV !== 'production') {
    app.use(cors({ origin: ['http://localhost:5273', 'http://127.0.0.1:5273'] }));
  }

  // Auth guard on all /api/* (reads live from webConfig, so toggles take effect
  // immediately). Exempts GET /api/health and GET /api/settings so clients can
  // probe whether auth is required.
  app.use('/api', createAuthMiddleware({ webConfig }));

  app.use('/api/health', createHealthRouter({ healthCheck }));
  app.use('/api/agents', createAgentsRouter({ configStore, metadataStore, projectsStore, skillsStore, eventBus }));
  app.use(
    '/api/projects',
    createProjectsRouter({ projectsStore, configStore, metadataStore, eventBus })
  );
  // CLAUDE.md / AGENTS.md editor mounted on same prefix
  app.use('/api/projects', createProjectMdRouter({ projectsStore, webConfig, eventBus }));
  app.use('/api/sessions', createSessionsRouter({ sessionsStore, configStore, runner, eventBus }));
  const { router: chatRouter, resumeInterruptedSession } = createChatRouter({
    sessionsStore,
    configStore,
    metadataStore,
    skillsStore,
    systemSkillsStore,
    projectsStore,
    backendsStore,
    runner,
    eventBus,
    delegationTracker,
    pushStore,
    webConfig
  });
  app.use('/api/chat', chatRouter);
  app.use('/api/backends', createBackendsRouter({ backendsStore, eventBus }));
  app.use('/api/uploads', createUploadsRouter({ uploadsDir: UPLOADS_DIR, eventBus }));
  app.use(
    '/api/skills',
    createSkillsRouter({ skillsStore, systemSkillsStore, metadataStore, eventBus })
  );
  app.use('/api/activity', createActivityRouter({ activityLog }));
  app.use('/api/fs', createFsBrowserRouter({ webConfig }));
  app.use('/api/tunnel', createTunnelRouter());
  app.use('/api/admin', createAdminRouter({ runner }));
  app.use('/api/domain', createDomainRouter({ secretsStore }));
  app.use('/api/settings', createSettingsRouter({ webConfig, webConfigPath: WEB_CONFIG_PATH, eventBus }));
  app.use('/api/push', createPushRouter({ pushStore }));
  app.use('/api/stats', createStatsRouter({ sessionsStore, configStore }));
  app.use('/api/tasks', createTasksRouter({ eventBus }));
  app.use('/api/hooks', createHooksRouter({ hooksStore, eventBus }));
  app.use('/api/mcp', createMcpRouter({ projectsStore }));
  app.use('/api/worktree', createWorktreeRouter({ projectsStore }));
  app.use('/api/schedules', createSchedulesRouter({ scheduler, eventBus }));
  app.use('/api/lsp', createLspRouter({ projectsStore }));
  app.use('/api/terraform', createTerraformRouter({ projectsStore, configStore, metadataStore, eventBus }));
  app.use('/api/undo', createUndoRouter({ configStore, metadataStore, eventBus }));

  const distPath = path.join(REPO_ROOT, 'client', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'), (err) => err && next());
  });

  app.use(errorHandler);

  const server = http.createServer(app);
  const wsHub = attachWsHub(server, { eventBus, webConfig });

  // ── 포트 점유 진단 (kill 하지 않고 로그만) ──
  // 자가 청소는 launchd unload→load 오버랩 시점에 방금 launchd 가 띄운
  // 자매 프로세스까지 kill 해 crash-loop 를 오히려 악화시키는 부작용이 있어
  // 제거. EADDRINUSE 는 아래 `server.on('error')` 에서 명시적으로 처리.
  // 실제 고아가 생겼을 땐 `lsof -i :3838` 로 진단 후 수동 kill 권장.
  try {
    const selfPid = process.pid;
    const occupied = execFileSync('lsof', ['-nP', '-i', `:${webConfig.port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 3000 }).trim().split('\n').filter(Boolean).map(Number)
      .filter((pid) => pid !== selfPid);
    if (occupied.length > 0) {
      logger.warn({ port: webConfig.port, occupiedPids: occupied },
        'port already occupied by other process(es) — will fail listen; check with `lsof -i :' + webConfig.port + '`');
    }
  } catch { /* lsof 없거나 출력 없음 — 정상 */ }

  // ── listen 에러 처리 ──
  // EADDRINUSE: 고아 프로세스가 포트를 점유 중이면 launchd ThrottleInterval 에
  // 걸려 10초마다 crash-loop 이 반복됨. 한 번 로그 남기고 명시적으로 exit(2)
  // 해 launchd 가 adaptive throttle 로 처리하도록 유도.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal({ port: webConfig.port, err: err.message },
        'port already in use — is another server/index.js running? check `lsof -i :' + webConfig.port + '`');
    } else {
      logger.fatal({ err: err.message, code: err.code }, 'server listen error');
    }
    // ThrottleInterval 을 타도록 빠르게 exit — KeepAlive 가 재시도
    setTimeout(() => process.exit(2), 500);
  });

  server.listen(webConfig.port, () => {
    logger.info({ port: webConfig.port }, 'hivemind-web server listening');
  });

  // ── 재시작 시 중단 세션 처리 ──
  // 이전엔 자동 재개했으나:
  //   (a) crash-loop 중이면 매 재기동마다 N개 세션 spawn → 악화
  //   (b) delegation 루프에 빠진 에이전트가 재시작할 때마다 또 시작 → 영원히 안 끝남
  // 기본은 **자동 재개 OFF**. pending-resume 에 ID만 남기고 각 세션에 "재기동됨 — 수동으로 재개"
  // 알림 메시지 append. 옵션(webConfig.autoResume === true) 으로 다시 켤 수 있음.
  const resumeFile = path.join(path.dirname(WEB_CONFIG_PATH), 'logs', 'pending-resume.json');
  try {
    if (fssync.existsSync(resumeFile)) {
      const raw = await fs.readFile(resumeFile, 'utf8');
      await fs.unlink(resumeFile).catch(() => {});
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0) {
        const autoResume = webConfig.autoResume === true; // 기본 false
        logger.info({ count: ids.length, autoResume }, 'interrupted sessions found');
        setTimeout(async () => {
          for (const sid of ids) {
            if (autoResume) {
              try { await resumeInterruptedSession(sid); } catch (err) {
                logger.warn({ sid, err: err.message }, 'resume failed');
              }
            } else {
              // 각 세션에 "재기동됨 — 수동 재개" 안내만 append
              try {
                await sessionsStore.appendMessage(sid, {
                  role: 'assistant',
                  content: '⚠️ **서버 재기동으로 작업이 중단되었습니다.**\n\n이어서 진행하려면 이 세션에 다시 메시지를 보내주세요.\n(자동 재개는 Settings → Access → Server 에서 켤 수 있습니다)'
                });
              } catch { /* ignore */ }
            }
          }
        }, 1500);
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'resume file read failed');
  }

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down');

    // ───────────────────────────────────────────────────────
    // Phase 1: 가장 중요한 작업 — pending-resume 저장 (SYNC)
    // launchctl kickstart -k 는 SIGTERM 후 3-5초 만에 SIGKILL 날림.
    // async write 는 중간에 죽어 파일 안 생길 수 있음 → sync 로.
    // ───────────────────────────────────────────────────────
    try {
      const activeIds = runner.activeIds();
      if (activeIds.length > 0) {
        fssync.mkdirSync(path.dirname(resumeFile), { recursive: true });
        fssync.writeFileSync(resumeFile, JSON.stringify(activeIds), 'utf8');
        logger.warn({ count: activeIds.length, sessions: activeIds }, 'pending-resume persisted (sync)');
        // 세션에 알림 메시지 + runner abort (async 지만 await 안 해도 append 큐에 들어감)
        for (const id of activeIds) {
          sessionsStore.appendMessage(id, {
            role: 'assistant',
            content: '⚠️ **서버 재시작됨** — 다음 기동 시 자동으로 작업을 이어갑니다.'
          }).catch(() => {});
          runner.abort(id);
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'failed to persist resume queue');
    }

    // ───────────────────────────────────────────────────────
    // Phase 2: 나머지 cleanup — 2초 타임아웃, 초과 시 강제 exit
    // server.close() 는 WebSocket keep-alive 때문에 영원히 block 될 수 있음 → timeout
    // ───────────────────────────────────────────────────────
    const forceExit = setTimeout(() => {
      logger.warn('graceful shutdown timeout — forcing exit');
      process.exit(0);
    }, 2000);

    (async () => {
      try {
        scheduler.stop();
        autoBackup.stop();
        try { wsHub.close(); } catch { /* ignore */ }
        // server.close 는 callback-based — WebSocket 연결 있으면 안 끝남 → closeAllConnections 로 강제
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close();
        } catch { /* ignore */ }
        await Promise.allSettled([
          configStore.close(),
          metadataStore.close(),
          projectsStore.close(),
          sessionsStore.close(),
          backendsStore.close(),
          skillsStore.close(),
          activityLog.close()
        ]);
      } catch (err) {
        logger.warn({ err: err.message }, 'cleanup error');
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── 크래시 방지 + 활성 세션 보존 ──
  // 핸들러가 없으면 기본 동작은 silent crash — pending-resume 못 쓰고 그대로 exit.
  // 로그 남기고 pending-resume sync-write 강제 실행 후 exit(1) → launchd KeepAlive 로 재기동.
  function emergencyShutdown(reason, err) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.fatal({ reason, err: err?.message, stack: err?.stack }, 'emergency shutdown');
    try {
      const activeIds = runner.activeIds();
      if (activeIds.length > 0) {
        fssync.mkdirSync(path.dirname(resumeFile), { recursive: true });
        fssync.writeFileSync(resumeFile, JSON.stringify(activeIds), 'utf8');
        logger.warn({ count: activeIds.length, sessions: activeIds },
          'emergency: pending-resume persisted (sync)');
      }
    } catch (persistErr) {
      logger.error({ err: persistErr.message }, 'emergency: failed to persist resume queue');
    }
    // 1초 내 강제 종료 — launchd 가 재시작
    setTimeout(() => process.exit(1), 1000);
  }
  process.on('uncaughtException', (err) => emergencyShutdown('uncaughtException', err));
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    emergencyShutdown('unhandledRejection', err);
  });
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
