import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBackendsStore } from '../server/lib/backends-store.js';
import { createBackendsRouter } from '../server/routes/backends.js';
import { resolveAgent } from '../server/routes/chat/utils.js';
import { resolveTierModel, normalizeTiers, migrateBackendTierModels, tierModelsFromModels } from '../server/lib/model-tiers.js';
import { errorHandler } from '../server/middleware/error-handler.js';

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

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

/** utils.resolveAgent 가 필요로 하는 최소한의 backendsStore. */
function utilsStore(backends, extra = {}) {
  return {
    getRaw: () => ({ activeBackend: 'claude', fallbackBackend: null, backends, ...extra }),
    getBackend: (id) => backends[id] ?? null,
  };
}

describe('resolveTierModel', () => {
  const backend = {
    type: 'claude-cli',
    models: { default: 'claude-opus-5', opus: 'claude-opus-5' },
    tierModels: { high: 'claude-opus-5', middle: 'claude-sonnet-5', low: 'claude-haiku-4-6' }
  };

  it('티어를 그 백엔드의 모델 ID 로 푼다', () => {
    const hit = resolveTierModel({ backendObj: backend, tier: 'middle' });
    expect(hit).toMatchObject({ modelId: 'claude-sonnet-5', tier: 'middle', demoted: false });
  });

  it('없는 티어는 인접 하위 티어로 강등한다', () => {
    const partial = { ...backend, tierModels: { low: 'glm-5.3-flash' } };
    const hit = resolveTierModel({ backendObj: partial, tier: 'high' });
    expect(hit).toMatchObject({ modelId: 'glm-5.3-flash', tier: 'low', requestedTier: 'high', demoted: true });
  });

  it('강등할 하위 티어도 없으면 models.default 로 떨어진다', () => {
    const only = { models: { default: 'claude-opus-5' }, tierModels: { high: 'claude-opus-5' } };
    const hit = resolveTierModel({ backendObj: only, tier: 'low' });
    expect(hit).toMatchObject({ modelId: 'claude-opus-5', tier: null, fromDefault: true });
  });

  it('티어도 아니고 default 도 없으면 null — 기존 별칭 경로로 넘긴다', () => {
    expect(resolveTierModel({ backendObj: { models: {} }, tier: 'low' })).toBe(null);
    expect(resolveTierModel({ backendObj: backend, tier: 'opus' })).toBe(null);
    expect(resolveTierModel({ backendObj: backend, tier: '' })).toBe(null);
    expect(resolveTierModel({ backendObj: null, tier: 'high' })).toBe(null);
  });

  it('커스텀 티어 order 를 따라 강등한다', () => {
    const tiers = { order: ['s', 'a', 'b'], labels: {} };
    const b = { tierModels: { b: 'glm-5.3-flash' }, models: {} };
    expect(resolveTierModel({ backendObj: b, tier: 's', tiers })).toMatchObject({ modelId: 'glm-5.3-flash', tier: 'b', demoted: true });
    // order 에 없어도 tierModels 에 직접 있으면 푼다 (티어를 지웠다 되살리는 중)
    expect(resolveTierModel({ backendObj: b, tier: 'b', tiers: { order: ['s'] } })).toMatchObject({ modelId: 'glm-5.3-flash' });
  });
});

