import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMetadataStore } from '../server/lib/metadata-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MetadataStore', () => {
  let tmpFile;
  let store;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `meta-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(async () => {
    if (store) await store.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('creates empty metadata file if missing', async () => {
    store = await createMetadataStore(tmpFile);
    expect(store.getAll()).toEqual({ version: 1, agents: {} });
    expect(fs.existsSync(tmpFile)).toBe(true);
  });

  it('writes and reads agent overlay', async () => {
    store = await createMetadataStore(tmpFile);
    await store.updateAgent('hivemind', { projectId: 'overmind' });
    expect(store.getAgent('hivemind').projectId).toBe('overmind');
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(raw.agents.hivemind.projectId).toBe('overmind');
  });

  it('preserves existing fields on partial update', async () => {
    store = await createMetadataStore(tmpFile);
    await store.updateAgent('algo', { projectId: 'algorithm' });
    await store.updateAgent('algo', { lastRun: '2026-04-15' });
    const a = store.getAgent('algo');
    expect(a.projectId).toBe('algorithm');
    expect(a.lastRun).toBe('2026-04-15');
  });

  it('deleteAgent removes overlay', async () => {
    store = await createMetadataStore(tmpFile);
    await store.updateAgent('x', { projectId: 'y' });
    await store.deleteAgent('x');
    expect(store.getAgent('x')).toBeNull();
  });
});
