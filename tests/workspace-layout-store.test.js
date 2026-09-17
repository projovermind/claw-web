import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceLayoutStore } from '../server/lib/workspace-layout-store.js';

let dir;
let filePath;

const ws = (id = 'w1') => [{ id, name: 'W', panes: [] }];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-store-'));
  filePath = path.join(dir, 'workspace-layout.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('workspace-layout-store (v2, per-view)', () => {
  it('returns null when nothing is stored', async () => {
    const store = await createWorkspaceLayoutStore(filePath);
    expect(store.get('any')).toBeNull();
  });

  it('migrates a flat v1 file into views.default', async () => {
    await fs.writeFile(filePath, JSON.stringify({
      workspaces: ws('legacy'),
      activeWorkspaceId: 'legacy',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'old-client'
    }));
    const store = await createWorkspaceLayoutStore(filePath);
    const layout = store.get('default');
    expect(layout.seeded).toBe(false);
    expect(layout.workspaces[0].id).toBe('legacy');
    expect(layout.updatedBy).toBe('old-client');
  });

  it('keeps views separate and persists version 2', async () => {
    const store = await createWorkspaceLayoutStore(filePath);
    await store.set({ viewId: 'a', workspaces: ws('wa'), activeWorkspaceId: 'wa', clientId: 'ca' });
    await store.set({ viewId: 'b', workspaces: ws('wb'), activeWorkspaceId: 'wb', clientId: 'cb' });

    expect(store.get('a').workspaces[0].id).toBe('wa');
    expect(store.get('b').workspaces[0].id).toBe('wb');

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(Object.keys(onDisk.views).sort()).toEqual(['a', 'b']);

    const reloaded = await createWorkspaceLayoutStore(filePath);
    expect(reloaded.get('b').workspaces[0].id).toBe('wb');
  });

  it('seeds an unknown view from the most recently updated one', async () => {
    await fs.writeFile(filePath, JSON.stringify({
      version: 2,
      views: {
        old: { workspaces: ws('w-old'), activeWorkspaceId: 'w-old', updatedAt: '2026-01-01T00:00:00.000Z' },
        recent: { workspaces: ws('w-new'), activeWorkspaceId: 'w-new', updatedAt: '2026-02-01T00:00:00.000Z' }
      }
    }));
    const store = await createWorkspaceLayoutStore(filePath);

    const seeded = store.get('never-seen');
    expect(seeded.seeded).toBe(true);
    expect(seeded.viewId).toBe('never-seen');
    expect(seeded.workspaces[0].id).toBe('w-new');
  });

  it('defaults a missing viewId to "default"', async () => {
    const store = await createWorkspaceLayoutStore(filePath);
    const saved = await store.set({ workspaces: ws(), activeWorkspaceId: 'w1' });
    expect(saved.viewId).toBe('default');
    expect(store.get(undefined).seeded).toBe(false);
  });

  it('falls back activeWorkspaceId to the first workspace', async () => {
    const store = await createWorkspaceLayoutStore(filePath);
    const saved = await store.set({ viewId: 'v', workspaces: ws('only'), activeWorkspaceId: 'gone' });
    expect(saved.activeWorkspaceId).toBe('only');
  });

  it('rejects an invalid shape', async () => {
    const store = await createWorkspaceLayoutStore(filePath);
    await expect(store.set({ viewId: 'v', workspaces: [] })).rejects.toThrow(/non-empty/);
    await expect(store.set({ viewId: 'v', workspaces: [{ id: 'x' }] })).rejects.toThrow(/invalid workspace/);
  });

  it('evicts the oldest views past 24, keeping the one just written', async () => {
    const views = {};
    for (let i = 0; i < 24; i += 1) {
      views[`v${i}`] = {
        workspaces: ws(`w${i}`),
        activeWorkspaceId: `w${i}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
      };
    }
    await fs.writeFile(filePath, JSON.stringify({ version: 2, views }));

    const store = await createWorkspaceLayoutStore(filePath);
    await store.set({ viewId: 'fresh', workspaces: ws('w-fresh'), activeWorkspaceId: 'w-fresh' });

    const ids = store.listViewIds();
    expect(ids).toHaveLength(24);
    expect(ids[0]).toBe('fresh');
    expect(ids).not.toContain('v0');
    expect(ids).toContain('v23');
  });
});
