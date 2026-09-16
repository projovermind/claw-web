import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startClaudeRun } from '../server/runners/claude-cli-runner.js';
import { createAccountScheduler } from '../server/lib/account-scheduler.js';
import { classifyError, resolveAgent } from '../server/routes/chat/utils.js';

const LIMIT_TEXT = 'Claude AI usage limit reached, try again in 5 hours';

/** stdout 라인들을 흘리고 종료하는 가짜 claude CLI. */
function mockSpawn(stdoutLines, exitCode = 0) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      for (const line of stdoutLines) proc.stdout.emit('data', line + '\n');
      proc.emit('close', exitCode);
    });
    return proc;
  };
}

function runOnce(stdoutLines, exitCode = 0) {
  return new Promise((resolve) => {
    const seen = { result: null, error: null };
    startClaudeRun({
      agent: { id: 'x', model: 'sonnet', workingDir: '/tmp' },
      message: 'hi',
      callbacks: {
        onResult: (r) => { seen.result = r; },
        onError: (e) => { seen.error = e; },
        onExit: () => resolve(seen)
      },
      spawn: mockSpawn(stdoutLines, exitCode)
    });
  });
}

describe('rate limit → onError (폴백 트리거)', () => {
  it('한도 메시지뿐인 is_error result 는 onResult 가 아니라 onError 로 나간다', async () => {
    const seen = await runOnce([
      JSON.stringify({ type: 'result', is_error: true, result: LIMIT_TEXT, session_id: 'c-1' })
    ]);
    expect(seen.result).toBe(null);
    expect(seen.error).toBeInstanceOf(Error);
    expect(seen.error.message).toContain('rate_limit:');
    expect(seen.error.message).toContain('usage limit reached');
  });

  it('부분 응답이 있으면 기존대로 onResult 로 보존한다', async () => {
    const seen = await runOnce([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '작업 절반 완료' }] } }),
      JSON.stringify({ type: 'result', is_error: true, result: LIMIT_TEXT, session_id: 'c-2' })
    ]);
    expect(seen.error).toBe(null);
    expect(seen.result.text).toBe(LIMIT_TEXT);
  });

  it('한도가 아닌 정상 result 는 영향 없다', async () => {
    const seen = await runOnce([
      JSON.stringify({ type: 'result', result: 'done', session_id: 'c-3' })
    ]);
    expect(seen.error).toBe(null);
    expect(seen.result.text).toBe('done');
  });

  it('classifyError 가 rate_limit 프리픽스를 한도로 분류한다', () => {
    const c = classifyError(`rate_limit: ${LIMIT_TEXT}`);
    expect(c.label).toBe('rate_limit');
    expect(c.canRetry).toBe(true);
  });
});

