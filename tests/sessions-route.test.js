import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSessionsStore } from '../server/lib/sessions-store.js';
import { createConfigStore } from '../server/lib/config-store.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { createSessionsRouter } from '../server/routes/sessions.js';
import { errorHandler } from '../server/middleware/error-handler.js';

function makeRunnerStub() {
  return {
    isRunning: () => false,
    abort: () => false,
    start: () => {},
    activeIds: () => []
  };
}

describe('sessions route', () => {
  let app, sessionsStore, configStore, runner, eventBus, sessFile, cfgFile;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessFile = path.join(os.tmpdir(), `sess-${id}.json`);
    cfgFile = path.join(os.tmpdir(), `cfg-${id}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({
      agents: { hivemind: { name: '하이브마인드', model: 'sonnet' } }
    }));
    sessionsStore = await createSessionsStore(sessFile);
    configStore = await createConfigStore(cfgFile);
    runner = makeRunnerStub();
    eventBus = createEventBus();

    app = express();
    app.use(express.json());
    app.use('/api/sessions', createSessionsRouter({ sessionsStore, configStore, runner, eventBus }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await sessionsStore.close();
    await configStore.close();
    try { fs.unlinkSync(sessFile); } catch {}
    try { fs.unlinkSync(cfgFile); } catch {}
  });

  it('POST creates a session for known agent', async () => {
    const res = await request(app).post('/api/sessions').send({ agentId: 'hivemind', title: 'test' });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^sess_/);
    expect(res.body.agentId).toBe('hivemind');
  });

  it('POST 404 for unknown agent', async () => {
    const res = await request(app).post('/api/sessions').send({ agentId: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('GET lists sessions, filter by agentId', async () => {
    await request(app).post('/api/sessions').send({ agentId: 'hivemind' });
    const res = await request(app).get('/api/sessions?agentId=hivemind');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it('PATCH updates title', async () => {
    const create = await request(app).post('/api/sessions').send({ agentId: 'hivemind' });
    const res = await request(app).patch(`/api/sessions/${create.body.id}`).send({ title: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('renamed');
  });

  it('DELETE removes session', async () => {
    const create = await request(app).post('/api/sessions').send({ agentId: 'hivemind' });
    const res = await request(app).delete(`/api/sessions/${create.body.id}`);
    expect(res.status).toBe(204);
    expect(sessionsStore.get(create.body.id)).toBeNull();
  });
});
