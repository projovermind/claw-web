import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('폴백 차단 — 불건전한 폴백 대상 / 빈 출력', () => {
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

  /** 폴백 대상의 현재 상태를 backendsStore 가 돌려주는 상황. */
  function fallbackTo(backend) {
    return {
      backendId: 'sub',
      backendType: 'claude-cli',
      configDir: null,
      envOverrides: {
        _resolvedBackendId: 'sub',
        _backendsStore: { getBackend: (id) => (id === 'sub' ? backend : null) },
      },
    };
  }

  /** 1차 실행이 errMsg 로 실패했을 때 폴백이 떴는지 / 에러가 그대로 나갔는지. */
  function runAndFail(fallback, errMsg) {
    const runner = createRunner();
    const seen = { error: null, exit: null };
    runner.start({
      sessionId: 's1',
      agent: { id: 'a', workingDir: '/tmp', model: 'claude-sonnet-4-6' },
      message: 'hi',
      backendType: 'claude-cli',
      backendConfig: { backendName: 'main', fallback },
      callbacks: { onError: (e) => { seen.error = e; }, onExit: (i) => { seen.exit = i; } },
    });
    startClaudeRun2.mock.calls[0][0].callbacks.onError(new Error(errMsg));
    return { seen, spawns: startClaudeRun2.mock.calls.length };
  }

  const HEALTHY = { type: 'claude-cli', status: 'active' };
  const RATE_LIMITED = `rate_limit: ${LIMIT_TEXT}`;
  const EMPTY_OUTPUT = 'claude CLI exited 143 (no result text, subtype=success, is_error=false)';

  it('쿨다운 중인 폴백으로는 넘기지 않고 1차 에러를 그대로 보고한다', () => {
    const { seen, spawns } = runAndFail(
      fallbackTo({ ...HEALTHY, status: 'cooldown', cooldownUntil: FUTURE }), RATE_LIMITED
    );
    expect(spawns).toBe(1);
    expect(seen.error.message).toBe(RATE_LIMITED);
    expect(seen.exit).toEqual({ code: 1 });
  });

  it('needs-relogin 폴백도 막는다', () => {
    const { seen, spawns } = runAndFail(
      fallbackTo({ ...HEALTHY, status: 'needs-relogin' }), RATE_LIMITED
    );
    expect(spawns).toBe(1);
    expect(seen.error.message).toBe(RATE_LIMITED);
  });

  it('쿨다운이 만료됐으면 폴백은 그대로 동작한다', () => {
    const { spawns } = runAndFail(
      fallbackTo({ ...HEALTHY, status: 'cooldown', cooldownUntil: PAST }), RATE_LIMITED
    );
    expect(spawns).toBe(2);
  });

  it('건강한 폴백 + 한도 에러는 기존대로 폴백한다 (회귀 방지)', () => {
    const { seen, spawns } = runAndFail(fallbackTo(HEALTHY), RATE_LIMITED);
    expect(spawns).toBe(2);
    expect(seen.error).toBe(null);
  });

  it('빈 출력(exit 143)은 건강한 폴백이 있어도 계정을 바꾸지 않는다', () => {
    const { seen, spawns } = runAndFail(fallbackTo(HEALTHY), EMPTY_OUTPUT);
    expect(spawns).toBe(1);
    expect(seen.error.message).toBe(EMPTY_OUTPUT);
    // 폴백 대신 message-sender 의 cli_exit 경로(같은 백엔드로 1회 재시도)가 받는다.
    expect(classifyError(seen.error.message).label).toBe('cli_exit');
  });

  it('빈 출력이어도 onExit 은 러너가 삼키지 않는다 (1차 close 가 그대로 마감)', () => {
    const { seen } = runAndFail(fallbackTo(HEALTHY), EMPTY_OUTPUT);
    startClaudeRun2.mock.calls[0][0].callbacks.onExit({ code: 143 });
    expect(seen.exit).toEqual({ code: 143 });
  });
});

/**
 * index.js 는 createAccountScheduler 에 backendsStore 를 넘기지 않는다(계정 래퍼만 넘긴다).
 * 넘기면 계정 선택 결과가 바뀐다 — 그 차이를 고정해 둔다. 주입 여부를 바꾸려는 사람이
 * 무엇이 달라지는지 이 테스트로 먼저 보게 하기 위한 것이다.
 */
describe('backendsStore 주입 여부 — pickAccount 결과가 갈린다', () => {
  let dir;
  let accounts;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    accounts = ['claude', 'acc_sub'].map((id) => {
      const configDir = path.join(dir, id);
      fs.mkdirSync(configDir);
      fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
      // acc_sub 가 더 오래 안 쓰여서 LRU 로는 acc_sub 가 먼저다.
      return {
        id, configDir, status: 'active', type: 'claude-cli',
        lastUsedAt: id === 'claude' ? '2026-09-20T00:00:00Z' : '2026-09-19T00:00:00Z',
      };
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const accountsStore = () => ({
    getAll: () => accounts,
    getById: (id) => accounts.find((a) => a.id === id) ?? null,
    update: async () => {},
  });
  const storeWithActive = (activeBackend) => ({
    getBackend: (id) => accounts.find((a) => a.id === id) ?? null,
    getRaw: () => ({ activeBackend, backends: Object.fromEntries(accounts.map((a) => [a.id, a])) }),
    updateBackend: async () => {},
    getOAuthToken: () => null,
  });

  it('미주입(현재 index.js): LRU 라운드로빈이 서브 계정을 고른다', () => {
    const scheduler = createAccountScheduler({ accountsStore: accountsStore() });
    expect(scheduler.pickAccount({ id: 'agent1' }).id).toBe('acc_sub');
  });

  it('주입: 전역 activeBackend 가 LRU 를 이겨 메인 계정으로 고정된다', () => {
    const scheduler = createAccountScheduler({
      accountsStore: accountsStore(), backendsStore: storeWithActive('claude'),
    });
    expect(scheduler.pickAccount({ id: 'agent1' }).id).toBe('claude');
  });

  it('주입 + 전역 active 가 쿨다운이면 라운드로빈으로 되돌아간다 (장애 시 승계는 유지)', () => {
    accounts[0].cooldownUntil = new Date(Date.now() + 3_600_000).toISOString();
    const scheduler = createAccountScheduler({
      accountsStore: accountsStore(), backendsStore: storeWithActive('claude'),
    });
    expect(scheduler.pickAccount({ id: 'agent1' }).id).toBe('acc_sub');
  });
});
