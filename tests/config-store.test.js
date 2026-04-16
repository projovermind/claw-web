import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConfigStore } from '../server/lib/config-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ConfigStore', () => {
  let tmpFile;
  let store;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      agents: {
        hivemind: { name: '하이브마인드', model: 'sonnet', avatar: '🧠' },
        default: { name: 'Claude', model: 'sonnet' }
      }
    }));
  });

  afterEach(async () => {
    if (store) await store.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('reads agents from config.json', async () => {
    store = await createConfigStore(tmpFile);
    const agents = store.getAgents();
    expect(Object.keys(agents)).toHaveLength(2);
    expect(agents.hivemind.name).toBe('하이브마인드');
  });

  it('getAgent returns single agent by id', async () => {
    store = await createConfigStore(tmpFile);
    expect(store.getAgent('hivemind').model).toBe('sonnet');
    expect(store.getAgent('nonexistent')).toBeNull();
  });

  it('fires onChange when file changes', async () => {
    store = await createConfigStore(tmpFile);
    const changes = [];
    store.onChange(() => changes.push('changed'));

    // Wait for watcher to be ready
    await new Promise(r => setTimeout(r, 200));

    const cfg = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    cfg.agents.hivemind.model = 'opus';
    fs.writeFileSync(tmpFile, JSON.stringify(cfg));

    // Poll until change detected or timeout
    const start = Date.now();
    while (changes.length === 0 && Date.now() - start < 3000) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(changes.length).toBeGreaterThan(0);
    expect(store.getAgent('hivemind').model).toBe('opus');
  });
});
