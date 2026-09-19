import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBackendsStore } from '../server/lib/backends-store.js';
import { createBackendsRouter } from '../server/routes/backends.js';
import { resolveFallbackBackend } from '../server/routes/chat/utils.js';
import { errorHandler } from '../server/middleware/error-handler.js';

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

/** In-memory stand-in for config-store, enough for /apply-to-agents. */
function fakeConfigStore(agents) {
  return {
    getAgents: () => agents,
    getAgent: (id) => agents[id] ?? null,
    async updateAgent(id, patch) {
      agents[id] = { ...(agents[id] ?? {}), ...patch };
      return agents[id];
    }
  };
}

describe('global fallback backend', () => {
  let app;
  let store;
  let file;

  beforeEach(async () => {
    file = tmpPath('backends-fallback');
    store = await createBackendsStore(file);
    await store.createBackend('zai', {
      type: 'openai-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai', envKey: 'ZAI_API_KEY', models: {}
    });
    app = express();
    app.use(express.json());
    app.use('/api/backends', createBackendsRouter({ backendsStore: store, webConfig: {} }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await store.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('defaults to no fallback and exposes the field on GET /', async () => {
    const res = await request(app).get('/api/backends');
    expect(res.status).toBe(200);
    expect(res.body.fallbackBackend).toBe(null);
  });

  it('POST /fallback sets and clears the global fallback', async () => {
    const set = await request(app).post('/api/backends/fallback').send({ backendId: 'zai' });
    expect(set.status).toBe(200);
    expect(set.body.fallbackBackend).toBe('zai');
    expect((await request(app).get('/api/backends')).body.fallbackBackend).toBe('zai');

    const cleared = await request(app).post('/api/backends/fallback').send({ backendId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.fallbackBackend).toBe(null);
  });

  it('POST /fallback rejects an unregistered backend', async () => {
    const res = await request(app).post('/api/backends/fallback').send({ backendId: 'nope' });
    expect(res.status).toBe(404);
    expect(store.getRaw().fallbackBackend ?? null).toBe(null);
  });

  it('deleting a backend clears every fallback pointer aimed at it', async () => {
    await request(app).post('/api/backends/fallback').send({ backendId: 'zai' });
    await store.updateBackend('claude', { fallback: 'zai' });

    await store.deleteBackend('zai');

    expect(store.getRaw().fallbackBackend).toBe(null);
    expect(store.getRaw().backends.claude.fallback).toBe(null);
  });
});

describe('resolveFallbackBackend', () => {
  let store;
  let file;

  beforeEach(async () => {
    file = tmpPath('backends-resolve');
    store = await createBackendsStore(file);
    await store.createBackend('zai', {
      type: 'openai-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai', envKey: 'ZAI_API_KEY', models: {}
    });
    await store.createBackend('omni', {
      type: 'anthropic-compatible', label: 'Omni', baseURL: 'http://localhost:20128',
      envKey: 'OMNIROUTE_TOKEN', models: { sonnet: 'oc/big-pickle' }
    });
  });

  afterEach(async () => {
    await store.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('returns null when nothing is configured', () => {
    expect(resolveFallbackBackend({ id: 'a' }, store, 'claude')).toBe(null);
  });

  it('uses the global fallback when the backend has none of its own', () => {
    const fb = resolveFallbackBackend({ id: 'a' }, store, 'zai');
    expect(fb).toBe(null);

    store.getRaw().fallbackBackend = 'claude';
    const fb2 = resolveFallbackBackend({ id: 'a' }, store, 'zai');
    expect(fb2.backendId).toBe('claude');
    expect(fb2.backendType).toBe('claude-cli');
    // claude-cli 폴백은 자기 configDir 로 spawn 돼야 한다.
    expect(fb2.configDir).toBeTruthy();
  });

  it('per-backend fallback wins over the global one', async () => {
    store.getRaw().fallbackBackend = 'claude';
    await store.updateBackend('zai', { fallback: 'omni' });
    const fb = resolveFallbackBackend({ id: 'a' }, store, 'zai');
    expect(fb.backendId).toBe('omni');
    expect(fb.backendType).toBe('anthropic-compatible');
    // anthropic-compatible 폴백은 Claude CLI 를 게이트웨이로 돌려세우는 env 를 들고 와야 한다.
    expect(fb.envOverrides.ANTHROPIC_BASE_URL).toBe('http://localhost:20128');
    expect(fb.envOverrides._resolvedBackendId).toBe('omni');
  });

  it('never falls back to itself', () => {
    store.getRaw().fallbackBackend = 'zai';
    expect(resolveFallbackBackend({ id: 'a' }, store, 'zai')).toBe(null);
  });

  it('returns null for a dangling fallback id', async () => {
    await store.updateBackend('zai', { fallback: 'ghost' });
    expect(resolveFallbackBackend({ id: 'a' }, store, 'zai')).toBe(null);
  });

  // 폴백 대상의 건강 상태 — 쿨다운/재로그인/비활성 백엔드로 넘기면 1차의 진짜 에러
  // 대신 폴백 계정의 한도 문구가 사용자에게 뜬다.
  const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
  const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

  it('쿨다운 중인 폴백은 쓰지 않는다', async () => {
    await store.updateBackend('zai', { fallback: 'omni' });
    await store.updateBackend('omni', { status: 'cooldown', cooldownUntil: FUTURE() });
    expect(resolveFallbackBackend({ id: 'a' }, store, 'zai')).toBe(null);
  });

  it('쿨다운이 이미 만료됐으면 status 가 남아 있어도 쓴다', async () => {
    await store.updateBackend('zai', { fallback: 'omni' });
    await store.updateBackend('omni', { status: 'cooldown', cooldownUntil: PAST() });
    expect(resolveFallbackBackend({ id: 'a' }, store, 'zai').backendId).toBe('omni');
  });

  it('needs-relogin / disabled 폴백도 쓰지 않는다', async () => {
    await store.updateBackend('zai', { fallback: 'omni' });
    await store.updateBackend('omni', { status: 'needs-relogin' });
    expect(resolveFallbackBackend({ id: 'a' }, store, 'zai')).toBe(null);
    await store.updateBackend('omni', { status: 'disabled', cooldownUntil: null });
    expect(resolveFallbackBackend({ id: 'a' }, store, 'zai')).toBe(null);
  });
});

describe('POST /apply-to-agents', () => {
  let app;
  let store;
  let file;
  let agents;

  beforeEach(async () => {
    file = tmpPath('backends-apply');
    store = await createBackendsStore(file);
    await store.createBackend('zai', {
      type: 'openai-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai', envKey: 'ZAI_API_KEY', models: {}
    });
    agents = {
      alpha: { name: 'Alpha', backendId: 'claude' },
      beta: { name: 'Beta' },
      gamma: { name: 'Gamma', accountId: 'claude' }
    };
    const metadataStore = {
      getAgent: (id) => ({ alpha: { projectId: 'p1' }, beta: { projectId: 'p2' }, gamma: { projectId: 'p1' } }[id] ?? {})
    };
    app = express();
    app.use(express.json());
    app.use('/api/backends', createBackendsRouter({
      backendsStore: store, webConfig: {}, configStore: fakeConfigStore(agents), metadataStore
    }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await store.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('switches every agent and reports the previous mapping', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ backendId: 'zai' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.changed.sort()).toEqual(['alpha', 'beta', 'gamma']);
    // updated 는 클라이언트 토스트가 읽는 필드 — changed 개수와 어긋나면 'undefined개' 가 찍힌다
    expect(res.body.updated).toBe(3);
    // gamma 의 실효값은 deprecated accountId 였다 — previous 는 그걸 담아야 되돌릴 수 있다.
    expect(res.body.previous).toEqual({ alpha: 'claude', beta: null, gamma: 'claude' });
    expect(agents.alpha.backendId).toBe('zai');
    expect(agents.gamma.backendId).toBe('zai');
    expect(agents.gamma.accountId).toBe(null);
  });

  it('restore puts the previous mapping back', async () => {
    const applied = await request(app).post('/api/backends/apply-to-agents').send({ backendId: 'zai' });
    const res = await request(app)
      .post('/api/backends/apply-to-agents')
      .send({ backendId: null, restore: applied.body.previous });
    expect(res.status).toBe(200);
    expect(agents.alpha.backendId).toBe('claude');
    expect(agents.beta.backendId).toBe(null);
    expect(agents.gamma.backendId).toBe('claude');
  });

  it('backendId null clears the agent override (inherit global active)', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ backendId: null });
    expect(res.status).toBe(200);
    expect(agents.alpha.backendId).toBe(null);
  });

  it('projectId narrows the scope', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ backendId: 'zai', projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('p1');
    expect(res.body.changed.sort()).toEqual(['alpha', 'gamma']);
    expect(agents.beta.backendId).toBeUndefined();
  });

  it('rejects an unregistered backend', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ backendId: 'ghost' });
    expect(res.status).toBe(404);
    expect(agents.alpha.backendId).toBe('claude');
  });
});

describe('runner fallback routing', () => {
  let createRunner;
  let startClaudeRun;
  let runOpenAIAgent;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../server/runners/claude-cli-runner.js', () => ({
      startClaudeRun: vi.fn(() => ({ process: null, abort() {} }))
    }));
    vi.doMock('../server/runners/openai-runner.js', () => ({
      runAgent: vi.fn(() => Promise.reject(new Error('boom')))
    }));
    ({ createRunner } = await import('../server/lib/runner.js'));
    ({ startClaudeRun } = await import('../server/runners/claude-cli-runner.js'));
    ({ runAgent: runOpenAIAgent } = await import('../server/runners/openai-runner.js'));
  });

  afterEach(() => {
    vi.doUnmock('../server/runners/claude-cli-runner.js');
    vi.doUnmock('../server/runners/openai-runner.js');
  });

  const agent = { id: 'a', workingDir: '/tmp', model: 'sonnet' };

  it('a failing claude-cli run retries once on the fallback backend', () => {
    const runner = createRunner();
    const onError = vi.fn();
    const onExit = vi.fn();

    runner.start({
      sessionId: 's1',
      agent,
      message: 'hi',
      backendType: 'claude-cli',
      backendConfig: {
        backendName: 'claude',
        fallback: {
          backendId: 'sub', backendType: 'claude-cli',
          envOverrides: { _resolvedBackendId: 'sub' }, configDir: '/tmp/sub-config'
        }
      },
      callbacks: { onError, onExit }
    });

    // 1차 실행이 결과 없이 죽는다 (기동실패/레이트리밋 kill 후 빈 출력 경로).
    const primary = startClaudeRun.mock.calls[0][0];
    primary.callbacks.onError(new Error('claude CLI exited 143'));
    primary.callbacks.onExit({ code: 143 });

    expect(startClaudeRun).toHaveBeenCalledTimes(2);
    const fb = startClaudeRun.mock.calls[1][0];
    expect(fb.agent.backendId).toBe('sub');
    expect(fb.agent.configDir).toBe('/tmp/sub-config');
    expect(fb.envOverrides._resolvedBackendId).toBe('sub');
    // 1차 실행의 에러/종료는 삼켜야 한다 — 흘리면 호출자가 턴을 닫아 폴백 응답이 버려진다.
    expect(onError).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('the fallback run does not fall back again (1 hop)', () => {
    const runner = createRunner();
    const onError = vi.fn();

    runner.start({
      sessionId: 's2',
      agent,
      message: 'hi',
      backendType: 'claude-cli',
      backendConfig: {
        backendName: 'claude',
        fallback: { backendId: 'sub', backendType: 'claude-cli', envOverrides: {}, configDir: null }
      },
      callbacks: { onError }
    });

    startClaudeRun.mock.calls[0][0].callbacks.onError(new Error('fail 1'));
    const fb = startClaudeRun.mock.calls[1][0];
    expect(fb.backendConfig ?? null).toBe(null); // startClaudeRun 은 backendConfig 를 받지 않음

    fb.callbacks.onError(new Error('fail 2'));
    expect(startClaudeRun).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('fail 2');
  });

  it('a successful run never triggers the fallback', () => {
    const runner = createRunner();
    const onResult = vi.fn();
    const onExit = vi.fn();

    runner.start({
      sessionId: 's3',
      agent,
      message: 'hi',
      backendType: 'claude-cli',
      backendConfig: {
        backendName: 'claude',
        fallback: { backendId: 'sub', backendType: 'claude-cli', envOverrides: {}, configDir: null }
      },
      callbacks: { onResult, onExit }
    });

    const primary = startClaudeRun.mock.calls[0][0];
    primary.callbacks.onResult({ text: 'done' });
    primary.callbacks.onExit({ code: 0 });

    expect(startClaudeRun).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('an openai-compatible failure routes to the fallback backend type, not hardcoded Claude', async () => {
    const runner = createRunner();
    runner.start({
      sessionId: 's4',
      agent,
      message: 'hi',
      backendType: 'openai-compatible',
      backendConfig: {
        backendName: 'zai',
        fallback: {
          backendId: 'omni', backendType: 'anthropic-compatible',
          envOverrides: { ANTHROPIC_BASE_URL: 'http://localhost:20128' }, configDir: null
        }
      },
      callbacks: {}
    });

    await vi.waitFor(() => expect(startClaudeRun).toHaveBeenCalledTimes(1));
    expect(runOpenAIAgent).toHaveBeenCalledTimes(1);
    const fb = startClaudeRun.mock.calls[0][0];
    expect(fb.agent.backendId).toBe('omni');
    expect(fb.envOverrides.ANTHROPIC_BASE_URL).toBe('http://localhost:20128');
  });

  it('no fallback configured — the error reaches the caller', () => {
    const runner = createRunner();
    const onError = vi.fn();
    runner.start({
      sessionId: 's5', agent, message: 'hi',
      backendType: 'claude-cli',
      backendConfig: { backendName: 'claude', fallback: null },
      callbacks: { onError }
    });
    startClaudeRun.mock.calls[0][0].callbacks.onError(new Error('nope'));
    expect(startClaudeRun).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
  });
});

// 한도에 걸린 백엔드가 쿨다운이 끝난 뒤 자동 선택 후보로 돌아오는지.
// setCooldown 은 status 를 'cooldown' 으로 바꾸는데 되돌리는 주체가 없어서,
// status 로 거르면 한 번 한도에 걸린 계정이 영영 로테이션에서 빠졌다.
describe('cooldown recovery', () => {
  let file;
  let store;

  beforeEach(async () => {
    file = tmpPath('backends-cooldown');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      activeBackend: 'a',
      backends: {
        a: { type: 'claude-cli', label: 'A', models: {} },
        b: { type: 'claude-cli', label: 'B', models: {} }
      }
    }));
    store = await createBackendsStore(file);
  });

  afterEach(async () => {
    await store.close?.();
    fs.rmSync(file, { force: true });
  });

  it('쿨다운 중인 백엔드는 자동 선택에서 빠진다', async () => {
    await store.setCooldown('a', new Date(Date.now() + 60_000).toISOString());
    expect(store.pickClaudeCliBackend()?.id).toBe('b');
  });

  it('쿨다운이 만료되면 status 가 cooldown 이어도 다시 후보가 된다', async () => {
    await store.setCooldown('a', new Date(Date.now() - 60_000).toISOString());
    await store.setCooldown('b', new Date(Date.now() + 60_000).toISOString());
    const picked = store.pickClaudeCliBackend();
    expect(picked?.id).toBe('a');
    expect(picked?.status).toBe('cooldown'); // 상태는 아직 안 돌아왔지만 시각 기준으로 선택됨
  });

  it('disabled 는 쿨다운과 무관하게 계속 제외된다', async () => {
    await store.updateBackend('b', { status: 'disabled' });
    await store.setCooldown('a', new Date(Date.now() + 60_000).toISOString());
    expect(store.pickClaudeCliBackend()).toBeNull();
  });
});
