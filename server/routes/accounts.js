import { Router } from 'express';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { HttpError } from '../middleware/error-handler.js';
import { resolveConfigDir, ensureConfigDir } from '../lib/config-dir.js';

// node-pty 는 native binding — 일부 환경(CI, 일부 도커)에서 실패 가능 →
//  optional import 로 처리, 없으면 헤드리스 로그인은 ttyRequired:true 로 응답.
let ptyMod = null;
try {
  ptyMod = await import('node-pty');
} catch { /* graceful fallback */ }

// ANSI escape 시퀀스 제거 (Ink/TUI 출력 정리용)
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

const execFileAsync = promisify(execFile);

const createSchema = z.object({
  label: z.string().min(1).max(80),
  configDir: z.string().max(500).optional(),
  priority: z.number().int().min(0).max(999).optional(),
  models: z.record(z.string().max(200)).optional(),
}).strict();

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  configDir: z.string().max(500).optional(),
  status: z.enum(['active', 'cooldown', 'disabled', 'needs-relogin']).optional(),
  priority: z.number().int().min(0).max(999).optional(),
  models: z.record(z.string().max(200)).optional(),
}).strict();

const oauthTokenSchema = z.object({
  // null/'' 이면 토큰 제거. 형식 검증은 길이만 (실제 검증은 사용 시점)
  token: z.string().max(2000).nullable(),
}).strict();

const importSchema = z.object({
  // base64 로 인코드된 파일 내용 — 보통 .credentials.json
  credentialsJson: z.string().max(50_000).optional(),
  claudeJson: z.string().max(2_000_000).optional(),
}).strict();

function findClaudeBin() {
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return 'claude';
}

const CLAUDE_BIN = findClaudeBin();

/**
 * If a managed OAuth token exists for this backend and a newer .credentials.json
 * has appeared (e.g. after a Terminal/headless login), remove the managed token so
 * the file-based credential takes precedence.
 *
 * Safety gates:
 *  - managed token must actually exist
 *  - backend.autoReplaceOnLogin must not be false
 *  - .credentials.json mtime must be strictly newer than secrets.json mtime
 *
 * Returns { removed: boolean, skipped?: boolean }
 */
