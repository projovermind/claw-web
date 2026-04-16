import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { startClaudeRun } from '../server/runners/claude-cli-runner.js';

function mockSpawn(stdoutLines, stderrLines = [], exitCode = 0) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      for (const line of stdoutLines) proc.stdout.emit('data', line + '\n');
      for (const line of stderrLines) proc.stderr.emit('data', line + '\n');
      proc.emit('close', exitCode);
    });
    return proc;
  };
}

describe('claude-cli-runner', () => {
  it('emits text and result on happy path', async () => {
    const events = { text: [], tool: [], result: null, error: null };
    await new Promise((resolve) => {
      startClaudeRun({
        agent: { id: 'x', model: 'sonnet', workingDir: '/tmp', systemPrompt: 'sp' },
        message: 'hi',
        callbacks: {
          onText: (t) => events.text.push(t),
          onToolUse: (t) => events.tool.push(t),
          onResult: (r) => {
            events.result = r;
            resolve();
          },
          onError: (e) => {
            events.error = e;
            resolve();
          }
        },
        spawn: mockSpawn([
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'hello' }] }
          }),
          JSON.stringify({
            type: 'result',
            result: 'hello',
            session_id: 'csess-1',
            model: 'claude-sonnet-4-6'
          })
        ])
      });
    });
    expect(events.text).toContain('hello');
    expect(events.result.text).toBe('hello');
    expect(events.result.claudeSessionId).toBe('csess-1');
  });

  it('emits tool_use events from content_block_start', async () => {
    const events = { tool: [], result: null };
    await new Promise((resolve) => {
      startClaudeRun({
        agent: { id: 'x', model: 'sonnet' },
        message: 'read',
        callbacks: {
          onToolUse: (t) => events.tool.push(t),
          onResult: (r) => {
            events.result = r;
            resolve();
          },
          onError: resolve
        },
        spawn: mockSpawn([
          JSON.stringify({
            type: 'content_block_start',
            content_block: { type: 'tool_use', name: 'Read', input: { file_path: '/a.txt' } }
          }),
          JSON.stringify({ type: 'result', result: 'done', session_id: 'c-2' })
        ])
      });
    });
    expect(events.tool.length).toBe(1);
    expect(events.tool[0].name).toBe('Read');
    expect(events.tool[0].input.file_path).toBe('/a.txt');
  });

  it('onError on non-zero exit with no result', async () => {
    const events = { error: null, result: null };
    await new Promise((resolve) => {
      startClaudeRun({
        agent: { id: 'x' },
        message: 'x',
        callbacks: {
          onResult: (r) => {
            events.result = r;
            resolve();
          },
          onError: (e) => {
            events.error = e;
            resolve();
          }
        },
        spawn: mockSpawn([], ['boom'], 1)
      });
    });
    expect(events.error).toBeTruthy();
    expect(events.error.message).toMatch(/boom|exit 1/);
  });
});