describe('normalizeTiers / migrateBackendTierModels', () => {
  it('빈 값이면 기본 3단계', () => {
    expect(normalizeTiers(undefined).order).toEqual(['high', 'middle', 'low']);
    expect(normalizeTiers({ order: [] }).order).toEqual(['high', 'middle', 'low']);
    expect(normalizeTiers({ order: ['s', 'a'], labels: { s: '최상' } })).toEqual({
      order: ['s', 'a'], labels: { s: '최상', a: 'a' }, backends: {}
    });
  });

  it('models 의 opus/sonnet/haiku 를 티어로 복사한다', () => {
    expect(migrateBackendTierModels({ models: { opus: 'o', sonnet: 's', haiku: 'h', default: 'o' } }))
      .toEqual({ high: 'o', middle: 's', low: 'h' });
  });

  it('멱등 — 이미 채워져 있으면 변경 없음(null)', () => {
    const b = { models: { opus: 'o', sonnet: 's', haiku: 'h' }, tierModels: { high: 'x', middle: 's', low: 'h' } };
    expect(migrateBackendTierModels(b)).toBe(null);
    expect(migrateBackendTierModels({ models: {} })).toBe(null);
  });

  it('opus/sonnet/haiku 별칭이 하나도 없으면 쓸 수 있는 모델 하나를 전 티어에 건다', () => {
    // 게이트웨이 프리셋(omniroute) 모양 — 자체 모델명만 있고 별칭도 default 도 없다.
    const gateway = {
      auto: 'auto', 'big-pickle': 'oc/big-pickle', 'mimo-2.5': 'oc/mimo-v2.5-free'
    };
    expect(tierModelsFromModels(gateway)).toEqual({ high: 'auto', middle: 'auto', low: 'auto' });
    // default 가 있으면 그쪽이 우선
    expect(tierModelsFromModels({ auto: 'auto', default: 'glm-5.3' }))
      .toEqual({ high: 'glm-5.3', middle: 'glm-5.3', low: 'glm-5.3' });
    // default 도 auto 도 없으면 첫 엔트리
    expect(tierModelsFromModels({ 'big-pickle': 'oc/big-pickle' }))
      .toEqual({ high: 'oc/big-pickle', middle: 'oc/big-pickle', low: 'oc/big-pickle' });
  });

  it('별칭이 하나라도 있으면 단일 모델 폴백을 쓰지 않는다', () => {
    expect(tierModelsFromModels({ opus: 'o', auto: 'auto' })).toEqual({ high: 'o' });
  });

  it('models 가 비어 있으면 여전히 null', () => {
    expect(migrateBackendTierModels({ models: {} })).toBe(null);
    expect(migrateBackendTierModels({})).toBe(null);
    expect(migrateBackendTierModels({ models: { auto: '  ' } })).toBe(null);
  });

  it('별칭 없는 백엔드도 마이그레이션 후 모든 기본 티어가 풀린다', () => {
    const gateway = { type: 'anthropic-compatible', models: { auto: 'auto', 'big-pickle': 'oc/big-pickle' } };
    gateway.tierModels = migrateBackendTierModels(gateway);
    for (const tier of ['high', 'middle', 'low']) {
      expect(resolveTierModel({ backendObj: gateway, tier })).toMatchObject({ modelId: 'auto', tier });
    }
    // 티어가 아닌 평범한 별칭은 여전히 null — 호출자가 기존 별칭 경로를 타야 한다
    expect(resolveTierModel({ backendObj: gateway, tier: 'big-pickle' })).toBe(null);
  });

  it('사용자가 고친 티어는 덮어쓰지 않고 빠진 것만 채운다', () => {
    const b = { models: { opus: 'o', sonnet: 's', haiku: 'h' }, tierModels: { high: 'custom' } };
    expect(migrateBackendTierModels(b)).toEqual({ high: 'custom', middle: 's', low: 'h' });
  });
});

