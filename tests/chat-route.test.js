import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSessionsStore } from '../server/lib/sessions-store.js';
import { createConfigStore } from '../server/lib/config-store.js';
import { createMetadataStore } from '../server/lib/metadata-store.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { createChatRouter } from '../server/routes/chat.js';
import { errorHandler } from '../server/middleware/error-handler.js';

function mockRunner() {
  let running = new Set();
  let captured = null;
  return {
    captured: () => captured,
    isRunning: (id) => running.has(id),
    abort: (id) => running.delete(id),
    start: ({ sessionId, agent, message, callbacks }) => {
      captured = { sessionId, agent, message };
      running.add(sessionId);
      setImmediate(() => {
        callbacks.onText('hello ');
        callbacks.onText('world');
        callbacks.onToolUse({ name: 'Read', input: { file_path: '/a.txt' } });
        callbacks.onResult({
          text: 'hello world',
          claudeSessionId: 'c-sess-42',
          model: 'claude-sonnet-4-6',
          exitCode: 0
        });
        callbacks.onExit({ code: 0 });
      });
    }
  };
}

describe('chat route', () => {
  let app, sessionsStore, configStore, metaStore, runner, eventBus, sessFile, cfgFile, metaFile;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessFile = path.join(os.tmpdir(), `sess-${id}.json`);
    cfgFile = path.join(os.tmpdir(), `cfg-${id}.json`);
    metaFile = path.join(os.tmpdir(), `meta-${id}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({
      agents: { hivemind: { name: '하이브마인드', model: 'sonnet' } }
    }));
    sessionsStore = await createSessionsStore(sessFile);
    configStore = await createConfigStore(cfgFile);
    metaStore = await createMetadataStore(metaFile);
    runner = mockRunner();
    eventBus = createEventBus();

    app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter({
      sessionsStore, configStore, metadataStore: metaStore, runner, eventBus
    }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await sessionsStore.close();
    await configStore.close();
    await metaStore.close();
    for (const f of [sessFile, cfgFile, metaFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
  });

  it('POST /api/chat streams via event bus and persists messages', async () => {
    const session = await sessionsStore.create({ agentId: 'hivemind' });
    const events = [];
    eventBus.subscribe((e) => events.push(e));

    const res = await request(app).post('/api/chat').send({ sessionId: session.id, message: 'hi' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('started');

    // Wait for runner callbacks to complete
    await new Promise((r) => setTimeout(r, 50));

    // Events published
    const topics = events.map((e) => e.topic);
    expect(topics).toContain('chat.started');
    expect(topics).toContain('chat.chunk');
    expect(topics).toContain('chat.tool');
    expect(topics).toContain('chat.done');

    // Session has user + assistant messages
    const s = sessionsStore.get(session.id);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].content).toBe('hi');
    expect(s.messages[1].role).toBe('assistant');
    expect(s.messages[1].content).toBe('hello world');

    // claudeSessionId stored for resume
    expect(s.claudeSessionId).toBe('c-sess-42');

    // Auto-title from first message
    expect(s.title).toBe('hi');
  });

  it('POST 404 for unknown session', async () => {
    const res = await request(app).post('/api/chat').send({ sessionId: 'ghost', message: 'x' });
    expect(res.status).toBe(404);
  });

  it('POST uses lightweightMode from metadata overlay', async () => {
    const session = await sessionsStore.create({ agentId: 'hivemind' });
    await metaStore.updateAgent('hivemind', { lightweightMode: true });

    await request(app).post('/api/chat').send({ sessionId: session.id, message: 'hi' });
    await new Promise((r) => setTimeout(r, 50));

    expect(runner.captured().agent.lightweightMode).toBe(true);
  });
});
