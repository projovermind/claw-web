import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionsStore } from '../server/lib/sessions-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SessionsStore', () => {
  let tmpFile, store;
  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `sess-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(async () => {
    if (store) await store.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('creates session with id and agentId', async () => {
    store = await createSessionsStore(tmpFile);
    const s = await store.create({ agentId: 'hivemind', title: 'test' });
    expect(s.id).toMatch(/^sess_/);
    expect(s.agentId).toBe('hivemind');
    expect(s.title).toBe('test');
    expect(s.messages).toEqual([]);
  });

  it('lists sessions filtered by agentId', async () => {
    store = await createSessionsStore(tmpFile);
    await store.create({ agentId: 'a' });
    await store.create({ agentId: 'a' });
    await store.create({ agentId: 'b' });
    expect(store.list().length).toBe(3);
    expect(store.list('a').length).toBe(2);
  });

  it('appends messages', async () => {
    store = await createSessionsStore(tmpFile);
    const s = await store.create({ agentId: 'x' });
    await store.appendMessage(s.id, { role: 'user', content: 'hi' });
    await store.appendMessage(s.id, { role: 'assistant', content: 'hello' });
    const updated = store.get(s.id);
    expect(updated.messages.length).toBe(2);
    expect(updated.messages[0].content).toBe('hi');
  });

  it('updates title and claudeSessionId', async () => {
    store = await createSessionsStore(tmpFile);
    const s = await store.create({ agentId: 'x' });
    await store.update(s.id, { title: 'renamed', claudeSessionId: 'abc-123' });
    const r = store.get(s.id);
    expect(r.title).toBe('renamed');
    expect(r.claudeSessionId).toBe('abc-123');
  });

  it('deletes session', async () => {
    store = await createSessionsStore(tmpFile);
    const s = await store.create({ agentId: 'x' });
    await store.remove(s.id);
    expect(store.get(s.id)).toBeNull();
  });
});
