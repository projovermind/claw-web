import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsStore } from '../server/lib/projects-store.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { createProjectsRouter } from '../server/routes/projects.js';
import { errorHandler } from '../server/middleware/error-handler.js';

describe('projects route', () => {
  let app, store, eventBus, file;

  beforeEach(async () => {
    file = path.join(os.tmpdir(), `proj-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      projects: [{ id: 'seed', name: 'Seed', path: '/x', color: '#ffffff' }]
    }));
    store = await createProjectsStore(file);
    eventBus = createEventBus();
    app = express();
    app.use(express.json());
    app.use('/api/projects', createProjectsRouter({ projectsStore: store, eventBus }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await store.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('GET returns list', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
  });

  it('POST creates', async () => {
    const res = await request(app).post('/api/projects')
      .send({ id: 'newp', name: 'NewP', path: '/y' });
    expect(res.status).toBe(201);
    expect(store.getById('newp').name).toBe('NewP');
  });

  it('POST 409 on duplicate', async () => {
    const res = await request(app).post('/api/projects')
      .send({ id: 'seed', name: 'Dup', path: '/' });
    expect(res.status).toBe(409);
  });

  it('PATCH updates', async () => {
    const res = await request(app).patch('/api/projects/seed').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  it('DELETE removes', async () => {
    const res = await request(app).delete('/api/projects/seed');
    expect(res.status).toBe(204);
    expect(store.getById('seed')).toBeNull();
  });
});
