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

// Minimal runner stub — tests don't care about actual execution
function makeRunnerStub() {
  return {
    isRunning: () => false,
    abort: () => false,
    activeIds: () => [],
    start: () => ({})
  };
}

describe('sessions: bulk-delete, export, pinning', () => {
  let app, sessionsStore, configStore, eventBus, sessFile, cfgFile;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessFile = path.join(os.tmpdir(), `sess-${id}.json`);
    cfgFile = path.join(os.tmpdir(), `cfg-${id}.json`);
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        agents: { hivemind: { name: 'Hive', model: 'sonnet' } }
      })
    );
    fs.writeFileSync(sessFile, JSON.stringify({ version: 1, sessions: {} }));
    sessionsStore = await createSessionsStore(sessFile);
    configStore = await createConfigStore(cfgFile);
    eventBus = createEventBus();

    app = express();
    app.use(express.json());
    app.use(
      '/api/sessions',
      createSessionsRouter({
        sessionsStore,
        configStore,
        runner: makeRunnerStub(),
        eventBus
      })
    );
    app.use(errorHandler);
  });

  afterEach(async () => {
    await sessionsStore.close();
    await configStore.close();
    try { fs.unlinkSync(sessFile); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgFile); } catch { /* ignore */ }
  });

  async function createSession(title) {
    const res = await request(app)
      .post('/api/sessions')
      .send({ agentId: 'hivemind', title });
    return res.body;
  }

  describe('bulk-delete', () => {
    it('deletes multiple sessions and reports counts', async () => {
      const a = await createSession('A');
      const b = await createSession('B');
      const c = await createSession('C');
      const res = await request(app)
        .post('/api/sessions/bulk-delete')
        .send({ ids: [a.id, b.id] });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(2);
      expect(res.body.skipped).toBe(0);
      expect(sessionsStore.get(a.id)).toBeNull();
      expect(sessionsStore.get(b.id)).toBeNull();
      expect(sessionsStore.get(c.id)).not.toBeNull();
    });

    it('skips unknown ids without failing the batch', async () => {
      const a = await createSession('A');
      const res = await request(app)
        .post('/api/sessions/bulk-delete')
        .send({ ids: [a.id, 'ghost_id'] });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(res.body.skipped).toBe(1);
    });

    it('rejects empty ids array', async () => {
      const res = await request(app).post('/api/sessions/bulk-delete').send({ ids: [] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_BODY');
    });

    it('rejects >200 ids', async () => {
      const ids = Array.from({ length: 201 }, (_, i) => `s${i}`);
      const res = await request(app).post('/api/sessions/bulk-delete').send({ ids });
      expect(res.status).toBe(400);
    });
  });

  describe('pinning', () => {
    it('PATCH { pinned: true } persists the flag', async () => {
      const s = await createSession('pin me');
      const res = await request(app)
        .patch(`/api/sessions/${s.id}`)
        .send({ pinned: true });
      expect(res.status).toBe(200);
      expect(res.body.pinned).toBe(true);
      expect(sessionsStore.get(s.id).pinned).toBe(true);
    });

    it('PATCH { pinned: false } unpins', async () => {
      const s = await createSession('temp');
      await request(app).patch(`/api/sessions/${s.id}`).send({ pinned: true });
      const res = await request(app)
        .patch(`/api/sessions/${s.id}`)
        .send({ pinned: false });
      expect(res.body.pinned).toBe(false);
    });
  });

  describe('export', () => {
    async function seedWithMessages() {
      const s = await createSession('Test session');
      await sessionsStore.appendMessage(s.id, { role: 'user', content: 'hello' });
      await sessionsStore.appendMessage(s.id, {
        role: 'assistant',
        content: 'hi there',
        model: 'claude-sonnet-4-6',
        toolCalls: [{ name: 'Read', input: {} }]
      });
      return s;
    }

    it('GET /export?format=json returns the raw session as JSON', async () => {
      const s = await seedWithMessages();
      const res = await request(app).get(`/api/sessions/${s.id}/export?format=json`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      const parsed = JSON.parse(res.text);
      expect(parsed.id).toBe(s.id);
      expect(parsed.messages).toHaveLength(2);
    });

    it('GET /export?format=md renders markdown', async () => {
      const s = await seedWithMessages();
      const res = await request(app).get(`/api/sessions/${s.id}/export?format=md`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/markdown/);
      expect(res.text).toContain('# Test session');
      expect(res.text).toContain('👤 User');
      expect(res.text).toContain('🤖 Assistant');
      expect(res.text).toContain('hello');
      expect(res.text).toContain('hi there');
      expect(res.text).toContain('`Read`');
    });

    it('defaults to json when format is omitted or invalid', async () => {
      const s = await seedWithMessages();
      const res = await request(app).get(`/api/sessions/${s.id}/export`);
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app).get('/api/sessions/ghost/export?format=md');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
    });

    it('content-disposition uses a sanitized filename', async () => {
      const s = await createSession('rm -rf / 🔥 <dangerous>');
      const res = await request(app).get(`/api/sessions/${s.id}/export?format=md`);
      // The dangerous shell chars should be stripped from the filename
      expect(res.headers['content-disposition']).not.toMatch(/<|>|\//);
    });
  });
});
