import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createHooksStore } from './lib/hooks-store.js';
import { createScheduler } from './lib/scheduler.js';
import { createDelegationTracker } from './lib/delegation-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
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
  const eventBus = createEventBus();
  const hooksStore = await createHooksStore(path.join(REPO_ROOT, 'hooks.json'));
  const scheduler = createScheduler({
    filePath: path.join(REPO_ROOT, 'schedules.json'),
    eventBus
  });
  const activityLog = createActivityLog({ filePath: ACTIVITY_PATH, eventBus });
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
  app.use('/api/agents', createAgentsRouter({ configStore, metadataStore, projectsStore, eventBus }));
  app.use(
    '/api/projects',
    createProjectsRouter({ projectsStore, configStore, metadataStore, eventBus })
  );
  // CLAUDE.md / AGENTS.md editor mounted on same prefix
  app.use('/api/projects', createProjectMdRouter({ projectsStore, webConfig, eventBus }));
  app.use('/api/sessions', createSessionsRouter({ sessionsStore, configStore, runner, eventBus }));
  app.use(
    '/api/chat',
    createChatRouter({
      sessionsStore,
      configStore,
      metadataStore,
      skillsStore,
      systemSkillsStore,
      projectsStore,
      backendsStore,
      runner,
      eventBus,
      delegationTracker
    })
  );
  app.use('/api/backends', createBackendsRouter({ backendsStore, eventBus }));
  app.use('/api/uploads', createUploadsRouter({ uploadsDir: UPLOADS_DIR, eventBus }));
  app.use(
    '/api/skills',
    createSkillsRouter({ skillsStore, systemSkillsStore, metadataStore, eventBus })
  );
  app.use('/api/activity', createActivityRouter({ activityLog }));
  app.use('/api/fs', createFsBrowserRouter({ webConfig }));
  app.use('/api/tunnel', createTunnelRouter());
  app.use('/api/settings', createSettingsRouter({ webConfig, webConfigPath: WEB_CONFIG_PATH, eventBus }));
  app.use('/api/stats', createStatsRouter({ sessionsStore, configStore }));
  app.use('/api/tasks', createTasksRouter({ eventBus }));
  app.use('/api/hooks', createHooksRouter({ hooksStore, eventBus }));
  app.use('/api/mcp', createMcpRouter({ projectsStore }));
  app.use('/api/worktree', createWorktreeRouter({ projectsStore }));
  app.use('/api/schedules', createSchedulesRouter({ scheduler, eventBus }));
  app.use('/api/lsp', createLspRouter({ projectsStore }));

  const distPath = path.join(REPO_ROOT, 'client', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'), (err) => err && next());
  });

  app.use(errorHandler);

  const server = http.createServer(app);
  const wsHub = attachWsHub(server, { eventBus, webConfig });

  server.listen(webConfig.port, () => {
    logger.info({ port: webConfig.port }, 'hivemind-web server listening');
  });

  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    scheduler.stop();
    autoBackup.stop();
    wsHub.close();
    server.close();
    for (const id of runner.activeIds()) runner.abort(id);
    await configStore.close();
    await metadataStore.close();
    await projectsStore.close();
    await sessionsStore.close();
    await backendsStore.close();
    await skillsStore.close();
    await activityLog.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
