import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBackendsStore } from '../server/lib/backends-store.js';
import { createBackendsRouter } from '../server/routes/backends.js';
import { resolveBackend, buildBackendEnv, resolveAgent } from '../server/routes/chat/utils.js';
import { normalizeTiers, tierBackendId } from '../server/lib/model-tiers.js';
import { errorHandler } from '../server/middleware/error-handler.js';

/**
 * 티어가 모델뿐 아니라 **백엔드**까지 고르는 경로.
 * HIGH=Claude / LOW=Z.AI 처럼 급마다 다른 제공자를 섞어 쓰기 위한 것이라,
 * 우선순위(개별 지정 > 절약 모드 > 티어 > 전역)가 어긋나면 비용이 엉뚱한 데로 샌다.
 */

const BACKENDS = {
  claude: {
    type: 'claude-cli', label: 'Claude',
    models: { default: 'claude-opus-5', opus: 'claude-opus-5' },
    tierModels: { high: 'claude-opus-5', middle: 'claude-sonnet-5', low: 'claude-haiku-4-6' }
  },
  zai: {
    type: 'anthropic-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai/api/anthropic',
    models: { default: 'glm-5.3', sonnet: 'glm-legacy-sonnet' },
    tierModels: { high: 'glm-5.3', middle: 'glm-5.3', low: 'glm-5.3-flash' }
  },
  oai: { type: 'openai-compatible', label: 'OAI', models: { default: 'gpt-x' } }
};

const TIERS = {
  order: ['high', 'middle', 'low'],
  labels: {},
  backends: { high: 'claude', low: 'zai' } // middle 은 지정 없음 = 전역 따름
};

function store(overrides = {}) {
  const raw = {
    activeBackend: 'claude',
    austerityMode: false,
    austerityBackend: 'zai',
    fallbackBackend: null,
    tiers: TIERS,
    backends: BACKENDS,
    ...overrides
  };
  return { getRaw: () => raw, getBackend: (id) => raw.backends[id] ?? null };
}

describe('normalizeTiers — backends 맵', () => {
  it('값이 없거나 null 인 티어는 키에서 뺀다 (= 전역 따름)', () => {
    const t = normalizeTiers({ order: ['high', 'low'], backends: { high: 'claude', low: null } });
    expect(t.backends).toEqual({ high: 'claude' });
  });

  it('order 에 없는 티어의 지정은 버린다', () => {
    const t = normalizeTiers({ order: ['high'], backends: { high: 'claude', ghost: 'zai' } });
    expect(t.backends).toEqual({ high: 'claude' });
  });

  it('tierBackendId 는 지정이 없으면 null', () => {
    expect(tierBackendId(TIERS, 'high')).toBe('claude');
    expect(tierBackendId(TIERS, 'middle')).toBe(null);
    expect(tierBackendId(TIERS, '')).toBe(null);
  });
});

describe('resolveBackend — 우선순위', () => {
  it('티어가 백엔드를 고른다', () => {
    expect(resolveBackend({ id: 'a', modelTier: 'low' }, store()).backendId).toBe('zai');
    expect(resolveBackend({ id: 'a', modelTier: 'high' }, store()).backendId).toBe('claude');
  });

  it('티어 지정이 없는 티어는 전역 activeBackend 를 따른다', () => {
    const s = store({ activeBackend: 'oai' });
    expect(resolveBackend({ id: 'a', modelTier: 'middle' }, s).backendId).toBe('oai');
  });

  it('에이전트 개별 지정(backendId)이 티어를 이긴다', () => {
    const r = resolveBackend({ id: 'a', modelTier: 'low', backendId: 'claude' }, store());
    expect(r.backendId).toBe('claude');
  });

  it('절약 모드가 티어를 이긴다', () => {
    const s = store({ austerityMode: true, austerityBackend: 'oai' });
    expect(resolveBackend({ id: 'a', modelTier: 'high' }, s).backendId).toBe('oai');
  });

  it('절약 모드 대상이 등록돼 있지 않으면 티어가 다시 산다', () => {
    const s = store({ austerityMode: true, austerityBackend: 'gone' });
    expect(resolveBackend({ id: 'a', modelTier: 'low' }, s).backendId).toBe('zai');
  });

  it('티어가 가리키는 백엔드가 지워졌으면 무시하고 전역으로 간다', () => {
    const s = store({ tiers: { ...TIERS, backends: { low: 'ghost' } } });
    expect(resolveBackend({ id: 'a', modelTier: 'low' }, s).backendId).toBe('claude');
  });

  it('modelTier 가 없으면 예전 그대로 전역 백엔드', () => {
    expect(resolveBackend({ id: 'a' }, store()).backendId).toBe('claude');
  });
});

describe('resolveBackend — 레거시 자동 리라우팅', () => {
  it('티어가 백엔드를 고른 경우엔 리라우팅하지 않는다', () => {
    const s = store({ tiers: { ...TIERS, backends: { low: 'oai' } } });
    // claude-* 모델 + openai-compatible 백엔드 = 원래라면 claude 로 틀던 조합
    const r = resolveBackend({ id: 'a', modelTier: 'low', model: 'claude-sonnet-5' }, s);
    expect(r.backendId).toBe('oai');
  });

  it('티어가 없으면 기존 리라우팅은 그대로 동작한다 (회귀 방지)', () => {
    const s = store({ activeBackend: 'oai' });
    expect(resolveBackend({ id: 'a', model: 'claude-sonnet-5' }, s).backendId).toBe('claude');
    expect(resolveBackend({ id: 'a', model: 'glm-5.3' }, store()).backendId).toBe('zai');
  });
});

