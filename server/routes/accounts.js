import { Router } from 'express';
import { z } from 'zod';
import { execFile, spawn as cpSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { HttpError } from '../middleware/error-handler.js';

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

  // POST /:id/login — Terminal.app 에서 `CLAUDE_CONFIG_DIR=... claude login` 실행
  // macOS 전용 (osascript). 비-macOS 에서는 login 명령어만 반환.
  router.post('/:id/login', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));
      if (!acc.configDir) return res.status(400).json({ error: 'configDir이 아직 설정되지 않았습니다' });

      const loginCmd = `CLAUDE_CONFIG_DIR=${acc.configDir} ${CLAUDE_BIN} login`;

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

      // managed OAuth 가 있으면 token, 없으면 configDir 사용
      const env = { ...process.env };
      const managedToken = backendsStore?.getOAuthToken?.(acc.id);
      if (managedToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = managedToken;
        delete env.CLAUDE_CONFIG_DIR;
      } else if (acc.configDir) {
        env.CLAUDE_CONFIG_DIR = acc.configDir;
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

      res.json({
        ok: true,
        configDir: acc.configDir,
        output: (stdout || stderr || '').trim(),
        autoActivated: fresh?.status === 'disabled' || fresh?.status === 'needs-relogin',
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
      if (!acc.configDir) return next(new HttpError(400, 'configDir is not set', 'NO_CONFIG_DIR'));
      await fs.mkdir(acc.configDir, { recursive: true });
      const written = [];
      if (data.credentialsJson) {
        const buf = Buffer.from(data.credentialsJson, 'base64');
        // 형식 검증: JSON 파싱 가능해야 함
        try { JSON.parse(buf.toString('utf8')); } catch {
          return next(new HttpError(400, 'credentialsJson is not valid JSON', 'INVALID_BODY'));
        }
        const target = path.join(acc.configDir, '.credentials.json');
        await fs.writeFile(target, buf, { mode: 0o600 });
        written.push('.credentials.json');
      }
      if (data.claudeJson) {
        const buf = Buffer.from(data.claudeJson, 'base64');
        try { JSON.parse(buf.toString('utf8')); } catch {
          return next(new HttpError(400, 'claudeJson is not valid JSON', 'INVALID_BODY'));
        }
        const target = path.join(acc.configDir, '.claude.json');
        await fs.writeFile(target, buf, { mode: 0o600 });
        written.push('.claude.json');
      }
      // 복원 후 disabled/needs-relogin 이면 active 로 자동 승격
      const fresh = accountsStore.getById(acc.id);
      if (fresh?.cred?.has && (fresh.status === 'disabled' || fresh.status === 'needs-relogin')) {
        await accountsStore.update(acc.id, { status: 'active' }).catch(() => {});
      }
      eventBus?.publish('accounts.updated', {});
      res.json({ ok: true, written, account: accountsStore.getById(acc.id) });
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

  // POST /:id/login/headless — spawn `claude login` with stdio pipes, capture URL
  router.post('/:id/login/headless', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));
      if (!acc.configDir) return next(new HttpError(400, 'configDir is not set', 'NO_CONFIG_DIR'));

      // 기존 진행 중 세션이 있으면 종료
      const existing = loginSessions.get(acc.id);
      if (existing?.proc) {
        try { existing.proc.kill('SIGTERM'); } catch { /* ignore */ }
      }

      // ⚠️ Note: `claude login` 은 보통 TTY 를 요구함. 일반 spawn 은 일부 버전에서
      //         "non-interactive" 거부할 수 있음. 동작 안 하면 클라이언트는 fallback
      //         (수동 Terminal command 표시) 으로 안내. 향후 node-pty 도입 검토.
      const env = { ...process.env, CLAUDE_CONFIG_DIR: acc.configDir };
      const child = cpSpawn(CLAUDE_BIN, ['login'], { env, stdio: ['pipe', 'pipe', 'pipe'] });

      const session = {
        proc: child,
        output: '',
        status: 'running',
        urls: [],
        startedAt: Date.now(),
      };
      loginSessions.set(acc.id, session);

      const onData = (d) => {
        const chunk = d.toString();
        session.output += chunk;
        const newUrls = extractUrls(chunk).filter(u => !session.urls.includes(u));
        if (newUrls.length) session.urls.push(...newUrls);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('close', (code) => {
        session.status = code === 0 ? 'success' : 'failed';
        session.exitCode = code;
        if (code === 0) {
          // 성공 → status 자동 활성화
          accountsStore.update(acc.id, { status: 'active' }).catch(() => {});
          eventBus?.publish('accounts.updated', {});
        }
      });
      child.on('error', (err) => {
        session.status = 'failed';
        session.error = err.message;
      });

      // 짧은 대기로 초기 출력 확보 (URL 캡쳐)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      res.json({
        ok: true,
        status: session.status,
        urls: session.urls,
        output: session.output,
        // 호스트 OS 가 대화형 TTY 없이 거부한 경우 클라이언트에 명확히 알림
        ttyRequired: /TTY|tty|terminal|interactive/i.test(session.output) && session.urls.length === 0,
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
      session.proc.stdin.write(code + '\n');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /:id/login/headless — abort
  router.delete('/:id/login/headless', (req, res) => {
    const session = loginSessions.get(req.params.id);
    if (session?.proc) {
      try { session.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    loginSessions.delete(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
