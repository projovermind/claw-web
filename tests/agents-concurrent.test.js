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

describe('PATCH /api/agents/:id — If-Match-UpdatedAt concurrency', () => {
  let app, configStore, metaStore, eventBus, cfgFile, metaFile;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cfgFile = path.join(os.tmpdir(), `cfg-${id}.json`);
    metaFile = path.join(os.tmpdir(), `meta-${id}.json`);
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        agents: { hivemind: { name: 'Hive', model: 'sonnet' } }
      })
    );
    configStore = await createConfigStore(cfgFile);
    metaStore = await createMetadataStore(metaFile);
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
    try { fs.unlinkSync(cfgFile); } catch { /* ignore */ }
    try { fs.unlinkSync(metaFile); } catch { /* ignore */ }
  });

  async function patch(body, headers = {}) {
    return request(app)
      .patch('/api/agents/hivemind')
      .set(headers)
      .send(body);
  }

  it('without If-Match-UpdatedAt: patch always succeeds', async () => {
    const res1 = await patch({ name: 'First' });
    expect(res1.status).toBe(200);
    const res2 = await patch({ name: 'Second' });
    expect(res2.status).toBe(200);
  });

  it('with matching If-Match-UpdatedAt: succeeds', async () => {
    // First patch to create metadata with an updatedAt
    await patch({ favorite: true });
    const meta = metaStore.getAgent('hivemind');
    expect(meta.updatedAt).toBeDefined();
    const res = await patch(
      { name: 'With match' },
      { 'If-Match-UpdatedAt': meta.updatedAt }
    );
    expect(res.status).toBe(200);
  });

  it('with stale If-Match-UpdatedAt: 409 UPDATEDAT_CONFLICT', async () => {
    await patch({ favorite: true });
    // Wait a tick so updatedAt advances
    await new Promise((r) => setTimeout(r, 10));
    await patch({ favorite: false });
    // Now use the FIRST updatedAt as If-Match — stale
    const res = await patch(
      { name: 'Stale' },
      { 'If-Match-UpdatedAt': '2020-01-01T00:00:00.000Z' }
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UPDATEDAT_CONFLICT');
  });

  it('config-only patch still advances updatedAt (via touchAgent)', async () => {
    // Seed metadata
    await patch({ favorite: true });
    const beforeToken = metaStore.getAgent('hivemind').updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    // Config-only patch
    await patch({ name: 'Config only' });
    const afterToken = metaStore.getAgent('hivemind').updatedAt;
    expect(afterToken).not.toBe(beforeToken);
    expect(new Date(afterToken).getTime()).toBeGreaterThan(
      new Date(beforeToken).getTime()
    );
  });

  it('simulates two-tab edit: second save errors, force retry succeeds', async () => {
    // Both tabs load:
    await patch({ favorite: true });
    const token = metaStore.getAgent('hivemind').updatedAt;
    // Tab A saves first
    await new Promise((r) => setTimeout(r, 5));
    const tabA = await patch(
      { name: 'Tab A edit' },
      { 'If-Match-UpdatedAt': token }
    );
    expect(tabA.status).toBe(200);
    // Tab B still holds the old token → conflict
    const tabB = await patch(
      { name: 'Tab B edit' },
      { 'If-Match-UpdatedAt': token }
    );
    expect(tabB.status).toBe(409);
    // Tab B force-retries without the header
    const tabBForce = await patch({ name: 'Tab B edit (forced)' });
    expect(tabBForce.status).toBe(200);
    // Config was updated to Tab B's value
    expect(configStore.getAgent('hivemind').name).toBe('Tab B edit (forced)');
  });
});
