import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProjectsStore } from '../server/lib/projects-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ProjectsStore', () => {
  let tmpFile;
  let store;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `proj-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      version: 1,
      projects: [{ id: 'a', name: 'A', path: '/x', color: '#ffffff' }]
    }));
  });
  afterEach(async () => {
    if (store) await store.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('reads projects', async () => {
    store = await createProjectsStore(tmpFile);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getById('a').name).toBe('A');
  });

  it('creates a new project', async () => {
    store = await createProjectsStore(tmpFile);
    await store.create({ id: 'b', name: 'B', path: '/y', color: '#000000' });
    expect(store.getAll()).toHaveLength(2);
  });

  it('rejects duplicate id', async () => {
    store = await createProjectsStore(tmpFile);
    await expect(store.create({ id: 'a', name: 'dup', path: '/', color: '#000000' }))
      .rejects.toThrow(/exists/i);
  });

  it('updates a project', async () => {
    store = await createProjectsStore(tmpFile);
    await store.update('a', { name: 'A2' });
    expect(store.getById('a').name).toBe('A2');
  });

  it('deletes a project', async () => {
    store = await createProjectsStore(tmpFile);
    await store.remove('a');
    expect(store.getById('a')).toBeNull();
  });
});