/** getBackend/getRaw/pickClaudeCliBackend 만 흉내내는 최소 backendsStore. */
function fakeBackendsStore(backends, { fallbackBackend = null, lru = null } = {}) {
  return {
    getBackend: (id) => backends[id] ?? null,
    getRaw: () => ({ fallbackBackend, backends }),
    pickClaudeCliBackend: () => (lru ? { ...backends[lru], id: lru } : null),
  };
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

describe('pickBackend — 쿨다운이면 폴백으로 선회', () => {
  const scheduler = (store) => createAccountScheduler({ accountsStore: { getAll: () => [] }, backendsStore: store });

  it('쿨다운 아니면 지정 백엔드를 그대로 쓴다', () => {
    const store = fakeBackendsStore({ main: { type: 'claude-cli', status: 'active' } });
    expect(scheduler(store).pickBackend({ id: 'a', backendId: 'main' }).id).toBe('main');
  });

  it('만료된 쿨다운은 쿨다운으로 치지 않는다', () => {
    const store = fakeBackendsStore({ main: { type: 'claude-cli', status: 'cooldown', cooldownUntil: PAST } });
    expect(scheduler(store).pickBackend({ id: 'a', backendId: 'main' }).id).toBe('main');
  });

  it('쿨다운 중이면 그 백엔드의 fallback 으로 간다', () => {
    const store = fakeBackendsStore({
      main: { type: 'claude-cli', status: 'cooldown', cooldownUntil: FUTURE, fallback: 'sub' },
      sub: { type: 'claude-cli', status: 'active' },
    });
    expect(scheduler(store).pickBackend({ id: 'a', backendId: 'main' }).id).toBe('sub');
  });

  it('백엔드별 fallback 이 없으면 전역 fallbackBackend 를 쓴다', () => {
    const store = fakeBackendsStore({
      main: { type: 'claude-cli', status: 'cooldown', cooldownUntil: FUTURE },
      global: { type: 'claude-cli', status: 'active' },
    }, { fallbackBackend: 'global' });
    expect(scheduler(store).pickBackend({ id: 'a', backendId: 'main' }).id).toBe('global');
  });

  it('폴백도 쿨다운이면 pickClaudeCliBackend 로 내려간다', () => {
    const store = fakeBackendsStore({
      main: { type: 'claude-cli', status: 'cooldown', cooldownUntil: FUTURE, fallback: 'sub' },
      sub: { type: 'claude-cli', status: 'cooldown', cooldownUntil: FUTURE },
      lru: { type: 'claude-cli', status: 'active' },
    }, { lru: 'lru' });
    expect(scheduler(store).pickBackend({ id: 'a', backendId: 'main' }).id).toBe('lru');
  });

  it('자기 자신을 가리키는 폴백은 무시한다', () => {
    const store = fakeBackendsStore({
      main: { type: 'claude-cli', status: 'cooldown', cooldownUntil: FUTURE, fallback: 'main' },
      lru: { type: 'claude-cli', status: 'active' },
    }, { lru: 'lru' });
    expect(scheduler(store).pickBackend({ id: 'a', backendId: 'main' }).id).toBe('lru');
  });

  it('프로젝트 지정 백엔드도 쿨다운이면 폴백으로 선회한다', () => {
    const store = fakeBackendsStore({
      proj: { type: 'claude-cli', status: 'cooldown', cooldownUntil: FUTURE, fallback: 'sub' },
      sub: { type: 'claude-cli', status: 'active' },
    });
    expect(scheduler(store).pickBackend({ id: 'a' }, { backendId: 'proj' }).id).toBe('sub');
  });
});

describe('modelAlias 보존 + 폴백 재해석', () => {
  function utilsStore(backends, fallbackBackend = null) {
    return {
      getRaw: () => ({ activeBackend: 'claude', fallbackBackend, backends }),
      getBackend: (id) => backends[id] ?? null,
    };
  }

  it('resolveAgent 가 해석 전 별칭을 agent.modelAlias 로 남긴다', () => {
    const store = utilsStore({
      claude: { type: 'claude-cli', label: 'C', models: { 'opus sub': 'claude-opus-4-5' } },
    });
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ model: 'opus sub', backendId: 'claude' }) },
      backendsStore: store,
    });
    expect(agent.model).toBe('claude-opus-4-5');
    expect(agent.modelAlias).toBe('opus sub');
  });

  it('원래부터 raw 모델 ID 면 modelAlias 를 만들지 않는다', () => {
    const store = utilsStore({ claude: { type: 'claude-cli', label: 'C', models: {} } });
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ model: 'claude-sonnet-4-6', backendId: 'claude' }) },
      backendsStore: store,
    });
    expect(agent.modelAlias).toBeUndefined();
  });
});

describe('_startFallback — 폴백 백엔드 기준으로 모델 재해석', () => {
  let createRunner;
  let startClaudeRun2;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../server/runners/claude-cli-runner.js', () => ({
      startClaudeRun: vi.fn(() => ({ process: null, abort() {} }))
    }));
    ({ createRunner } = await import('../server/lib/runner.js'));
    ({ startClaudeRun: startClaudeRun2 } = await import('../server/runners/claude-cli-runner.js'));
  });

  afterEach(() => {
    vi.doUnmock('../server/runners/claude-cli-runner.js');
  });

  function fallbackWith(models) {
    return {
      backendId: 'sub',
      backendType: 'claude-cli',
      configDir: null,
      envOverrides: {
        _resolvedBackendId: 'sub',
        _backendsStore: { getBackend: (id) => (id === 'sub' ? { type: 'claude-cli', models } : null) },
      },
    };
  }

  function runFallback(agent, fallback) {
    const runner = createRunner();
    runner.start({
      sessionId: 's1', agent, message: 'hi',
      backendType: 'claude-cli',
      backendConfig: { backendName: 'main', fallback },
      callbacks: {}
    });
    startClaudeRun2.mock.calls[0][0].callbacks.onError(new Error(`rate_limit: ${LIMIT_TEXT}`));
    return startClaudeRun2.mock.calls[1][0];
  }

  it('폴백 백엔드의 models 맵으로 별칭을 다시 푼다', () => {
    const fb = runFallback(
      { id: 'a', workingDir: '/tmp', model: 'claude-opus-4-5', modelAlias: 'opus sub' },
      fallbackWith({ 'opus sub': 'oc/big-pickle' })
    );
    expect(fb.agent.model).toBe('oc/big-pickle');
  });

  it('폴백이 그 별칭을 모르면 별칭 원본을 넘겨 러너가 풀게 한다', () => {
    const fb = runFallback(
      { id: 'a', workingDir: '/tmp', model: 'glm-4.6', modelAlias: 'sonnet' },
      fallbackWith({})
    );
    expect(fb.agent.model).toBe('sonnet');
  });

  it('modelAlias 가 없으면 모델을 건드리지 않는다', () => {
    const fb = runFallback(
      { id: 'a', workingDir: '/tmp', model: 'claude-sonnet-4-6' },
      fallbackWith({ sonnet: 'oc/big-pickle' })
    );
    expect(fb.agent.model).toBe('claude-sonnet-4-6');
  });
});
