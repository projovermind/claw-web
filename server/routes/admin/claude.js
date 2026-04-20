import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileAsync, findClaudeBin, findNodeBin, checkClaudeStatus } from './utils.js';

/** Register /claude/* routes. */
export function registerClaudeRoutes(router, { eventBus }) {
  // 설치 진행 상태 (동시 설치 방지, 모듈 스코프 상태)
  const installState = { running: false, startedAt: null };

  function emit(topic, payload) {
    if (eventBus) eventBus.publish(topic, payload);
  }

  // GET /claude/status — Claude CLI 설치 상태 조회
  router.get('/claude/status', async (_req, res) => {
    try {
      const info = await checkClaudeStatus();
      res.json({ ...info, installing: installState.running });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /claude/install — Claude CLI 설치/재설치
  router.post('/claude/install', async (req, res) => {
    if (installState.running) {
      return res.status(409).json({ error: 'install already in progress' });
    }

    const reinstall = req.body?.reinstall === true;
    const nodeBin = findNodeBin();
    const nodeDir = path.dirname(nodeBin);
    const npmBin = fssync.existsSync(path.join(nodeDir, 'npm'))
      ? path.join(nodeDir, 'npm')
      : 'npm';

    const arch = os.arch();
    const platform = os.platform();
    const nativePkg =
      platform === 'darwin' && arch === 'arm64' ? '@anthropic-ai/claude-code-darwin-arm64' :
      platform === 'darwin' && arch === 'x64'   ? '@anthropic-ai/claude-code-darwin-x64'   :
      platform === 'linux'  && arch === 'arm64' ? '@anthropic-ai/claude-code-linux-arm64'  :
      platform === 'linux'  && arch === 'x64'   ? '@anthropic-ai/claude-code-linux-x64'    :
      null;

    installState.running = true;
    installState.startedAt = new Date().toISOString();
    emit('claude.install.log', { line: `[start] reinstall=${reinstall} platform=${platform}-${arch} nativePkg=${nativePkg}` });
    emit('claude.install.log', { line: `[start] node=${nodeBin}` });
    emit('claude.install.log', { line: `[start] npm=${npmBin}` });

    res.json({ ok: true, message: 'install started', startedAt: installState.startedAt });

    const runStep = (cmd, args, opts = {}) => new Promise((resolve) => {
      emit('claude.install.log', { line: `\n$ ${cmd} ${args.join(' ')}` });
      const child = spawn(cmd, args, {
        env: {
          ...process.env,
          HOME: os.homedir(),
          PATH: `${nodeDir}:${path.join(os.homedir(), '.npm-global', 'bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`
        },
        ...opts
      });
      child.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) emit('claude.install.log', { line });
        }
      });
      child.stderr.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (line) emit('claude.install.log', { line });
        }
      });
      child.on('close', (code) => resolve(code));
      child.on('error', (err) => {
        emit('claude.install.log', { line: `[error] ${err.message}` });
        resolve(-1);
      });
    });

    try {
      const npmGlobalPrefix = path.join(os.homedir(), '.npm-global');
      await fs.mkdir(path.join(npmGlobalPrefix, 'bin'), { recursive: true }).catch(() => {});

      const npmCacheDir = path.join(os.tmpdir(), `claw-web-npm-cache-${process.pid}`);
      await fs.mkdir(npmCacheDir, { recursive: true }).catch(() => {});
      emit('claude.install.log', { line: `[start] npm cache=${npmCacheDir}` });

      await runStep(npmBin, ['config', 'set', 'prefix', npmGlobalPrefix, '--location=user']);
      await runStep(npmBin, ['config', 'set', 'omit', '', '--location=user']);
      await runStep(npmBin, ['config', 'set', 'ignore-scripts', 'false', '--location=user']);

      const installArgs = [
        'install', '-g',
        '--include=optional',
        '--foreground-scripts',
        `--cache=${npmCacheDir}`,
        '@anthropic-ai/claude-code'
      ];
      if (nativePkg) installArgs.push(nativePkg);
      const rc1 = await runStep(npmBin, installArgs);
      emit('claude.install.log', { line: `[exit] npm install rc=${rc1}` });

      if (rc1 !== 0) {
        emit('claude.install.log', {
          line: `\n[hint] 설치 실패. 다음 명령어를 터미널에서 실행한 후 재설치해보세요:\n         sudo chown -R $(id -u):$(id -g) ~/.npm\n         rm -rf ~/.npm/_cacache\n`
        });
      }

      const claudeModuleDir = path.join(npmGlobalPrefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
      const installCjs = path.join(claudeModuleDir, 'install.cjs');
      if (fssync.existsSync(installCjs)) {
        const rc2 = await runStep(nodeBin, [installCjs], { cwd: claudeModuleDir });
        emit('claude.install.log', { line: `[exit] install.cjs rc=${rc2}` });
      } else {
        emit('claude.install.log', { line: `[warn] install.cjs not found at ${installCjs}` });
      }

      const status = await checkClaudeStatus();
      emit('claude.install.log', { line: `[verify] status=${status.status} bin=${status.bin} version=${status.version}` });
      emit('claude.install.done', { status });
    } catch (err) {
      emit('claude.install.log', { line: `[fatal] ${err.message}` });
      emit('claude.install.done', { status: { status: 'error', error: err.message } });
    } finally {
      installState.running = false;
    }
  });

  // POST /claude/login — Terminal.app 에서 `claude login` 실행
  router.post('/claude/login', async (_req, res) => {
    const bin = findClaudeBin();
    if (!bin) {
      return res.status(400).json({ error: 'claude not installed' });
    }
    try {
      const script = `tell application "Terminal" to do script "${bin} login"`;
      await execFileAsync('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { timeout: 5000 });
      res.json({ ok: true, message: 'Terminal opened with claude login' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
