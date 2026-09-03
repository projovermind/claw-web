import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHookSettings,
  writeHookSettingsFile,
  removeHookSettingsFile
} from '../server/lib/hook-settings.js';

const hook = (over = {}) => ({
  id: 'h1',
  event: 'PreToolUse',
  matcher: 'Bash',
  command: 'echo hi',
  enabled: true,
  ...over
});

describe('hook-settings: buildHookSettings', () => {
  it('assembles the Claude CLI settings shape', () => {
    const out = buildHookSettings([hook()], 'agent-a');
    expect(out).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }]
      }
    });
  });

  it('returns null when no hook applies (caller omits --settings)', () => {
    expect(buildHookSettings([], 'agent-a')).toBeNull();
    expect(buildHookSettings([hook({ enabled: false })], 'agent-a')).toBeNull();
  });

  it('filters by agentIds; empty agentIds means all agents', () => {
    const scoped = hook({ id: 'h2', agentIds: ['agent-b'] });
    const global = hook({ id: 'h3', agentIds: [], command: 'echo all' });

    expect(buildHookSettings([scoped], 'agent-a')).toBeNull();
    expect(buildHookSettings([scoped], 'agent-b').hooks.PreToolUse).toHaveLength(1);
    expect(buildHookSettings([global], 'agent-a').hooks.PreToolUse[0].hooks[0].command).toBe('echo all');
  });

  it('carries async and timeout only when set', () => {
    const out = buildHookSettings(
      [hook({ async: true, timeout: 30 }), hook({ id: 'h4', matcher: 'Edit' })],
      'agent-a'
    );
    const [bashGroup, editGroup] = out.hooks.PreToolUse;
    expect(bashGroup.hooks[0]).toEqual({ type: 'command', command: 'echo hi', async: true, timeout: 30 });
    expect(editGroup.hooks[0]).toEqual({ type: 'command', command: 'echo hi' });
  });

  it('groups multiple commands under one (event, matcher)', () => {
    const out = buildHookSettings(
      [hook(), hook({ id: 'h5', command: 'echo two' })],
      'agent-a'
    );
    expect(out.hooks.PreToolUse).toHaveLength(1);
    expect(out.hooks.PreToolUse[0].hooks).toHaveLength(2);
  });

  it('drops unknown events and blank commands', () => {
    expect(buildHookSettings([hook({ event: 'Bogus' })], 'a')).toBeNull();
    expect(buildHookSettings([hook({ command: '  ' })], 'a')).toBeNull();
  });
});

describe('hook-settings: writeHookSettingsFile', () => {
  const written = [];
  afterEach(() => {
    for (const p of written.splice(0)) removeHookSettingsFile(p);
  });

  it('writes a temp settings file named after the session', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
    const file = writeHookSettingsFile({
      hooks: [hook()],
      agentId: 'agent-a',
      sessionId: 'sess/1',
      logsDir
    });
    written.push(file);
    expect(path.basename(file)).toBe('hook-settings-sess_1.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse).toHaveLength(1);

    removeHookSettingsFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns null (→ no --settings flag) when nothing applies', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
    expect(
      writeHookSettingsFile({ hooks: [hook({ enabled: false })], agentId: 'a', sessionId: 's', logsDir })
    ).toBeNull();
  });
});
