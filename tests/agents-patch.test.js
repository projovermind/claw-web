import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConfigStore } from '../server/lib/config-store.js';
import { createMetadataStore } from '../server/lib/metadata-store.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { createAgentsRouter } from '../server/routes/agents.js';
import { errorHandler } from '../server/middleware/error-handler.js';

describe('PATCH /api/agents/:id', () => {
  let app, configStore, metaStore, eventBus, cfgFile, metaFile;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cfgFile = path.join(os.tmpdir(), `cfg-${id}.json`);
    metaFile = path.join(os.tmpdir(), `meta-${id}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({
      agents: { hivemind: { name: '하이브마인드', model: 'sonnet' } }
    }));
    configStore = await createConfigStore(cfgFile);
    metaStore = await createMetadataStore(metaFile);
    eventBus = createEventBus();

    app = express();
    app.use(express.json());
    app.use('/api/agents', createAgentsRouter({ configStore, metadataStore: metaStore, eventBus }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await configStore.close();
    await metaStore.close();
    try { fs.unlinkSync(cfgFile); } catch {}
    try { fs.unlinkSync(metaFile); } catch {}
  });

  it('updates config field (model) in config.json', async () => {
    const res = await request(app).patch('/api/agents/hivemind').send({ model: 'opus' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('opus');
    const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    expect(raw.agents.hivemind.model).toBe('opus');
  });

  it('updates metadata field (projectId) in web-metadata.json', async () => {
    const res = await request(app).patch('/api/agents/hivemind').send({ projectId: 'overmind' });
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe('overmind');
    const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    expect(raw.agents.hivemind.projectId).toBe('overmind');
  });

  it('updates both simultaneously', async () => {
    const res = await request(app).patch('/api/agents/hivemind').send({ model: 'opus', projectId: 'overmind' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('opus');
    expect(res.body.projectId).toBe('overmind');
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).patch('/api/agents/ghost').send({ model: 'opus' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid field', async () => {
    const res = await request(app).patch('/api/agents/hivemind').send({ unknown: 'x' });
    expect(res.status).toBe(400);
  });

  it('publishes agent.updated event', async () => {
    const events = [];
    eventBus.subscribe((e) => events.push(e));
    await request(app).patch('/api/agents/hivemind').send({ projectId: 'overmind' });
    expect(events.find(e => e.topic === 'agent.updated')).toBeTruthy();
  });
});