describe('backends store — 티어 마이그레이션', () => {
  let file;
  let store;

  afterEach(async () => {
    await store?.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('기존 파일을 열면 tiers 와 백엔드별 tierModels 가 채워진다', async () => {
    file = tmpPath('backends-tiers');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      activeBackend: 'claude',
      backends: {
        claude: { type: 'claude-cli', label: 'C', models: { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-6' } },
        gw: { type: 'anthropic-compatible', label: 'GW', models: { auto: 'auto' } }
      }
    }, null, 2));

    store = await createBackendsStore(file);
    const raw = store.getRaw();
    expect(raw.tiers.order).toEqual(['high', 'middle', 'low']);
    expect(raw.backends.claude.tierModels).toEqual({
      high: 'claude-opus-5', middle: 'claude-sonnet-5', low: 'claude-haiku-4-6'
    });
    // 별칭이 없는 게이트웨이 백엔드도 비어 있지 않게 채운다 — 안 그러면 티어를
    // 지정한 에이전트가 이 백엔드에 붙었을 때 티어 이름이 그대로 전선에 실린다.
    expect(raw.backends.gw.tierModels).toEqual({ high: 'auto', middle: 'auto', low: 'auto' });
    expect(store.getPublic().tiers.labels.high).toBeTruthy();
    expect(store.getPublic().backends.claude.tierModels.middle).toBe('claude-sonnet-5');
  });

  it('두 번째 로드는 파일을 다시 쓰지 않는다 (멱등)', async () => {
    file = tmpPath('backends-tiers-idem');
    fs.writeFileSync(file, JSON.stringify({
      version: 1, activeBackend: 'claude',
      backends: { claude: { type: 'claude-cli', label: 'C', models: { opus: 'o', sonnet: 's', haiku: 'h' } } }
    }, null, 2));

    const first = await createBackendsStore(file);
    await first.close();
    const mtime = fs.statSync(file).mtimeMs;

    store = await createBackendsStore(file);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(store.getRaw().backends.claude.tierModels).toEqual({ high: 'o', middle: 's', low: 'h' });
  });

  it('setTiers 로 이름변경/추가/삭제해도 tierModels 는 보존된다', async () => {
    file = tmpPath('backends-tiers-set');
    store = await createBackendsStore(file);
    await store.updateBackend('claude', { tierModels: { high: 'o', middle: 's', low: 'h' } });

    const next = await store.setTiers({ order: ['high', 'low'], labels: { high: '고성능', low: '경량' } });
    expect(next).toEqual({ order: ['high', 'low'], labels: { high: '고성능', low: '경량' }, backends: {} });
    expect(store.getRaw().backends.claude.tierModels.middle).toBe('s');
  });
});

describe('resolveAgent — modelTier 우선 해석', () => {
  const backends = {
    claude: {
      type: 'claude-cli', label: 'C',
      models: { default: 'claude-opus-5', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5' },
      tierModels: { high: 'claude-opus-5', middle: 'claude-sonnet-5', low: 'claude-haiku-4-6' }
    },
    zai: {
      type: 'anthropic-compatible', label: 'Z', baseURL: 'https://api.z.ai/api/anthropic',
      models: { default: 'glm-5.3' }, tierModels: { low: 'glm-5.3-flash' }
    }
  };

  it('modelTier 가 model 지정을 이긴다', () => {
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ model: 'opus', modelTier: 'low', backendId: 'claude' }) },
      backendsStore: utilsStore(backends),
    });
    expect(agent.model).toBe('claude-haiku-4-6');
  });

  it('해석 후에도 티어 이름을 modelAlias 로 보존한다', () => {
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ modelTier: 'middle', backendId: 'claude' }) },
      backendsStore: utilsStore(backends),
    });
    expect(agent.model).toBe('claude-sonnet-5');
    expect(agent.modelAlias).toBe('middle');
  });

  it('백엔드에 그 티어가 없으면 강등해도 요청한 티어를 modelAlias 로 남긴다', () => {
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ modelTier: 'high', backendId: 'zai' }) },
      backendsStore: utilsStore(backends),
    });
    expect(agent.model).toBe('glm-5.3-flash'); // high → (middle 없음) → low
    expect(agent.modelAlias).toBe('high');
  });

  it('modelTier 가 없으면 기존 별칭 해석이 그대로 동작한다', () => {
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ model: 'sonnet', backendId: 'claude' }) },
      backendsStore: utilsStore(backends),
    });
    expect(agent.model).toBe('claude-sonnet-5');
    expect(agent.modelAlias).toBe('sonnet');
  });

  it('커스텀 티어 order 를 쓴다', () => {
    const store = utilsStore(
      { claude: { type: 'claude-cli', models: {}, tierModels: { b: 'claude-haiku-4-6' } } },
      { tiers: { order: ['s', 'a', 'b'], labels: {} } }
    );
    const { agent } = resolveAgent('a', {
      configStore: { getAgent: () => ({ modelTier: 's', backendId: 'claude' }) },
      backendsStore: store,
    });
    expect(agent.model).toBe('claude-haiku-4-6');
  });
});

describe('_startFallback — 폴백 백엔드의 tierModels 로 재해석', () => {
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

  function runFallback(agent, subBackend, tiers) {
    const fallback = {
      backendId: 'sub', backendType: 'claude-cli', configDir: null,
      envOverrides: {
        _resolvedBackendId: 'sub',
        _backendsStore: {
          getBackend: (id) => (id === 'sub' ? subBackend : null),
          getRaw: () => ({ backends: { sub: subBackend }, tiers }),
        },
      },
    };
    const runner = createRunner();
    runner.start({
      sessionId: 's1', agent, message: 'hi',
      backendType: 'claude-cli',
      backendConfig: { backendName: 'main', fallback },
      callbacks: {}
    });
    startClaudeRun2.mock.calls[0][0].callbacks.onError(new Error('rate_limit: usage limit reached'));
    return startClaudeRun2.mock.calls[1][0];
  }

  it('티어 이름이면 폴백 백엔드의 tierModels 로 푼다', () => {
    const fb = runFallback(
      { id: 'a', workingDir: '/tmp', model: 'claude-opus-5', modelAlias: 'high' },
      { type: 'anthropic-compatible', models: { default: 'glm-5.3' }, tierModels: { high: 'glm-5.3' } }
    );
    expect(fb.agent.model).toBe('glm-5.3');
  });

  it('폴백에 그 티어가 없으면 강등/기본값으로 푼다', () => {
    const fb = runFallback(
      { id: 'a', workingDir: '/tmp', model: 'claude-opus-5', modelAlias: 'high' },
      { type: 'anthropic-compatible', models: { default: 'glm-5.3' }, tierModels: {} }
    );
    expect(fb.agent.model).toBe('glm-5.3');
  });
});