export async function maybeRemoveManagedOAuth(backendId, configDir, backendsStore) {
  if (!backendsStore) return { removed: false };
  const managed = backendsStore.getOAuthToken?.(backendId);
  if (!managed) return { removed: false };

  const backend = backendsStore.getBackend?.(backendId);
  if (backend?.autoReplaceOnLogin === false) return { removed: false, skipped: true };

  const credsPath = path.join(configDir, '.credentials.json');
  const secretsPath = backendsStore.getSecretsFilePath?.();
  try {
    const [credsStat, secretsStat] = await Promise.all([
      fs.stat(credsPath),
      secretsPath ? fs.stat(secretsPath) : Promise.resolve(null),
    ]);
    // Only replace when creds file is strictly newer than secrets.json
    if (secretsStat && credsStat.mtimeMs <= secretsStat.mtimeMs) return { removed: false };
    await backendsStore.setOAuthToken(backendId, null);
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

export function createAccountsRouter({ accountsStore, eventBus, backendsStore }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ accounts: accountsStore.getAll() });
  });

  router.get('/:id', (req, res, next) => {
    const acc = accountsStore.getById(req.params.id);
    if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));
    res.json(acc);
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const home = process.env.HOME || process.env.USERPROFILE || '/tmp';

      // Create account first to get the ID
      const account = await accountsStore.create({
        label: data.label,
        configDir: data.configDir ?? '',  // placeholder, updated below
        priority: data.priority ?? 0,
        models: data.models ?? {},
      });

      // Resolve final configDir
      const configDir = data.configDir || path.join(home, '.claude-claw', `account-${account.id}`);
      await fs.mkdir(configDir, { recursive: true });

      if (!data.configDir) {
        await accountsStore.update(account.id, { configDir });
      }

      eventBus?.publish('accounts.updated', {});
      res.status(201).json(accountsStore.getById(account.id));
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const patch = updateSchema.parse(req.body);
      const updated = await accountsStore.update(req.params.id, patch);

      if (patch.configDir) {
        await fs.mkdir(patch.configDir, { recursive: true }).catch(() => {});
      }

      eventBus?.publish('accounts.updated', {});
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await accountsStore.delete(req.params.id);
      eventBus?.publish('accounts.updated', {});
      res.status(204).end();
    } catch (err) {
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      next(err);
    }
  });

  // POST /:id/login — Terminal.app 에서 `CLAUDE_CONFIG_DIR=... claude` 실행 (TUI 진입)
  //  Claude Code v2.x 는 `claude login` 서브커맨드가 OAuth 를 직접 띄우지 않음 →
  //  TUI 진입 후 사용자가 `/login` 슬래시 명령을 입력해야 함.
  // macOS 전용 (osascript). 비-macOS 에서는 명령어만 반환.
  router.post('/:id/login', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));

      // Layer 1: configDir 폴백 — 비어있으면 자동 생성 & 저장 (초보자 친화)
      const configDir = resolveConfigDir(acc.id, acc.configDir);
      await ensureConfigDir(configDir);
      if (!acc.configDir) {
        await accountsStore.update(acc.id, { configDir }).catch(() => {});
      }

      // TUI 진입 → 사용자가 `/login` 직접 입력. (login 서브커맨드는 v2.x 에서 무용)
      const loginCmd = `CLAUDE_CONFIG_DIR=${configDir} ${CLAUDE_BIN}`;

      if (process.platform !== 'darwin') {
        return res.json({ ok: false, manual: true, command: loginCmd, message: 'macOS가 아니면 직접 실행하세요' });
      }

      const script = `tell application "Terminal" to do script "${loginCmd}"`;
      await execFileAsync('osascript', [
        '-e', script,
        '-e', 'tell application "Terminal" to activate'
      ], { timeout: 5000 });

      res.json({ ok: true, message: 'Terminal을 통해 로그인 창을 열었습니다', command: loginCmd });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /:id/test — run `claude --version` with account's CLAUDE_CONFIG_DIR.
  // 추가로 토큰 유효성을 확인하고 disabled/needs-relogin 상태였다면 active 로 자동 승격.
  router.post('/:id/test', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));

      // managed OAuth 가 있으면 token, 없으면 configDir 사용 (폴백 자동 적용)
      const env = { ...process.env };
      const managedToken = backendsStore?.getOAuthToken?.(acc.id);
      if (managedToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = managedToken;
        delete env.CLAUDE_CONFIG_DIR;
      } else {
        env.CLAUDE_CONFIG_DIR = resolveConfigDir(acc.id, acc.configDir);
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      }

      const { stdout, stderr } = await execFileAsync(CLAUDE_BIN, ['--version'], {
        env,
        timeout: 10_000,
      });

      // 성공 → cred 도 보유 → disabled / needs-relogin 자동 활성화
      const fresh = accountsStore.getById(acc.id);
      if (fresh && fresh.cred?.has && (fresh.status === 'disabled' || fresh.status === 'needs-relogin')) {
        await accountsStore.update(acc.id, { status: 'active' }).catch(() => {});
        eventBus?.publish('accounts.updated', {});
      }

      // Terminal 로그인 후 .credentials.json 이 생겼으면 managed OAuth 자동 제거
      const credDir = resolveConfigDir(acc.id, acc.configDir);
      const replaceResult = await maybeRemoveManagedOAuth(acc.id, credDir, backendsStore);
      if (replaceResult.removed) eventBus?.publish('accounts.updated', {});

      res.json({
        ok: true,
        configDir: acc.configDir,
        output: (stdout || stderr || '').trim(),
        autoActivated: fresh?.status === 'disabled' || fresh?.status === 'needs-relogin',
        managedTokenReplaced: replaceResult.removed,
      });
    } catch (err) {
      const acc = accountsStore.getById(req.params.id);
      res.json({
        ok: false,
        configDir: acc?.configDir,
        error: err.message,
      });
    }
  });

  // ── Managed OAuth 토큰 (CLAUDE_CODE_OAUTH_TOKEN 직접 붙여넣기) ──
  // PUT /:id/oauth-token  body: { token: string | null }
  router.put('/:id/oauth-token', async (req, res, next) => {
    try {
      if (!backendsStore) return next(new HttpError(500, 'backends store not configured', 'NO_BACKENDS_STORE'));
      const { token } = oauthTokenSchema.parse(req.body);
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));
      await backendsStore.setOAuthToken(req.params.id, token || null);
      // 토큰 저장 후 status 가 disabled / needs-relogin 이면 active 로 자동 승격
      if (token && (acc.status === 'disabled' || acc.status === 'needs-relogin')) {
        await accountsStore.update(req.params.id, { status: 'active' }).catch(() => {});
      }
      eventBus?.publish('accounts.updated', {});
      res.json({ ok: true, hasToken: !!token, account: accountsStore.getById(req.params.id) });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // ── Backup / Restore ──
  // GET /:id/export — return base64 of .credentials.json + .claude.json + managed OAuth token
  router.get('/:id/export', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));
      const out = {
        accountId: acc.id,
        label: acc.label,
        exportedAt: new Date().toISOString(),
      };
      if (acc.configDir) {
        try {
          const credsPath = path.join(acc.configDir, '.credentials.json');
          if (fssync.existsSync(credsPath)) {
            out.credentialsJson = (await fs.readFile(credsPath)).toString('base64');
          }
          const claudeJsonPath = path.join(acc.configDir, '.claude.json');
          if (fssync.existsSync(claudeJsonPath)) {
            out.claudeJson = (await fs.readFile(claudeJsonPath)).toString('base64');
          }
        } catch (err) {
          // 부분 실패 허용 — 가능한 만큼만 export
          out.warn = `partial export: ${err.message}`;
        }
      }
      const managed = backendsStore?.getOAuthToken?.(acc.id);
      if (managed) out.managedOAuthToken = managed;
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/import  body: { credentialsJson?: base64, claudeJson?: base64 }
  router.post('/:id/import', async (req, res, next) => {
    try {
      const data = importSchema.parse(req.body);
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));

      // Layer 1: configDir 폴백 — 비어있으면 자동 생성 & 저장
      const configDir = resolveConfigDir(acc.id, acc.configDir);
      await ensureConfigDir(configDir);
      if (!acc.configDir) {
        await accountsStore.update(acc.id, { configDir }).catch(() => {});
      }

      const written = [];
      if (data.credentialsJson) {
        const buf = Buffer.from(data.credentialsJson, 'base64');
        // 형식 검증: JSON 파싱 가능해야 함
        try { JSON.parse(buf.toString('utf8')); } catch {
          return next(new HttpError(400, 'credentialsJson is not valid JSON', 'INVALID_BODY'));
        }
        const target = path.join(configDir, '.credentials.json');
        await fs.writeFile(target, buf, { mode: 0o600 });
        written.push('.credentials.json');
      }
      if (data.claudeJson) {
        const buf = Buffer.from(data.claudeJson, 'base64');
        try { JSON.parse(buf.toString('utf8')); } catch {
          return next(new HttpError(400, 'claudeJson is not valid JSON', 'INVALID_BODY'));
        }
        const target = path.join(configDir, '.claude.json');
        await fs.writeFile(target, buf, { mode: 0o600 });
        written.push('.claude.json');
      }
      // 복원 후 disabled/needs-relogin 이면 active 로 자동 승격
      const fresh = accountsStore.getById(acc.id);
      if (fresh?.cred?.has && (fresh.status === 'disabled' || fresh.status === 'needs-relogin')) {
        await accountsStore.update(acc.id, { status: 'active' }).catch(() => {});
      }
      // .credentials.json 임포트 → managed OAuth 자동 제거 (파일이 방금 기록됐으므로 무조건 신규)
      let managedTokenReplaced = false;
      if (data.credentialsJson) {
        const r = await maybeRemoveManagedOAuth(acc.id, configDir, backendsStore);
        managedTokenReplaced = r.removed;
      }
      eventBus?.publish('accounts.updated', {});
      res.json({ ok: true, written, managedTokenReplaced, account: accountsStore.getById(acc.id) });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // ── Headless OAuth login (Phase 3) ──
  // 세션 메모리에 진행 중인 login 프로세스를 보관. 한 계정당 동시 1개.
  const loginSessions = new Map(); // accountId -> { proc, output, status, urls }

  function extractUrls(text) {
    const matches = text.match(/https?:\/\/[^\s)>'"]+/g);
    return matches ?? [];
  }

  // POST /:id/login/headless — spawn `claude login` in a real PTY (node-pty),
  //  capture OAuth URL from the Ink-based TUI output.
  //  일반 spawn 으로는 Claude CLI 2.x 가 TTY 부재로 즉시 종료됨 → node-pty 필수.
  router.post('/:id/login/headless', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));

      // Layer 1: configDir 폴백 — 비어있으면 자동 생성 & 저장 (초보자 친화)
      const configDir = resolveConfigDir(acc.id, acc.configDir);
      await ensureConfigDir(configDir);
      if (!acc.configDir) {
        await accountsStore.update(acc.id, { configDir }).catch(() => {});
      }

      // node-pty 가 로드되지 못한 환경 → 즉시 ttyRequired 안내
      if (!ptyMod) {
        return res.json({
          ok: true,
          status: 'failed',
          urls: [],
          output: 'node-pty 모듈을 로드할 수 없어 헤드리스 로그인을 진행할 수 없습니다. ' +
                  '"토큰 붙여넣기" 또는 "Terminal 로그인" 탭을 사용하세요.',
          ttyRequired: true,
        });
      }

      // 기존 진행 중 세션이 있으면 종료
      const existing = loginSessions.get(acc.id);
      if (existing?.proc) {
        try { existing.proc.kill?.(); } catch { /* ignore */ }
      }

      const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color' };
      const proc = ptyMod.spawn(CLAUDE_BIN, ['login'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.env.HOME || '/tmp',
        env,
      });

      const session = {
        proc,
        output: '',
        status: 'running',
        urls: [],
        startedAt: Date.now(),
      };
      loginSessions.set(acc.id, session);

      proc.onData((data) => {
        const clean = stripAnsi(data);
        session.output += clean;
        // 메모리 누수 방어 — 64KB 초과 시 앞부분 절단
        if (session.output.length > 65536) {
          session.output = session.output.slice(-32768);
        }
        const newUrls = extractUrls(clean).filter(u => !session.urls.includes(u));
        if (newUrls.length) session.urls.push(...newUrls);
      });
      proc.onExit(({ exitCode }) => {
        session.status = exitCode === 0 ? 'success' : 'failed';
        session.exitCode = exitCode;
        if (exitCode === 0) {
          accountsStore.update(acc.id, { status: 'active' }).catch(() => {});
          // 헤드리스 로그인 성공 → .credentials.json 생성됨 → managed OAuth 자동 제거
          maybeRemoveManagedOAuth(acc.id, configDir, backendsStore).then((r) => {
            if (r.removed) eventBus?.publish('accounts.updated', {});
          }).catch(() => {});
          eventBus?.publish('accounts.updated', {});
        }
      });

      // 초기 출력 확보를 위해 잠시 대기 (Ink 가 URL 을 그릴 시간)
      //  Claude CLI 가 처음 이메일 등을 입력 받기 전 OAuth URL 을 보여주는 구조.
      await new Promise((resolve) => setTimeout(resolve, 2500));

      res.json({
        ok: true,
        status: session.status,
        urls: session.urls,
        output: session.output.slice(-4000),
        ttyRequired: false,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /:id/login/headless — poll current state
  router.get('/:id/login/headless', (req, res) => {
    const session = loginSessions.get(req.params.id);
    if (!session) return res.json({ ok: false, status: 'none' });
    res.json({
      ok: true,
      status: session.status,
      urls: session.urls,
      output: session.output.slice(-4000), // tail
      exitCode: session.exitCode,
      error: session.error,
    });
  });

  // POST /:id/login/headless/code  body: { code: string }
  router.post('/:id/login/headless/code', async (req, res, next) => {
    try {
      const code = String(req.body?.code ?? '').trim();
      if (!code) return next(new HttpError(400, 'code required', 'INVALID_BODY'));
      const session = loginSessions.get(req.params.id);
      if (!session?.proc) return next(new HttpError(404, 'No active login session', 'NOT_FOUND'));
      // node-pty PTY 프로세스는 .stdin 이 없음 — proc.write() 로 직접 전송
      session.proc.write(code + '\n');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /:id/login/headless — abort
  router.delete('/:id/login/headless', (req, res) => {
    const session = loginSessions.get(req.params.id);
    if (session?.proc) {
      // node-pty .kill() 은 인자 없이 호출 (signal 옵션은 PTY 환경에 따라 무시됨)
      try { session.proc.kill(); } catch { /* ignore */ }
    }
    loginSessions.delete(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
