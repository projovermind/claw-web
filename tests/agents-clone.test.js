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

describe('POST /api/agents/:id/clone', () => {
  let app, configStore, metaStore, eventBus, cfgFile, metaFile;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cfgFile = path.join(os.tmpdir(), `cfg-${id}.json`);
    metaFile = path.join(os.tmpdir(), `meta-${id}.json`);
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        agents: {
          source: {
            name: 'Source Agent',
            model: 'sonnet',
            systemPrompt: 'I am source',
            allowedTools: ['Read', 'Grep']
          }
        }
      })
    );
    configStore = await createConfigStore(cfgFile);
    metaStore = await createMetadataStore(metaFile);
    // Seed metadata overlay on source
    await metaStore.updateAgent('source', {
      projectId: 'overmind',
      tier: 'project',
      skillIds: ['skill_a', 'skill_b'],
      order: 5,
      favorite: true
    });
    eventBus = createEventBus();

    app = express();
    app.use(express.json());
    app.use(
      '/api/agents',
      createAgentsRouter({ configStore, metadataStore: metaStore, eventBus })
    );
    app.use(errorHandler);
  });

  afterEach(async () => {
    await configStore.close();
    await metaStore.close();
    try {
      fs.unlinkSync(cfgFile);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(metaFile);
    } catch {
      /* ignore */
    }
  });

  it('clones with new id and default "(copy)" suffix', async () => {
    const res = await request(app)
      .post('/api/agents/source/clone')
      .send({ newId: 'cloned' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('cloned');
    expect(res.body.name).toBe('Source Agent (copy)');
    expect(res.body.model).toBe('sonnet');
    expect(res.body.systemPrompt).toBe('I am source');
    expect(res.body.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('accepts custom newName', async () => {
    const res = await request(app)
      .post('/api/agents/source/clone')
      .send({ newId: 'cloned', newName: 'My Clone' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Clone');
  });

  it('copies metadata overlay by default (skillIds, tier, projectId, favorite)', async () => {
    await request(app).post('/api/agents/source/clone').send({ newId: 'cloned' });
    const clonedMeta = metaStore.getAgent('cloned');
    expect(clonedMeta.projectId).toBe('overmind');
    expect(clonedMeta.tier).toBe('project');
    expect(clonedMeta.skillIds).toEqual(['skill_a', 'skill_b']);
    expect(clonedMeta.favorite).toBe(true);
  });

  it('bumps order +1 on the clone', async () => {
    await request(app).post('/api/agents/source/clone').send({ newId: 'cloned' });
    const clonedMeta = metaStore.getAgent('cloned');
    expect(clonedMeta.order).toBe(6);
  });

  it('does NOT copy metadata when copyMetadata=false', async () => {
    await request(app)
      .post('/api/agents/source/clone')
      .send({ newId: 'bare', copyMetadata: false });
    const bareMeta = metaStore.getAgent('bare');
    expect(bareMeta).toBeNull();
  });

  it('rejects duplicate newId with 409', async () => {
    await request(app).post('/api/agents/source/clone').send({ newId: 'cloned' });
    const dup = await request(app).post('/api/agents/source/clone').send({ newId: 'cloned' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
  });

  it('returns 404 when source does not exist', async () => {
    const res = await request(app)
      .post('/api/agents/ghost/clone')
      .send({ newId: 'cloned' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
  });

  it('rejects invalid newId format', async () => {
    const res = await request(app)
      .post('/api/agents/source/clone')
      .send({ newId: 'bad id!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });
});
