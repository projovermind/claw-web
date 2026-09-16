import { describe, it, expect } from 'vitest';
import { detectPlatform, buildCommand, launchTerminal } from '../server/lib/terminal-launcher.js';

/** exec 스텁 — 호출 기록을 남기고, fail 목록에 든 파일명은 던진다. */
function makeExec({ fail = [] } = {}) {
  const calls = [];
  const exec = async (file, argv) => {
    calls.push({ file, argv });
    if (fail.includes(file) || fail === 'all') throw new Error(`spawn ${file} ENOENT`);
    return { stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

describe('detectPlatform', () => {
  it('maps darwin and win32', () => {
    expect(detectPlatform({ platform: 'darwin', env: {} })).toMatchObject({ platform: 'darwin', shell: 'zsh' });
    expect(detectPlatform({ platform: 'win32', env: {} })).toMatchObject({ platform: 'win32', shell: 'cmd' });
  });

  it('reports plain linux when nothing hints at WSL', () => {
    const p = detectPlatform({ platform: 'linux', env: {}, readProcVersion: () => 'Linux version 6.8.0-generic' });
    expect(p).toMatchObject({ platform: 'linux', os: 'linux', shell: 'bash' });
  });

  it('detects WSL from WSL_DISTRO_NAME', () => {
    const p = detectPlatform({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, readProcVersion: () => '' });
    expect(p.platform).toBe('wsl');
    expect(p.os).toBe('linux');
  });

  it('detects WSL from /proc/version microsoft marker', () => {
    const p = detectPlatform({
      platform: 'linux',
      env: {},
      readProcVersion: () => 'Linux version 5.15.0-microsoft-standard-WSL2',
    });
    expect(p.platform).toBe('wsl');
  });

  it('survives an unreadable /proc/version', () => {
    const p = detectPlatform({
      platform: 'linux',
      env: {},
      readProcVersion: () => { throw new Error('EACCES'); },
    });
    expect(p.platform).toBe('linux');
  });

  it('falls back for unknown platforms', () => {
    expect(detectPlatform({ platform: 'freebsd', env: {} })).toMatchObject({ platform: 'freebsd', shell: 'sh' });
  });
});

describe('buildCommand', () => {
  it('prefixes env assignments POSIX-style', () => {
    const cmd = buildCommand({ bin: '/usr/local/bin/claude', env: { CLAUDE_CONFIG_DIR: '/home/u/.claude-claw/account-1' } }, 'darwin');
    expect(cmd).toBe('CLAUDE_CONFIG_DIR=/home/u/.claude-claw/account-1 /usr/local/bin/claude');
  });

  it('appends args', () => {
    expect(buildCommand({ bin: '/bin/claude', args: ['setup-token'] }, 'linux')).toBe('/bin/claude setup-token');
  });

  it('quotes POSIX values containing spaces', () => {
    const cmd = buildCommand({ bin: '/opt/my apps/claude', env: { CLAUDE_CONFIG_DIR: '/Volumes/My Disk/cfg' } }, 'darwin');
    expect(cmd).toBe("CLAUDE_CONFIG_DIR='/Volumes/My Disk/cfg' '/opt/my apps/claude'");
  });

  it('escapes single quotes in POSIX values', () => {
    const cmd = buildCommand({ bin: 'claude', env: { X: "it's" } }, 'linux');
    expect(cmd).toBe(`X='it'\\''s' claude`);
  });

  it('uses set VAR=..&&cmd on win32', () => {
    const cmd = buildCommand(
      { bin: 'C:\\Users\\u\\claude.exe', args: ['setup-token'], env: { CLAUDE_CONFIG_DIR: 'C:\\cfg\\a1' } },
      'win32',
    );
    expect(cmd).toBe('set CLAUDE_CONFIG_DIR=C:\\cfg\\a1&&C:\\Users\\u\\claude.exe setup-token');
  });

  it('quotes win32 paths with spaces but not set values', () => {
    const cmd = buildCommand({ bin: 'C:\\Program Files\\claude.exe', env: { X: 'C:\\a b' } }, 'win32');
    expect(cmd).toBe('set X=C:\\a b&&"C:\\Program Files\\claude.exe"');
  });

  it('caret-escapes cmd metacharacters in set values', () => {
    expect(buildCommand({ bin: 'claude.exe', env: { X: 'a&b' } }, 'win32')).toBe('set X=a^&b&&claude.exe');
  });

  it('throws without a bin', () => {
    expect(() => buildCommand({ args: ['x'] }, 'darwin')).toThrow(/bin is required/);
  });
});

describe('launchTerminal', () => {
  it('opens Terminal.app via osascript on darwin', async () => {
    const exec = makeExec();
    const r = await launchTerminal(
      { bin: '/usr/local/bin/claude', env: { CLAUDE_CONFIG_DIR: '/tmp/cfg' } },
      { platform: 'darwin', exec },
    );

    expect(r).toMatchObject({ ok: true, manual: false, platform: 'darwin', shell: 'zsh', launcher: 'Terminal.app' });
    expect(r.command).toBe('CLAUDE_CONFIG_DIR=/tmp/cfg /usr/local/bin/claude');
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].file).toBe('osascript');
    expect(exec.calls[0].argv[1]).toContain('do script "CLAUDE_CONFIG_DIR=/tmp/cfg /usr/local/bin/claude"');
  });

  it('escapes backslashes and quotes inside the AppleScript literal', async () => {
    const exec = makeExec();
    await launchTerminal({ bin: '/bin/claude', env: { X: 'a"b\\c' } }, { platform: 'darwin', exec });
    const script = exec.calls[0].argv[1];
    // AppleScript 리터럴이 중간에 닫히면 안 된다 — 이스케이프를 걷어내도 여는/닫는 따옴표 2개뿐.
    const literal = script.slice(script.indexOf('do script ')).replace(/\\"/g, '');
    expect(literal.match(/"/g)).toHaveLength(2);
    expect(script).toContain('a\\"b\\\\c');
  });

  it('uses start + cmd /k on win32', async () => {
    const exec = makeExec();
    const r = await launchTerminal({ bin: 'claude.exe', args: ['setup-token'] }, { platform: 'win32', exec, env: {} });

    expect(r).toMatchObject({ ok: true, manual: false, platform: 'win32', shell: 'cmd' });
    expect(r.command).toBe('claude.exe setup-token');
    expect(exec.calls[0].file).toBe('cmd.exe');
    expect(exec.calls[0].argv).toEqual(['/c', 'start', '', 'wt.exe', 'cmd.exe', '/k', 'claude.exe setup-token']);
  });

  it('falls back to plain cmd when Windows Terminal is missing', async () => {
    // 첫 후보(wt)만 실패시키기 위해 argv 를 보고 던지는 스텁.
    const calls = [];
    const exec = async (file, argv) => {
      calls.push({ file, argv });
      if (argv.includes('wt.exe')) throw new Error('wt.exe not found');
      return {};
    };
    const r = await launchTerminal({ bin: 'claude.exe' }, { platform: 'win32', exec, env: {} });

    expect(r.ok).toBe(true);
    expect(r.launcher).toBe('cmd');
    expect(calls).toHaveLength(2);
    expect(calls[1].argv).toEqual(['/c', 'start', '', 'cmd.exe', '/k', 'claude.exe']);
  });

  it('re-enters WSL through cmd.exe start wt.exe wsl.exe', async () => {
    const exec = makeExec();
    const r = await launchTerminal(
      { bin: '/home/u/.local/bin/claude', env: { CLAUDE_CONFIG_DIR: '/home/u/cfg' } },
      { platform: 'wsl', exec, env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' } },
    );

    expect(r).toMatchObject({ ok: true, platform: 'wsl', shell: 'bash', launcher: 'wsl-windows-terminal' });
    // 명령 문자열 자체는 리눅스(POSIX) 문법이어야 한다 — 실행 주체가 bash 이므로.
    expect(r.command).toBe('CLAUDE_CONFIG_DIR=/home/u/cfg /home/u/.local/bin/claude');
    const { file, argv } = exec.calls[0];
    expect(file).toBe('cmd.exe');
    expect(argv.slice(0, 8)).toEqual(['/c', 'start', '', 'wt.exe', 'wsl.exe', '-d', 'Ubuntu-22.04', '--']);
    expect(argv.at(-1)).toContain('exec bash');
  });

  it('omits -d when the WSL distro name is unknown', async () => {
    const exec = makeExec();
    await launchTerminal({ bin: 'claude' }, { platform: 'wsl', exec, env: {} });
    expect(exec.calls[0].argv.slice(0, 6)).toEqual(['/c', 'start', '', 'wt.exe', 'wsl.exe', '--']);
  });

  it('falls back to powershell when cmd.exe is unavailable in WSL', async () => {
    const exec = makeExec({ fail: ['cmd.exe'] });
    const r = await launchTerminal({ bin: 'claude' }, { platform: 'wsl', exec, env: { WSL_DISTRO_NAME: 'Ubuntu' } });

    expect(r).toMatchObject({ ok: true, launcher: 'wsl-powershell' });
    expect(exec.calls.map((c) => c.file)).toEqual(['cmd.exe', 'cmd.exe', 'powershell.exe']);
    expect(exec.calls[2].argv[2]).toContain('Start-Process wsl.exe');
  });

  it('walks the linux terminal list until one works', async () => {
    const exec = makeExec({ fail: ['gnome-terminal', 'konsole'] });
    const r = await launchTerminal({ bin: 'claude' }, { platform: 'linux', exec, env: {} });

    expect(r).toMatchObject({ ok: true, manual: false, launcher: 'xfce4-terminal', platform: 'linux' });
    expect(exec.calls.map((c) => c.file)).toEqual(['gnome-terminal', 'konsole', 'xfce4-terminal']);
  });

  it('returns manual:true with the command when every launcher fails', async () => {
    const exec = makeExec({ fail: 'all' });
    const r = await launchTerminal({ bin: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/c' } }, { platform: 'linux', exec, env: {} });

    expect(r.ok).toBe(false);
    expect(r.manual).toBe(true);
    expect(r.command).toBe('CLAUDE_CONFIG_DIR=/tmp/c claude');
    expect(r.hint).toBeTruthy();
    expect(r.error).toMatch(/ENOENT/);
  });

  it('returns manual:true on an unsupported platform instead of throwing', async () => {
    const exec = makeExec();
    const r = await launchTerminal({ bin: 'claude' }, { platform: 'freebsd', exec, env: {} });

    expect(r).toMatchObject({ ok: false, manual: true, platform: 'freebsd', command: 'claude' });
    expect(r.error).toMatch(/unsupported platform/);
    expect(exec.calls).toHaveLength(0);
  });

  it('returns manual:true instead of throwing when bin is missing', async () => {
    const exec = makeExec();
    const r = await launchTerminal({ bin: null }, { platform: 'darwin', exec, env: {} });

    expect(r).toMatchObject({ ok: false, manual: true, command: '' });
    expect(r.error).toMatch(/bin is required/);
    expect(exec.calls).toHaveLength(0);
  });
});