describe('buildBackendEnv — 게이트웨이 env', () => {
  it('tierModels 가 있으면 ANTHROPIC_DEFAULT_* 를 그 값으로 채운다', () => {
    const env = buildBackendEnv({ id: 'a', modelTier: 'low' }, store());
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3');       // tierModels.middle 우선
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
  });

  it('tierModels 에 없는 항목만 models 로 메운다', () => {
    const s = store({
      backends: { ...BACKENDS, zai: { ...BACKENDS.zai, tierModels: { high: 'glm-5.3' } } }
    });
    const env = buildBackendEnv({ id: 'a', modelTier: 'low' }, s);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-legacy-sonnet');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("modelTier 가 있으면 model:'default' 를 sonnet 으로 바꾸지 않는다", () => {
    const tiered = { id: 'a', modelTier: 'low', model: 'default' };
    buildBackendEnv(tiered, store());
    expect(tiered.model).toBe('default');

    const plain = { id: 'a', backendId: 'zai', model: 'default' };
    buildBackendEnv(plain, store());
    expect(plain.model).toBe('sonnet'); // 기존 동작 유지
  });
});

describe('resolveAgent — 티어가 고른 백엔드로 끝까지 간다', () => {
  const deps = (s) => ({
    configStore: { getAgent: () => ({ modelTier: 'low' }) },
    backendsStore: s
  });

  it('백엔드·모델·_resolvedBackendId 가 모두 티어 백엔드 기준', () => {
    const s = store();
    const { agent, envOverrides, backendType, backendConfig } = resolveAgent('a', deps(s));
    expect(backendConfig.backendName).toBe('zai');
    expect(backendType).toBe('anthropic-compatible');
    expect(agent.model).toBe('glm-5.3-flash'); // zai 의 low
    expect(agent.modelAlias).toBe('low');
    expect(envOverrides._resolvedBackendId).toBe('zai');
  });

  it('폴백은 티어로 고른 백엔드를 1차로 보고 결정한다', () => {
    const s = store({
      fallbackBackend: null,
      backends: { ...BACKENDS, zai: { ...BACKENDS.zai, fallback: 'claude' } }
    });
    const { backendConfig } = resolveAgent('a', deps(s));
    expect(backendConfig.fallbackId).toBe('claude');
    expect(backendConfig.fallback.backendId).toBe('claude');
  });
});

describe('API — POST /tiers + 백엔드 삭제', () => {
  let app;
  let backendsStore;
  let file;

  beforeEach(async () => {
    file = path.join(os.tmpdir(), `tier-backends-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    backendsStore = await createBackendsStore(file);
    await backendsStore.createBackend('zai', {
      type: 'anthropic-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai/api/anthropic',
      envKey: 'ZAI_API_KEY', models: { default: 'glm-5.3' }
    });
    app = express();
    app.use(express.json());
    app.use('/api/backends', createBackendsRouter({ backendsStore, webConfig: {} }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await backendsStore.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('티어별 백엔드를 저장하고 GET 으로 돌려준다', async () => {
    const res = await request(app).post('/api/backends/tiers').send({
      order: ['high', 'middle', 'low'],
      labels: { high: '상', middle: '중', low: '하' },
      backends: { high: 'claude', low: 'zai' }
    });
    expect(res.status).toBe(200);
    expect(res.body.tiers.backends).toEqual({ high: 'claude', low: 'zai' });
    expect((await request(app).get('/api/backends')).body.tiers.backends).toEqual({ high: 'claude', low: 'zai' });
  });

  it('등록되지 않은 백엔드 id 는 거부가 아니라 무시한다', async () => {
    const res = await request(app).post('/api/backends/tiers').send({
      order: ['high', 'low'],
      backends: { high: 'ghost', low: 'zai' }
    });
    expect(res.status).toBe(200);
    expect(res.body.tiers.backends).toEqual({ low: 'zai' });
  });

  it('null 을 보내면 그 티어는 전역 따름으로 돌아간다', async () => {
    await request(app).post('/api/backends/tiers').send({ order: ['high', 'low'], backends: { low: 'zai' } });
    const res = await request(app).post('/api/backends/tiers').send({ order: ['high', 'low'], backends: { low: null } });
    expect(res.body.tiers.backends).toEqual({});
  });

  it('백엔드를 지우면 그 티어 포인터도 같이 끊긴다', async () => {
    await request(app).post('/api/backends/tiers').send({ order: ['high', 'low'], backends: { low: 'zai' } });
    expect(backendsStore.getRaw().tiers.backends.low).toBe('zai');

    await request(app).delete('/api/backends/zai').expect(204);
    expect(backendsStore.getRaw().tiers.backends.low).toBeUndefined();
    expect(backendsStore.getPublic().tiers.backends).toEqual({});
  });
});
