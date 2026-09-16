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

// kill 이 호출되면 실제 자식처럼 close(null, signal) 로 끝나는 mock.
// stdout 라인은 emit 하되 스스로 close 하지 않아, kill 경로(유저 중단/타임아웃/exit-grace)를 재현한다.
function killableSpawn(stdoutLines = []) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = (sig = 'SIGTERM') => {
      if (proc.killed) return;
      proc.killed = true;
      setImmediate(() => proc.emit('close', null, sig));
    };
    setImmediate(() => {
      for (const line of stdoutLines) proc.stdout.emit('data', line + '\n');
    });
    return proc;
  };
}

describe('claude-cli-runner kill 경로', () => {
  it('유저 중단이 아닌 kill + 빈 응답이면 onResult 가 아니라 onError 로 간다', async () => {
    const events = { error: null, result: null };
    await new Promise((resolve) => {
      const handle = startClaudeRun({
        agent: { id: 'x' },
        message: 'x',
        callbacks: {
          onResult: (r) => { events.result = r; resolve(); },
          onError: (e) => { events.error = e; resolve(); }
        },
        spawn: killableSpawn()
      });
      // abort() 를 거치지 않은 외부 kill (스톨 타임아웃/OOM 등)
      setImmediate(() => handle.process.kill('SIGTERM'));
    });
    expect(events.result).toBeNull();
    expect(events.error).toBeTruthy();
    // classifyError 의 cli_exit 재시도 경로에 걸리는 형태여야 한다
    expect(events.error.message).toMatch(/^claude CLI exited 143/);
  });

  it('유저가 abort 하면 기존대로 중단 메시지를 onResult 로 낸다', async () => {
    const events = { error: null, result: null };
    await new Promise((resolve) => {
      const handle = startClaudeRun({
        agent: { id: 'x' },
        message: 'x',
        callbacks: {
          onResult: (r) => { events.result = r; resolve(); },
          onError: (e) => { events.error = e; resolve(); }
        },
        spawn: killableSpawn()
      });
      setImmediate(() => handle.abort());
    });
    expect(events.error).toBeNull();
    expect(events.result.text).toBe('(응답이 중단되었습니다)');
    expect(events.result.exitCode).toBe(143);
  });

  it('result 수신 후 exit-grace 강제종료는 exitCode 143 이 아니라 0 으로 보고한다', async () => {
    const events = { error: null, result: null };
    await new Promise((resolve) => {
      startClaudeRun({
        agent: { id: 'x' },
        message: 'x',
        callbacks: {
          onResult: (r) => { events.result = r; resolve(); },
          onError: (e) => { events.error = e; resolve(); }
        },
        spawn: killableSpawn([
          JSON.stringify({ type: 'result', result: 'ok', subtype: 'success', session_id: 'c-3' })
        ])
      });
    });
    expect(events.error).toBeNull();
    expect(events.result.text).toBe('ok');
    // message-sender 의 wasKilled(143/137) 판정에 걸리면 안 된다
    expect(events.result.exitCode).toBe(0);
  }, 10_000);
});
