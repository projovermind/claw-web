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
import { createTunnelRouter, autoStartQuickTunnel, stopQuickTunnel } from './routes/tunnel.js';
import { createAdminRouter } from './routes/admin.js';
import { createDomainRouter } from './routes/domain.js';
import { attachWsHub } from './ws/hub.js';
import { attachPtyWs } from './ws/pty.js';
import { attachFsWatchWs } from './ws/fs-watch.js';
import { attachExecWs } from './ws/exec.js';
import { errorHandler } from './middleware/error-handler.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAutoBackup } from './lib/auto-backup.js';
import { createAutoCleanup } from './lib/auto-cleanup.js';
import { createStatsRouter } from './routes/stats.js';
import { createTasksRouter } from './routes/tasks.js';
import { createHooksRouter } from './routes/hooks.js';
import { createMcpRouter } from './routes/mcp.js';
import { createMcpApprovalRouter } from './routes/mcp-approval.js';
import { createApprovalBroker } from './lib/approval-broker.js';
import { nanoid } from 'nanoid';
import { createWorktreeRouter } from './routes/worktree.js';
import { createSchedulesRouter } from './routes/schedules.js';
import { createLspRouter } from './routes/lsp.js';
import { createTerraformRouter } from './routes/terraform.js';
import { createUndoRouter } from './routes/undo.js';
import { createExportImportRouter } from './routes/export-import.js';
import { createBridgeRouter } from './routes/bridge.js';
import { createDelegationsRouter } from './routes/delegations.js';
import { createHooksStore } from './lib/hooks-store.js';
import { createScheduler } from './lib/scheduler.js';
import { createDelegationTracker } from './lib/delegation-tracker.js';
import { createPushStore } from './lib/push-store.js';
import { createPushRouter } from './routes/push.js';
import { createAccountsStore } from './lib/accounts-store.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createAdminUsersStore } from './lib/admin-users-store.js';
import { createAuthRouter, createSessionRegistry } from './routes/auth.js';
import { createAccountScheduler } from './lib/account-scheduler.js';
import { createSessionAnalyzer } from './lib/session-analyzer.js';
import { cleanupLegacyCloudflared } from './lib/legacy-cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════
// Data layout (v1.8+)
//   data/private/   — 개인·민감 (gitignored, 절대 공유 X)
//                     secrets, accounts, web-config, push-subscriptions, sessions
//   data/user/      — 개인 작업물 (gitignored, 보존)
//                     projects, web-metadata, hooks, schedules,
//                     agents-config, backends, skills, uploads, logs, backups
//   data/shared/    — 공유 가능 템플릿 (git committed)
// ═══════════════════════════════════════════════════════
const DATA_DIR = path.join(REPO_ROOT, 'data');
const PRIVATE_DIR = path.join(DATA_DIR, 'private');
const USER_DIR = path.join(DATA_DIR, 'user');
const SHARED_DIR = path.join(DATA_DIR, 'shared');

