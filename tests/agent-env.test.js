import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { agentPatchSchema, CONFIG_FIELDS, FORBIDDEN_ENV_KEYS } from '../server/schemas/agent.js';
import { startClaudeRun } from '../server/runners/claude-cli-runner.js';

function captureSpawn(captured) {
  return (_bin, args, opts) => {
    captured.args = args;
    captured.env = opts.env;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), { end() {} });
    proc.kill = () => {};
    setImmediate(() => proc.emit('close', 0));
    return proc;
  };
}

function run(agent) {
  const captured = {};
  return new Promise((resolve) => {
    startClaudeRun({
      agent: { id: 'a', model: 'sonnet', workingDir: '/tmp', ...agent },
      message: 'hi',
      callbacks: { onExit: () => resolve(captured) },
      spawn: captureSpawn(captured)
    });
  });
}

describe('agent env schema', () => {
  it('accepts well-formed env and stores it in config.json territory', () => {
    expect(agentPatchSchema.safeParse({ env: { MY_VAR: 'x', A_1: '' } }).success).toBe(true);
    expect(CONFIG_FIELDS.has('env')).toBe(true);
  });

  it('rejects each forbidden key', () => {
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(agentPatchSchema.safeParse({ env: { [key]: 'x' } }).success, key).toBe(false);
    }
  });

  it('rejects malformed keys, oversized values and >32 entries', () => {
    expect(agentPatchSchema.safeParse({ env: { lower: 'x' } }).success).toBe(false);
    expect(agentPatchSchema.safeParse({ env: { '1BAD': 'x' } }).success).toBe(false);
    expect(agentPatchSchema.safeParse({ env: { OK: 'x'.repeat(2001) } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, 'v']));
    expect(agentPatchSchema.safeParse({ env: many }).success).toBe(false);
    expect(agentPatchSchema.safeParse({ env: Object.fromEntries(Object.entries(many).slice(0, 32)) }).success).toBe(true);
  });
});

describe('runner env + permission mode', () => {
  it('merges agent.env into the spawn env, overriding backend env', async () => {
    const captured = await run({ env: { MY_VAR: 'from-agent' } });
    expect(captured.env.MY_VAR).toBe('from-agent');
  });

  it('passes permissionMode straight through to --permission-mode', async () => {
    const captured = await run({ permissionMode: 'auto' });
    const i = captured.args.indexOf('--permission-mode');
    expect(captured.args[i + 1]).toBe('auto');
  });

  it('omits --permission-mode for the default mode', async () => {
    const captured = await run({ permissionMode: 'default' });
    expect(captured.args).not.toContain('--permission-mode');
  });

  it('never combines --permission-mode with --dangerously-skip-permissions', async () => {
    const captured = await run({ permissionMode: 'auto', dangerouslySkipPermissions: true });
    expect(captured.args).toContain('--dangerously-skip-permissions');
    expect(captured.args).not.toContain('--permission-mode');
  });

  it('planMode still wins over permissionMode', async () => {
    const captured = await run({ planMode: true, permissionMode: 'auto' });
    expect(captured.args[captured.args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('passes --settings only when a hook settings file was assembled', async () => {
    expect((await run({})).args).not.toContain('--settings');
    const captured = await run({ hookSettingsPath: '/tmp/hook-settings-x.json' });
    expect(captured.args[captured.args.indexOf('--settings') + 1]).toBe('/tmp/hook-settings-x.json');
  });
});
