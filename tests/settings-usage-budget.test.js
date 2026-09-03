import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWebConfig } from '../server/lib/web-config.js';
import { createSettingsRouter } from '../server/routes/settings.js';
import { createStatsRouter } from '../server/routes/stats.js';
import { errorHandler } from '../server/middleware/error-handler.js';

describe('chat.autoCompactPct + usage budget settings', () => {
  let app, webConfig, cfgPath;

  beforeEach(() => {
    cfgPath = path.join(os.tmpdir(), `webcfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify({ port: 3838 }));
    webConfig = loadWebConfig(cfgPath);

    app = express();
    app.use(express.json());
    app.use('/api/settings', createSettingsRouter({ webConfig, webConfigPath: cfgPath }));
    app.use('/api/stats', createStatsRouter({
      sessionsStore: { list: () => [] },
      configStore: { getAgents: () => ({}) },
      webConfig
    }));
    app.use(errorHandler);
  });

  afterEach(() => {
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  });

  it('defaults to auto-compact off and no budget', () => {
    expect(webConfig.chat).toEqual({ autoCompactPct: 0 });
    expect(webConfig.usage).toEqual({ budget5h: 0, budget7d: 0 });
  });

  it('PATCH persists both and rejects an out-of-range pct', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .send({ chat: { autoCompactPct: 70 }, usage: { budget5h: 1_000_000, budget7d: 5_000_000 } });
    expect(res.status).toBe(200);

    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(saved.chat.autoCompactPct).toBe(70);
    expect(saved.usage).toEqual({ budget5h: 1_000_000, budget7d: 5_000_000 });

    expect((await request(app).patch('/api/settings').send({ chat: { autoCompactPct: 101 } })).status).toBe(400);
    expect((await request(app).patch('/api/settings').send({ usage: { budget5h: -1 } })).status).toBe(400);
  });

  it('GET /api/stats/usage echoes the configured budget', async () => {
    await request(app).patch('/api/settings').send({ usage: { budget5h: 42, budget7d: 84 } });
    const res = await request(app).get('/api/stats/usage');
    expect(res.status).toBe(200);
    expect(res.body.budget).toEqual({ tokens5h: 42, tokens7d: 84 });
  });
});
