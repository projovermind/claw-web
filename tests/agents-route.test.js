import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConfigStore } from '../server/lib/config-store.js';
import { createAgentsRouter } from '../server/routes/agents.js';
import { errorHandler } from '../server/middleware/error-handler.js';

describe('agents route', () => {
  let app;
  let store;
  let tmpFile;

  beforeAll(async () => {
    tmpFile = path.join(os.tmpdir(), `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      agents: {
        hivemind: { name: '하이브마인드', model: 'sonnet', avatar: '🧠' }
      }
    }));
    store = await createConfigStore(tmpFile);

    app = express();
    app.use(express.json());
    app.use('/api/agents', createAgentsRouter({ configStore: store }));
    app.use(errorHandler);
  });

  afterAll(async () => {
    await store.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('GET /api/agents returns list', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe('hivemind');
    expect(res.body.agents[0].name).toBe('하이브마인드');
  });

  it('GET /api/agents/:id returns single', async () => {
    const res = await request(app).get('/api/agents/hivemind');
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('sonnet');
  });

  it('GET /api/agents/:id returns 404 for missing', async () => {
    const res = await request(app).get('/api/agents/ghost');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
  });
});