// 디렉토리 보장 (신규 설치 또는 재구조 후 첫 부팅)
for (const d of [DATA_DIR, PRIVATE_DIR, USER_DIR, SHARED_DIR]) {
  if (!fssync.existsSync(d)) {
    try { fssync.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════
// Layout migration — flat REPO_ROOT/*.json 을 data/{private,user}/ 로 이동
// 한 번만 동작 (.layout-migration-done 마커).
// ═══════════════════════════════════════════════════════
(function migrateLayout() {
  const marker = path.join(DATA_DIR, '.layout-migration-done');
  if (fssync.existsSync(marker)) return;

  const PRIVATE_FILES = [
    'secrets.json', 'accounts.json', 'web-config.json',
    'push-subscriptions.json', 'sessions.json'
  ];
  const PRIVATE_DIRS = ['sessions-store'];
  const USER_FILES = [
    'projects.json', 'web-metadata.json', 'hooks.json', 'schedules.json',
    'agents-config.json', 'backends.json', 'skills.json'
  ];
  const USER_DIRS = ['uploads', 'logs', 'backups', 'agents-config-backups'];

  function moveIfNeeded(src, dst) {
    try {
      if (!fssync.existsSync(src)) return false;
      if (fssync.existsSync(dst)) return false; // 충돌 — 새 파일이 이미 있으면 건드리지 않음
      fssync.renameSync(src, dst);
      return true;
    } catch (err) {
      try {
        // rename 실패 시(예: cross-device) 복사 + 삭제
        if (fssync.statSync(src).isDirectory()) {
          fssync.cpSync(src, dst, { recursive: true });
          fssync.rmSync(src, { recursive: true, force: true });
        } else {
          fssync.copyFileSync(src, dst);
          fssync.unlinkSync(src);
        }
        return true;
      } catch (err2) {
        logger.warn({ src, dst, err: err2.message }, 'layout-migration: move failed');
        return false;
      }
    }
  }

  // *.backup-* 파일은 부모 디렉토리가 아닌 backups/ 서브디렉토리로 이동
  // (auto-backup.js 가 사용하는 위치와 일치시키기 위함)
  function moveBackupsTo(srcDir, dstDir, fileBase) {
    try {
      const re = new RegExp('^' + fileBase.replace(/\./g, '\\.') + '\\.backup-');
      const backupsDir = path.join(dstDir, 'backups');
      try { fssync.mkdirSync(backupsDir, { recursive: true }); } catch { /* ignore */ }
      for (const name of fssync.readdirSync(srcDir)) {
        if (re.test(name)) moveIfNeeded(path.join(srcDir, name), path.join(backupsDir, name));
      }
    } catch { /* ignore */ }
  }

  let moved = 0;
  for (const f of PRIVATE_FILES) {
    if (moveIfNeeded(path.join(REPO_ROOT, f), path.join(PRIVATE_DIR, f))) moved++;
    moveBackupsTo(REPO_ROOT, PRIVATE_DIR, f);
  }
  for (const d of PRIVATE_DIRS) {
    if (moveIfNeeded(path.join(REPO_ROOT, d), path.join(PRIVATE_DIR, d))) moved++;
  }
  for (const f of USER_FILES) {
    if (moveIfNeeded(path.join(REPO_ROOT, f), path.join(USER_DIR, f))) moved++;
    moveBackupsTo(REPO_ROOT, USER_DIR, f);
  }
  for (const d of USER_DIRS) {
    if (moveIfNeeded(path.join(REPO_ROOT, d), path.join(USER_DIR, d))) moved++;
  }

  try { fssync.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
  if (moved > 0) {
    logger.info({ moved }, 'layout-migration: moved flat files into data/{private,user}/');
  }
})();

// ═══════════════════════════════════════════════════════
// Auto-migration — 폴더 이름이 바뀌거나 신규 폴더로 이전했을 때,
// REPO_ROOT 에 실데이터가 없으면 인접 후보 폴더에서 자동 import.
// 한 번만 동작 (migration marker 생성).
// ═══════════════════════════════════════════════════════
(function autoMigrate() {
  const marker = path.join(REPO_ROOT, '.migration-done');
  if (fssync.existsSync(marker)) return;

  // sibling 후보에서 sessions.json 위치를 찾는다 (신·구 레이아웃 모두 고려)
  function findSessionsFile(dir) {
    const nested = path.join(dir, 'data', 'private', 'sessions.json');
    if (fssync.existsSync(nested)) return { sessions: nested, layout: 'nested' };
    const flat = path.join(dir, 'sessions.json');
    if (fssync.existsSync(flat)) return { sessions: flat, layout: 'flat' };
    return null;
  }

  // "실데이터 있음" 판정 (sibling 쪽 sessions.json 이 비어있지 않으면 import 대상)
  function hasSessions(filePath) {
    try {
      const obj = JSON.parse(fssync.readFileSync(filePath, 'utf8'));
      return Object.keys(obj?.sessions || {}).length > 0;
    } catch { return false; }
  }

  // 자기 자신(REPO_ROOT) 의 새 위치에 데이터 있으면 스킵
  const selfSessions = path.join(PRIVATE_DIR, 'sessions.json');
  const selfMetadata = path.join(USER_DIR, 'web-metadata.json');
  if (fssync.existsSync(selfSessions) && hasSessions(selfSessions)) return;
  try {
    if (fssync.existsSync(selfMetadata)) {
      const obj = JSON.parse(fssync.readFileSync(selfMetadata, 'utf8'));
      if (Object.keys(obj?.agents || {}).length > 0) return;
    }
  } catch { /* ignore */ }

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
  let sourceLayout = null;
  for (const c of candidates) {
    const found = findSessionsFile(c);
    if (found && hasSessions(found.sessions)) {
      source = c;
      sourceLayout = found.layout;
      break;
    }
  }

  if (!source) {
    try { fssync.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
    return;
  }

  logger.warn({ source, sourceLayout, dest: REPO_ROOT }, 'auto-migration: copying real data from sibling folder');

  // 카테고리별 파일/디렉토리 — sibling layout 에 따라 src 경로가 다름
  const PRIVATE_FILES = ['sessions.json', 'web-config.json', 'secrets.json', 'accounts.json', 'push-subscriptions.json'];
  const PRIVATE_DIRS = ['sessions-store'];
  const USER_FILES = ['web-metadata.json', 'projects.json', 'skills.json', 'backends.json', 'hooks.json', 'schedules.json', 'agents-config.json'];
  const USER_DIRS = ['logs', 'uploads', 'backups'];

  function srcOf(name, kind) {
    if (sourceLayout === 'nested') {
      return path.join(source, 'data', kind === 'private' ? 'private' : 'user', name);
    }
    return path.join(source, name);
  }

  function copyFileIfNeeded(src, dst) {
    try {
      if (!fssync.existsSync(src)) return;
      if (!fssync.existsSync(dst)) {
        fssync.copyFileSync(src, dst);
      } else {
        // 빈 템플릿은 덮어쓰기
        const srcSize = fssync.statSync(src).size;
        const dstSize = fssync.statSync(dst).size;
        if (srcSize > dstSize * 2) fssync.copyFileSync(src, dst);
      }
    } catch (err) {
      logger.warn({ src, dst, err: err.message }, 'auto-migration file failed');
    }
  }

  function copyDirShallow(src, dst) {
    try {
      if (!fssync.existsSync(src)) return;
      if (!fssync.existsSync(dst)) fssync.mkdirSync(dst, { recursive: true });
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
      logger.warn({ src, dst, err: err.message }, 'auto-migration dir failed');
    }
  }

  for (const f of PRIVATE_FILES) copyFileIfNeeded(srcOf(f, 'private'), path.join(PRIVATE_DIR, f));
  for (const d of PRIVATE_DIRS) copyDirShallow(srcOf(d, 'private'), path.join(PRIVATE_DIR, d));
  for (const f of USER_FILES) copyFileIfNeeded(srcOf(f, 'user'), path.join(USER_DIR, f));
  for (const d of USER_DIRS) copyDirShallow(srcOf(d, 'user'), path.join(USER_DIR, d));

  try { fssync.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
  // layout-migration 도 같이 마킹 — sibling 에서 가져온 데이터는 이미 새 구조
  try { fssync.writeFileSync(path.join(DATA_DIR, '.layout-migration-done'), new Date().toISOString()); } catch { /* ignore */ }
  logger.info({ source, dest: REPO_ROOT }, 'auto-migration complete');
})();

// ═══════════════════════════════════════════════════════
// Orphan backup cleanup — v1.8.0 의 migrateLayout 이 *.backup-* 파일을
// data/{private,user}/ 루트로 옮겼던 버그 보정. backups/ 서브디렉토리로 이동
// 후 24개 초과분은 삭제. 한 번만 동작 (.backup-cleanup-done 마커).
// ═══════════════════════════════════════════════════════
(function cleanupOrphanBackups() {
  const marker = path.join(DATA_DIR, '.backup-cleanup-done');
  if (fssync.existsSync(marker)) return;

  const MAX_PER_FILE = 24;
  let movedCount = 0;
  let trimmedCount = 0;

  function cleanupDir(dir) {
    if (!fssync.existsSync(dir)) return;
    const backupsDir = path.join(dir, 'backups');
    try { fssync.mkdirSync(backupsDir, { recursive: true }); } catch { /* ignore */ }

    let entries;
    try { entries = fssync.readdirSync(dir); } catch { return; }

    // base 파일별로 그룹핑 (e.g. "secrets.json")
    const grouped = new Map();
    for (const name of entries) {
      const m = name.match(/^(.+\.json)\.backup-/);
      if (!m) continue;
      const stat = (() => { try { return fssync.statSync(path.join(dir, name)); } catch { return null; } })();
      if (!stat || !stat.isFile()) continue;
      const base = m[1];
      if (!grouped.has(base)) grouped.set(base, []);
      grouped.get(base).push(name);
    }

    for (const [, names] of grouped) {
      // backups/ 서브로 이동
      for (const name of names) {
        const src = path.join(dir, name);
        const dst = path.join(backupsDir, name);
        try {
          if (fssync.existsSync(dst)) {
            fssync.unlinkSync(src); // 중복이면 원본 삭제
          } else {
            fssync.renameSync(src, dst);
            movedCount++;
          }
        } catch { /* ignore individual move failures */ }
      }
    }

    // backups/ 안의 파일별 24개 초과분 트림
    let backupEntries;
    try { backupEntries = fssync.readdirSync(backupsDir); } catch { return; }
    const byBase = new Map();
    for (const name of backupEntries) {
      const m = name.match(/^(.+\.json)\.backup-/);
      if (!m) continue;
      const base = m[1];
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(name);
    }
    for (const [, names] of byBase) {
      if (names.length <= MAX_PER_FILE) continue;
      const sorted = names.slice().sort().reverse(); // 최신이 앞
      const toDelete = sorted.slice(MAX_PER_FILE);
      for (const old of toDelete) {
        try { fssync.unlinkSync(path.join(backupsDir, old)); trimmedCount++; } catch { /* ignore */ }
      }
    }
  }

  cleanupDir(PRIVATE_DIR);
  cleanupDir(USER_DIR);

  try { fssync.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
  if (movedCount > 0 || trimmedCount > 0) {
    logger.info({ movedCount, trimmedCount }, 'orphan-backup-cleanup: moved into backups/ and trimmed');
  }
})();

// ═══════════════════════════════════════════════════════
// Template seeding — data/shared/*.template.json 을 data/user/*.json 으로
// 시드 (해당 user 파일이 없을 때만). 신규 설치자에게 깨끗한 기본값 제공.
// data/shared/ 는 git tracked, 절대 코드에서 *write* 하지 않음 (read-only).
// ═══════════════════════════════════════════════════════
(function seedFromTemplates() {
  const SEEDS = [
    { template: 'skills.template.json', user: 'skills.json' },
    { template: 'backends.template.json', user: 'backends.json' },
    { template: 'agents-config.template.json', user: 'agents-config.json' }
  ];
  for (const { template, user } of SEEDS) {
    const tmpl = path.join(SHARED_DIR, template);
    const dst = path.join(USER_DIR, user);
    if (fssync.existsSync(dst)) continue;
    if (!fssync.existsSync(tmpl)) continue;
    try {
      fssync.copyFileSync(tmpl, dst);
      logger.info({ template, dst }, 'seeded user file from shared template');
    } catch (err) {
      logger.warn({ template, dst, err: err.message }, 'seed failed');
    }
  }
})();

// ── 데이터 파일 경로 (v1.8+ nested layout) ─────────────
const WEB_CONFIG_PATH = path.join(PRIVATE_DIR, 'web-config.json');
const SESSIONS_PATH = path.join(PRIVATE_DIR, 'sessions.json');
const SECRETS_PATH = path.join(PRIVATE_DIR, 'secrets.json');
const ACCOUNTS_PATH = path.join(PRIVATE_DIR, 'accounts.json');
const ADMIN_USERS_PATH = path.join(PRIVATE_DIR, 'admin-users.json');

const METADATA_PATH = path.join(USER_DIR, 'web-metadata.json');
const PROJECTS_PATH = path.join(USER_DIR, 'projects.json');
const BACKENDS_PATH = path.join(USER_DIR, 'backends.json');
const SKILLS_PATH = path.join(USER_DIR, 'skills.json');
const UPLOADS_DIR = path.join(USER_DIR, 'uploads');
const ACTIVITY_PATH = path.join(USER_DIR, 'logs', 'activity.jsonl');
const PROCESS_TRACKER_PATH = path.join(USER_DIR, 'logs', 'running-processes.json');

// SHARED_DIR 은 read-only (템플릿 전용). 모든 store path 는 PRIVATE_DIR 또는 USER_DIR
// 아래여야 함. 미래에 누가 실수로 SHARED_DIR 로 쓰기 경로를 만들면 부팅 시 즉시 차단.
for (const p of [
  WEB_CONFIG_PATH, SESSIONS_PATH, SECRETS_PATH, ACCOUNTS_PATH,
  METADATA_PATH, PROJECTS_PATH, BACKENDS_PATH, SKILLS_PATH,
  UPLOADS_DIR, ACTIVITY_PATH, PROCESS_TRACKER_PATH
]) {
  if (p === SHARED_DIR || p.startsWith(SHARED_DIR + path.sep)) {
    throw new Error(`misconfiguration: store path points at read-only SHARED_DIR: ${p}`);
  }
}

async function main() {
  const webConfig = loadWebConfig(WEB_CONFIG_PATH);

  // ── 레거시 정리: 구 com.hivemind.cloudflared wrapper 가 새 com.claw-web.tunnel
  //    과 같은 tunnel 에 붙어 간헐적 404 유발. 기동 시 한 번 제거. (v1.2.58+)
  cleanupLegacyCloudflared().catch((err) =>
    logger.warn({ err: err.message }, 'legacy-cleanup: unhandled')
  );

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

  // ── 자가 보정: configPath 누락 (v1.2.55 이전 pkg 설치자 대응) ──
  // configPath 가 undefined 면 proper-lockfile 이 "undefined" 문자열을 path 조각으로
  // 써서 `${REPO_ROOT}/undefined` 를 lstat 하며 ENOENT 로 터진다.
  // 누락/비어있으면 REPO_ROOT/agents-config.json 으로 폴백하고 파일도 없으면 생성.
  if (!webConfig.configPath || typeof webConfig.configPath !== 'string') {
    const defaultCfg = path.join(USER_DIR, 'agents-config.json');
    if (!fssync.existsSync(defaultCfg)) {
      try {
        fssync.writeFileSync(defaultCfg, JSON.stringify({ agents: {}, channels: {} }, null, 2));
        logger.info({ path: defaultCfg }, 'auto-created default agents-config.json');
      } catch (err) {
        logger.error({ err: err.message, path: defaultCfg }, 'failed to create default agents-config.json');
      }
    }
    webConfig.configPath = defaultCfg;
    // 영구 보정: web-config.json 에도 기록해서 다음 기동부터는 이 경로로 로드
    try {
      const raw = fssync.readFileSync(WEB_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      parsed.configPath = defaultCfg;
      fssync.writeFileSync(WEB_CONFIG_PATH, JSON.stringify(parsed, null, 2));
      logger.info({ configPath: defaultCfg }, 'auto-wrote configPath into web-config.json');
    } catch (err) {
      logger.warn({ err: err.message }, 'failed to persist configPath to web-config.json (continuing)');
    }
  } else if (!fssync.existsSync(webConfig.configPath)) {
    // configPath 가 옛 위치(flat)를 가리키는데 새 위치(data/user/agents-config.json)에
    // 마이그레이션 된 파일이 있으면 그걸 사용. 없으면 빈 구조로 새로 생성.
    const migratedCfg = path.join(USER_DIR, 'agents-config.json');
    if (fssync.existsSync(migratedCfg)) {
      logger.info({ from: webConfig.configPath, to: migratedCfg }, 'configPath: redirecting to migrated location');
      webConfig.configPath = migratedCfg;
      try {
        const parsed = JSON.parse(fssync.readFileSync(WEB_CONFIG_PATH, 'utf8'));
        parsed.configPath = migratedCfg;
        fssync.writeFileSync(WEB_CONFIG_PATH, JSON.stringify(parsed, null, 2));
      } catch (err) {
        logger.warn({ err: err.message }, 'failed to persist configPath redirect (continuing)');
      }
    } else {
      try {
        fssync.mkdirSync(path.dirname(webConfig.configPath), { recursive: true });
        fssync.writeFileSync(webConfig.configPath, JSON.stringify({ agents: {}, channels: {} }, null, 2));
        logger.info({ path: webConfig.configPath }, 'auto-created missing agents config');
      } catch (err) {
        logger.error({ err: err.message, path: webConfig.configPath }, 'failed to create agents config');
      }
    }
  }

  const configStore = await createConfigStore(webConfig.configPath);
  const metadataStore = await createMetadataStore(METADATA_PATH);
  const projectsStore = await createProjectsStore(PROJECTS_PATH);
  const sessionsStore = await createSessionsStore(SESSIONS_PATH);
  const secretsStore = await createSecretsStore({ filePath: SECRETS_PATH });
  const backendsStore = await createBackendsStore(BACKENDS_PATH, { secretsStore });
  const accountsStore = await createAccountsStore(ACCOUNTS_PATH, { backendsStore });
  const adminUsersStore = await createAdminUsersStore(ADMIN_USERS_PATH);
  const sessionRegistry = createSessionRegistry();
  // First-boot seeding — if no users exist yet, create a default admin/1234.
  // Operator must change this password immediately (warning logged).
  if (adminUsersStore.count() === 0) {
    try {
      await adminUsersStore.create({ username: 'admin', password: '1234', role: 'admin' });
      logger.warn('seeded default admin user (admin/1234) — change the password immediately');
    } catch (err) {
      logger.error({ err: err.message }, 'failed to seed default admin user');
    }
  }
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
  // 단, soft-restart 로 이어가기 예정(pending-resume 에 있는) 세션의 자식은 보존.
  try {
    const earlyLogsDir = path.join(USER_DIR, 'logs');
    const earlyResumeFile = path.join(earlyLogsDir, 'pending-resume.json');
    const earlySoftFlag = path.join(earlyLogsDir, '.soft-restart');
    let preserveIds = [];
    if (fssync.existsSync(earlySoftFlag) && fssync.existsSync(earlyResumeFile)) {
      try {
        const arr = JSON.parse(fssync.readFileSync(earlyResumeFile, 'utf8'));
        if (Array.isArray(arr)) preserveIds = arr;
      } catch { /* ignore */ }
    }
    const { killed, preserved } = await processTracker.reapOrphans({ preserveSessionIds: preserveIds });
    if (killed > 0) {
      logger.warn({ killed }, 'runner: reaped orphaned Claude CLI processes from previous run');
    }
    if (preserved > 0) {
      logger.info({ preserved }, 'runner: preserved live Claude CLI children for soft-restart resume');
    }
  } catch (err) {
    logger.warn({ err }, 'runner: reapOrphans failed (non-fatal)');
  }
  const accountScheduler = createAccountScheduler({ accountsStore });
  const runner = createRunner({ processTracker, accountScheduler });
  // MCP permission-prompt bridge — shared secret token for the stdio subprocess
  // to authenticate back to the loopback endpoint. Regenerated every boot so
  // leaked tokens from prior runs become worthless.
  const approvalBroker = createApprovalBroker();
  const bridgeToken = nanoid(32);
  const delegationTracker = createDelegationTracker();
  const pushStore = createPushStore({ webConfig, webConfigPath: WEB_CONFIG_PATH });
  pushStore.setRunnerRef(runner); // 작업 중 알림 억제
  const eventBus = createEventBus();
  const hooksStore = await createHooksStore(path.join(USER_DIR, 'hooks.json'));
  const scheduler = createScheduler({
    filePath: path.join(USER_DIR, 'schedules.json'),
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

  // Auto-cleanup: 7일 이상 된 업로드 파일 자동 삭제 (디스크 누적 방지)
  const uploadsCleanup = createAutoCleanup({
    dir: UPLOADS_DIR,
    maxAgeDays: 7,
    label: 'uploads'
  });
  uploadsCleanup.start();

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
  app.use('/api', createAuthMiddleware({ webConfig, adminUsersStore, sessionRegistry }));
  app.use('/api/auth', createAuthRouter({ adminUsersStore, sessionRegistry }));

  app.use('/api/health', createHealthRouter({ healthCheck }));
  app.use('/api/agents', createAgentsRouter({ configStore, metadataStore, projectsStore, skillsStore, sessionsStore, eventBus }));
  app.use(
    '/api/projects',
    createProjectsRouter({ projectsStore, configStore, metadataStore, eventBus })
  );
  // CLAUDE.md / AGENTS.md editor mounted on same prefix
  app.use('/api/projects', createProjectMdRouter({ projectsStore, webConfig, eventBus }));
  app.use('/api/sessions', createSessionsRouter({ sessionsStore, configStore, runner, eventBus }));
  // Phase 5: bridge router is created up-front so chat can inject IDE context
  const bridgeRouter = createBridgeRouter({ webConfig });
  const { router: chatRouter, resumeInterruptedSession } = createChatRouter({
    sessionsStore,
    configStore,
    metadataStore,
    skillsStore,
    systemSkillsStore,
    projectsStore,
    backendsStore,
    accountsStore,
    runner,
    eventBus,
    delegationTracker,
    pushStore,
    webConfig,
    approvalBroker,
    bridgeToken,
    getBridgeContext: (workspace) => bridgeRouter.getContextForWorkspace?.(workspace) ?? null
  });
  app.use('/api/chat', chatRouter);
  // MCP approval — mount at root so `/internal/approval/request` (no /api prefix)
  // bypasses user auth; `/api/chat/:sessionId/approval/:reqId` still goes through
  // the `/api` auth middleware registered above.
  app.use(createMcpApprovalRouter({
    approvalBroker,
    eventBus,
    bridgeToken,
    sessionsStore,
    configStore,
    metadataStore
  }));
  app.use('/api/backends', createBackendsRouter({ backendsStore, eventBus }));
  app.use('/api/accounts', createAccountsRouter({ accountsStore, eventBus, backendsStore }));
  app.use('/api/uploads', createUploadsRouter({ uploadsDir: UPLOADS_DIR, eventBus }));
  app.use(
    '/api/skills',
    createSkillsRouter({ skillsStore, systemSkillsStore, metadataStore, eventBus })
  );
  app.use('/api/activity', createActivityRouter({ activityLog }));
  app.use('/api/fs', createFsBrowserRouter({ webConfig }));
  app.use('/api/tunnel', createTunnelRouter());
  app.use('/api/admin', createAdminRouter({ runner, eventBus }));
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
  app.use('/api/undo', createUndoRouter({ configStore, metadataStore, sessionsStore, eventBus }));
  app.use('/api/delegations', createDelegationsRouter({ delegationTracker }));
  app.use('/api/export-import', createExportImportRouter({ skillsStore, configStore }));
  app.use('/api/bridge', bridgeRouter);

  const distPath = path.join(REPO_ROOT, 'client', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'), (err) => err && next());
  });

  app.use(errorHandler);

  const server = http.createServer(app);
  const wsHub = attachWsHub(server, { eventBus, webConfig, adminUsersStore, sessionRegistry });
  const ptyWs = attachPtyWs(server, { webConfig, adminUsersStore, sessionRegistry });
  const fsWatchWs = attachFsWatchWs(server, { webConfig, adminUsersStore, sessionRegistry });
  const execWs = attachExecWs(server, { webConfig, adminUsersStore, sessionRegistry });

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
    // 외부 접속 URL 자동 구축 — cloudflared 있으면 임시 터널, 없으면 skip
    // webConfig.autoTunnel === false 로 끌 수 있음
    if (webConfig.autoTunnel !== false) {
      setTimeout(() => {
        autoStartQuickTunnel({ logger }).catch((err) =>
          logger.warn({ err: err.message }, 'auto-tunnel: failed')
        );
      }, 1500);
    }
  });

  // ── 재시작 시 중단 세션 처리 ──
  // 기본값: autoResume=false — crash-loop / delegation 루프 재발 방지.
  // 단 Settings 에서 **소프트 재시작** 을 사용자가 명시적으로 눌렀을 때는
  // `.soft-restart` 플래그가 찍혀 있어 이번 한 번만 autoResume=true 로 강제.
  // 이게 없으면 소프트 재시작 = 강제 재시작과 동일해 "(응답 중단)" 만 찍힘.
  const logsDir = path.join(path.dirname(WEB_CONFIG_PATH), 'logs');
  const resumeFile = path.join(logsDir, 'pending-resume.json');
  const softRestartFlag = path.join(logsDir, '.soft-restart');

  let autoResume = webConfig.autoResume === true; // 기본 false
  let softRestartReason = null;
  if (fssync.existsSync(softRestartFlag)) {
    autoResume = true;
    try {
      softRestartReason = JSON.parse(fssync.readFileSync(softRestartFlag, 'utf8'));
      fssync.unlinkSync(softRestartFlag);
    } catch { /* ignore */ }
    logger.info({ reason: softRestartReason }, 'soft-restart detected — auto-resume enabled for this boot');
  }

  // delegation/agent 루프 감지: source 힌트 있으면 autoResume 강제 off
  const _resumeSource = softRestartReason?.source ?? '';
  if (autoResume && (_resumeSource === 'delegation-cli' || _resumeSource === 'agent-triggered')) {
    autoResume = false;
    logger.warn({ source: _resumeSource }, 'soft-restart triggered by agent/delegation — auto-resume suppressed to prevent loop');
  }

  // 쿨다운 상수
  const RESUME_COOLDOWN_MS = 60 * 1000;        // 60초 내 재재개 차단
  const RESUME_MAX_ATTEMPTS = 3;               // 10분 내 최대 3회
  const RESUME_WINDOW_MS = 10 * 60 * 1000;    // 10분 윈도우

  try {
    if (fssync.existsSync(resumeFile)) {
      const raw = await fs.readFile(resumeFile, 'utf8');
      await fs.unlink(resumeFile).catch(() => {});
      let entries = JSON.parse(raw);
      // 구 스키마(string[]) 호환
      if (Array.isArray(entries) && typeof entries[0] === 'string') {
        entries = entries.map(sid => ({ sid, attempts: 0, lastAt: null, queuedAt: new Date().toISOString() }));
      }
      if (Array.isArray(entries) && entries.length > 0) {
        logger.info({ count: entries.length, autoResume }, 'interrupted sessions found');
        setTimeout(async () => {
          const now = Date.now();
          for (const entry of entries) {
            const { sid } = entry;
            if (autoResume) {
              // 쿨다운 체크
              const lastAt = entry.lastAt ? new Date(entry.lastAt).getTime() : 0;
              const attempts = entry.attempts ?? 0;
              const queuedAt = entry.queuedAt ? new Date(entry.queuedAt).getTime() : 0;
              const inWindow = (now - queuedAt) < RESUME_WINDOW_MS;

              if ((now - lastAt) < RESUME_COOLDOWN_MS) {
                logger.warn({ sid, lastAt: entry.lastAt }, 'auto-resume skipped — 60s cooldown not elapsed');
                await sessionsStore.appendMessage(sid, {
                  role: 'assistant',
                  content: '⚠️ **자동 재개 차단** — 60초 내 재재개 시도가 감지되어 루프를 방지합니다. 수동으로 메시지를 보내주세요.'
                }).catch(() => {});
                continue;
              }
              if (inWindow && attempts >= RESUME_MAX_ATTEMPTS) {
                logger.warn({ sid, attempts }, 'auto-resume skipped — 3 attempts in 10min exceeded');
                await sessionsStore.appendMessage(sid, {
                  role: 'assistant',
                  content: '⚠️ **자동 재개 차단** — 10분 내 3회 재개 한도를 초과했습니다. 루프 방지를 위해 수동 재개가 필요합니다.'
                }).catch(() => {});
                continue;
              }

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
        const _queuedAt = new Date().toISOString();
        const _resumeEntries = activeIds.map(sid => ({ sid, attempts: 0, lastAt: null, queuedAt: _queuedAt }));
        fssync.writeFileSync(resumeFile, JSON.stringify(_resumeEntries), 'utf8');
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

    // Phase 1.5: quick tunnel 자식 명시적 정리 — SIGKILL 이 아니라 정상 shutdown 경로.
    // 이 경로를 안 타면 cloudflared 가 고아로 남아 다음 기동 시 중복 누적.
    try { stopQuickTunnel(); } catch { /* ignore */ }

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
        uploadsCleanup.stop();
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
    // Emergency 경로에서도 quick tunnel 자식 정리 — 고아 누적 방지
    try { stopQuickTunnel(); } catch { /* ignore */ }
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
