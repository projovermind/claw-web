// terminal-launcher — 사용자에게 보이는 터미널 창을 열어 명령 하나를 실행한다.
//
// 계정 로그인(`claude` TUI)·토큰 발급(`claude setup-token`) 처럼 사람이 직접
// 타이핑해야 하는 흐름은 서버가 대신 실행할 수 없다. 대신 OS 별 터미널을 띄워
// 준다. 띄우지 못하는 환경(헤드리스, 낯선 배포판)에서는 throw 하지 않고
// manual:true + 복붙 가능한 command 문자열을 돌려주는 것이 이 모듈의 계약이다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fssync from 'node:fs';

const execFileAsync = promisify(execFile);

const LAUNCH_TIMEOUT_MS = 5000;

/** 따옴표가 필요 없는 POSIX 토큰. */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quotePosix(value) {
  const s = String(value);
  if (s === '') return "''";
  if (POSIX_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function quoteWin(value) {
  const s = String(value);
  return /[\s&|<>^"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// cmd 의 `set VAR=값` 은 = 뒤부터 &&(또는 줄끝)까지가 전부 값이라 따옴표를 쓰면
// 따옴표까지 값에 들어간다. 대신 메타문자만 ^ 로 이스케이프.
function escapeWinSetValue(value) {
  return String(value).replace(/[&|<>^()]/g, (c) => `^${c}`);
}

// AppleScript 문자열 리터럴 안으로 넣기 위한 이스케이프 (역슬래시 먼저).
function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const SHELL_BY_PLATFORM = { darwin: 'zsh', win32: 'cmd', wsl: 'bash', linux: 'bash' };

function isWsl({ env = process.env, readProcVersion } = {}) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  const read = readProcVersion ?? (() => {
    try { return fssync.readFileSync('/proc/version', 'utf8'); } catch { return ''; }
  });
  try {
    return /microsoft/i.test(read() || '');
  } catch {
    return false;
  }
}

/**
 * 실행 플랫폼 판별.
 * @returns {{platform:'darwin'|'win32'|'wsl'|'linux'|string, os:string, shell:string}}
 */
export function detectPlatform({ platform = process.platform, env = process.env, readProcVersion } = {}) {
  if (platform === 'darwin') return { platform: 'darwin', os: 'darwin', shell: 'zsh' };
  if (platform === 'win32') return { platform: 'win32', os: 'win32', shell: 'cmd' };
  if (platform === 'linux') {
    if (isWsl({ env, readProcVersion })) return { platform: 'wsl', os: 'linux', shell: 'bash' };
    return { platform: 'linux', os: 'linux', shell: 'bash' };
  }
  return { platform, os: platform, shell: 'sh' };
}

/**
 * 사용자가 복붙할 수 있는 한 줄 명령 문자열을 만든다.
 * win32: `set VAR=값&&cmd args`  /  그 외: `VAR=값 cmd args`
 */
export function buildCommand({ bin, args = [], env = {} } = {}, platform = detectPlatform().platform) {
  if (!bin) throw new Error('buildCommand: bin is required');

  if (platform === 'win32') {
    const assigns = Object.entries(env)
      .map(([k, v]) => `set ${k}=${escapeWinSetValue(v)}&&`)
      .join('');
    return assigns + [bin, ...args].map(quoteWin).join(' ');
  }

  const assigns = Object.entries(env)
    .map(([k, v]) => `${k}=${quotePosix(v)} `)
    .join('');
  return assigns + [bin, ...args].map(quotePosix).join(' ');
}

// 창이 바로 닫히지 않게 명령 뒤에 셸을 붙인다 (darwin 의 `do script` 는 불필요).
function keepOpenScript(command) {
  return `${command}; exec bash`;
}

/**
 * 플랫폼별 실행 후보 목록. 앞에서부터 시도해 처음 성공한 것을 쓴다.
 * @returns {Array<{name:string, file:string, argv:string[]}>}
 */
function launchCandidates(platform, command, { env = process.env } = {}) {
  switch (platform) {
    case 'darwin': {
      const esc = escapeAppleScript(command);
      return [{
        name: 'Terminal.app',
        file: 'osascript',
        argv: [
          '-e', `tell application "Terminal" to do script "${esc}"`,
          '-e', 'tell application "Terminal" to activate',
        ],
      }];
    }

    case 'win32':
      return [
        { name: 'windows-terminal', file: 'cmd.exe', argv: ['/c', 'start', '', 'wt.exe', 'cmd.exe', '/k', command] },
        { name: 'cmd', file: 'cmd.exe', argv: ['/c', 'start', '', 'cmd.exe', '/k', command] },
        { name: 'powershell', file: 'powershell.exe', argv: ['-NoProfile', '-Command', `Start-Process cmd.exe -ArgumentList '/k','${command.replace(/'/g, "''")}'`] },
      ];

    case 'wsl': {
      // WSL 안의 리눅스 명령을 윈도우 호스트의 새 창에서 띄운다 → wsl.exe 로 되돌아 들어감.
      const distro = env.WSL_DISTRO_NAME;
      const inner = distro ? ['wsl.exe', '-d', distro, '--'] : ['wsl.exe', '--'];
      const script = keepOpenScript(command);
      return [
        { name: 'wsl-windows-terminal', file: 'cmd.exe', argv: ['/c', 'start', '', 'wt.exe', ...inner, 'bash', '-lc', script] },
        { name: 'wsl-cmd', file: 'cmd.exe', argv: ['/c', 'start', '', ...inner, 'bash', '-lc', script] },
        {
          name: 'wsl-powershell',
          file: 'powershell.exe',
          argv: ['-NoProfile', '-Command',
            `Start-Process wsl.exe -ArgumentList ${[...inner.slice(1), 'bash', '-lc', script].map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')}`],
        },
      ];
    }

    case 'linux': {
      const script = keepOpenScript(command);
      return [
        { name: 'gnome-terminal', file: 'gnome-terminal', argv: ['--', 'bash', '-lc', script] },
        { name: 'konsole', file: 'konsole', argv: ['-e', 'bash', '-lc', script] },
        { name: 'xfce4-terminal', file: 'xfce4-terminal', argv: ['-e', `bash -lc ${quotePosix(script)}`] },
        { name: 'x-terminal-emulator', file: 'x-terminal-emulator', argv: ['-e', 'bash', '-lc', script] },
        { name: 'xterm', file: 'xterm', argv: ['-e', 'bash', '-lc', script] },
      ];
    }

    default:
      return [];
  }
}

function manualHint(platform) {
  if (platform === 'win32') return '터미널(cmd)을 열고 아래 명령을 실행하세요.';
  if (platform === 'wsl') return 'WSL 터미널을 열고 아래 명령을 실행하세요.';
  if (platform === 'darwin') return '터미널을 열고 아래 명령을 실행하세요.';
  return '터미널을 직접 열고 아래 명령을 실행하세요.';
}

/**
 * 터미널 창을 열어 명령을 실행한다. 절대 throw 하지 않는다.
 *
 * @param {{bin:string, args?:string[], env?:Record<string,string>}} spec
 * @param {{platform?:string, env?:object, exec?:Function}} [deps] 테스트 주입용
 * @returns {Promise<{ok:boolean, manual:boolean, command:string, platform:string,
 *                    shell:string, hint:string, launcher?:string, error?:string}>}
 */
export async function launchTerminal(spec, deps = {}) {
  const env = deps.env ?? process.env;
  // deps.platform 은 이미 판별된 결과('wsl' 포함)로 취급 — 테스트에서 재판별을 건너뛴다.
  const info = deps.platform
    ? { platform: deps.platform, shell: SHELL_BY_PLATFORM[deps.platform] ?? 'sh' }
    : detectPlatform({ env });
  const { platform, shell } = info;

  let command;
  try {
    command = buildCommand(spec, platform);
  } catch (err) {
    return { ok: false, manual: true, command: '', platform, shell, hint: manualHint(platform), error: err.message };
  }

  const base = { command, platform, shell };
  const exec = deps.exec ?? ((file, argv) => execFileAsync(file, argv, { timeout: LAUNCH_TIMEOUT_MS }));
  const candidates = launchCandidates(platform, command, { env });

  if (candidates.length === 0) {
    return { ...base, ok: false, manual: true, hint: manualHint(platform), error: `unsupported platform: ${platform}` };
  }

  let lastError = null;
  for (const c of candidates) {
    try {
      await exec(c.file, c.argv);
      return { ...base, ok: true, manual: false, launcher: c.name, hint: '터미널 창이 열렸습니다. 그 창에서 계속 진행하세요.' };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ...base,
    ok: false,
    manual: true,
    hint: manualHint(platform),
    error: lastError ? (lastError.message || String(lastError)) : 'no terminal launcher available',
  };
}