describe('backends API — 티어', () => {
  let app;
  let store;
  let file;
  let agents;

  beforeEach(async () => {
    file = tmpPath('backends-tier-api');
    store = await createBackendsStore(file);
    await store.createBackend('zai', {
      type: 'anthropic-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai/api/anthropic',
      envKey: 'ZAI_API_KEY', models: { default: 'glm-5.3' }
    });
    agents = {
      a1: { name: 'A1', model: 'opus' },
      a2: { name: 'A2', modelTier: 'low', accountId: 'old' },
    };
    app = express();
    app.use(express.json());
    app.use('/api/backends', createBackendsRouter({
      backendsStore: store, webConfig: {}, configStore: fakeConfigStore(agents)
    }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await store.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('GET / 가 tiers 와 백엔드별 tierModels 를 노출한다', async () => {
    const res = await request(app).get('/api/backends');
    expect(res.status).toBe(200);
    expect(res.body.tiers.order).toEqual(['high', 'middle', 'low']);
    expect(res.body.backends.zai.tierModels).toEqual({});
  });

  it('PUT/PATCH /:id 가 tierModels 를 받는다', async () => {
    const put = await request(app).put('/api/backends/zai')
      .send({ tierModels: { high: 'glm-5.3', low: 'glm-5.3-flash' } });
    expect(put.status).toBe(200);
    expect(put.body.tierModels).toEqual({ high: 'glm-5.3', low: 'glm-5.3-flash' });

    const patch = await request(app).patch('/api/backends/zai')
      .send({ tierModels: { high: 'glm-5.3', middle: 'glm-5.3', low: 'glm-5.3-flash' } });
    expect(patch.status).toBe(200);
    expect(store.getBackend('zai').tierModels.middle).toBe('glm-5.3');
    // 부분 갱신 — models 는 그대로
    expect(store.getBackend('zai').models.default).toBe('glm-5.3');
  });

  it('POST /tiers 가 티어를 추가/이름변경/삭제한다', async () => {
    const res = await request(app).post('/api/backends/tiers')
      .send({ order: ['flagship', 'high', 'low'], labels: { flagship: '최상', high: '상', low: '하' } });
    expect(res.status).toBe(200);
    expect(res.body.tiers.order).toEqual(['flagship', 'high', 'low']);
    expect(store.getRaw().tiers.labels.flagship).toBe('최상');
    // order 에서 빠진 middle 은 사라진다
    expect(store.getPublic().tiers.order).not.toContain('middle');

    const bad = await request(app).post('/api/backends/tiers').send({ order: [] });
    expect(bad.status).toBe(400);
  });

  it('apply-to-agents 가 modelTier 를 일괄 적용하고 previousTiers 로 되돌린다', async () => {
    const applied = await request(app).post('/api/backends/apply-to-agents')
      .send({ modelTier: 'middle' });
    expect(applied.status).toBe(200);
    expect(applied.body.updated).toBe(2);
    expect(applied.body.previousTiers).toEqual({ a1: null, a2: 'low' });
    expect(agents.a1.modelTier).toBe('middle');
    // backendId 를 주지 않았으므로 backendId/accountId 는 손대지 않는다
    expect(agents.a2.accountId).toBe('old');
    expect(agents.a1.backendId).toBeUndefined();

    const back = await request(app).post('/api/backends/apply-to-agents')
      .send({ restoreTiers: applied.body.previousTiers });
    expect(back.status).toBe(200);
    expect(agents.a1.modelTier).toBe(null);
    expect(agents.a2.modelTier).toBe('low');
  });

  it('apply-to-agents 의 backendId 계약은 그대로다', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ backendId: 'zai' });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe('zai');
    expect(res.body.previous).toEqual({ a1: null, a2: 'old' });
    expect(agents.a1.backendId).toBe('zai');
    expect(agents.a2.accountId).toBe(null);
    // 티어를 주지 않았으므로 기존 modelTier 는 유지
    expect(agents.a2.modelTier).toBe('low');

    const back = await request(app).post('/api/backends/apply-to-agents').send({ restore: res.body.previous });
    expect(back.status).toBe(200);
    expect(agents.a1.backendId).toBe(null);
    expect(agents.a2.backendId).toBe('old');
  });

  it('등록되지 않은 티어는 404 로 막는다', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ modelTier: 'nope' });
    expect(res.status).toBe(404);
    expect(agents.a1.modelTier).toBeUndefined();
  });

  it('backendId 도 modelTier 도 없으면 400', async () => {
    const res = await request(app).post('/api/backends/apply-to-agents').send({ projectId: 'p' });
    expect(res.status).toBe(400);
  });
});
