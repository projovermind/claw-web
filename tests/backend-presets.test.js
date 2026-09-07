import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBackendsStore } from '../server/lib/backends-store.js';
import { createBackendsRouter, BACKEND_PRESETS } from '../server/routes/backends.js';
import { resolveBackend } from '../server/routes/chat/utils.js';
import { errorHandler } from '../server/middleware/error-handler.js';

describe('backend presets', () => {
  let app;
  let store;
  let tmpFile;

  beforeAll(async () => {
    tmpFile = path.join(os.tmpdir(), `backends-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    store = await createBackendsStore(tmpFile);
    app = express();
    app.use(express.json());
    app.use('/api/backends', createBackendsRouter({ backendsStore: store, webConfig: {} }));
    app.use(errorHandler);
  });

  afterAll(async () => {
    await store.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('GET /presets lists presets with installed flags', async () => {
    const res = await request(app).get('/api/backends/presets');
    expect(res.status).toBe(200);
    expect(res.body.presets.map((p) => p.id)).toEqual(BACKEND_PRESETS.map((p) => p.id));
    expect(res.body.presets.every((p) => p.installed === false)).toBe(true);
  });

  it('applying the omniroute preset registers an anthropic-compatible backend', async () => {
    const res = await request(app).post('/api/backends/presets/omniroute/apply').send({});
    expect(res.status).toBe(201);
    const saved = store.getRaw().backends.omniroute;
    expect(saved.type).toBe('anthropic-compatible');
    expect(saved.baseURL).toBe('http://localhost:20128');
    // Claude CLI appends /v1/messages itself — a /v1 suffix here would 404.
    expect(saved.baseURL.endsWith('/v1')).toBe(false);

    const after = await request(app).get('/api/backends/presets');
    expect(after.body.presets.find((p) => p.id === 'omniroute').installed).toBe(true);
  });

  it('re-applying a preset is rejected instead of clobbering the saved config', async () => {
    const res = await request(app).post('/api/backends/presets/omniroute/apply').send({});
    expect(res.status).toBe(409);
  });

  it('unknown preset id is a 404', async () => {
    const res = await request(app).post('/api/backends/presets/nope/apply').send({});
    expect(res.status).toBe(404);
  });

  it('austerity toggle onto a missing backend fails with an actionable 400', async () => {
    const res = await request(app)
      .post('/api/backends/austerity')
      .send({ enabled: true, backendId: 'not-registered' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('AUSTERITY_BACKEND_MISSING');
  });

  it('resolveBackend falls back to activeBackend when austerityBackend is missing', () => {
    const raw = {
      activeBackend: 'claude',
      austerityMode: true,
      austerityBackend: 'ghost',
      backends: { claude: { type: 'claude-cli', label: 'Claude' } }
    };
    const fakeStore = { getRaw: () => raw };
    const out = resolveBackend({ id: 'a', model: 'opus' }, fakeStore);
    expect(out.backendId).toBe('claude');
    expect(out.backendObj).not.toBeNull();
  });

  it('austerity toggle onto a registered backend succeeds', async () => {
    const res = await request(app)
      .post('/api/backends/austerity')
      .send({ enabled: true, backendId: 'omniroute' });
    expect(res.status).toBe(200);
    expect(store.getRaw().austerityBackend).toBe('omniroute');
  });
});

describe('modelContextWindow', () => {
  it('gives the 1M families 1M and keeps Haiku/legacy at 200K', async () => {
    const { modelContextWindow } = await import('../server/lib/context-window.js');
    // 1M 계열 — 이 값이 200K 로 떨어지면 게이지가 5배 어긋나고 자동 compact 가 오작동한다.
    expect(modelContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(modelContextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(modelContextWindow('claude-opus-4-6')).toBe(1_000_000);
    expect(modelContextWindow('claude-fable-5-1')).toBe(1_000_000);
    // Haiku 는 1M 이 아니다 — opus|sonnet 규칙에 딸려 들어가면 안 된다.
    expect(modelContextWindow('claude-haiku-4-5')).toBe(200_000);
    // 구세대 / 미지 모델은 보수적으로 200K
    expect(modelContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(modelContextWindow('glm-4.6')).toBe(200_000);
    expect(modelContextWindow(null)).toBe(200_000);
  });

  it('server and client heuristics stay in sync', async () => {
    const fs = await import('node:fs');
    const grab = (p) => {
      const src = fs.readFileSync(p, 'utf8');
      const i = src.indexOf('if (!model) return 200_000;');
      return src.slice(i, src.indexOf('\n}', i))
        .replace(/\s+/g, ' ')
        .replace('String(model).toLowerCase()', 'model.toLowerCase()');
    };
    expect(grab('server/lib/context-window.js')).toBe(grab('client/src/lib/context-window.ts'));
  });
});
