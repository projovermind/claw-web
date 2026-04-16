import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createProcessTracker } from '../server/lib/process-tracker.js';

describe('process-tracker', () => {
  let tmpDir, filePath;

  beforeEach(() => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmpDir = path.join(os.tmpdir(), `tracker-${id}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    filePath = path.join(tmpDir, 'running.json');
  });

  afterEach(async () => {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('tracks and releases a pid', async () => {
    const t = createProcessTracker({ filePath });
    await t.track('sess1', 12345);
    expect(t._getState().sessions.sess1.pid).toBe(12345);
    await t.release('sess1');
    expect(t._getState().sessions.sess1).toBeUndefined();
  });

  it('persists state across tracker instances', async () => {
    const t1 = createProcessTracker({ filePath });
    await t1.track('sess1', 12345);
    // New instance reads the file
    const t2 = createProcessTracker({ filePath });
    expect(t2._getState().sessions.sess1.pid).toBe(12345);
  });

  it('reapOrphans clears dead pids silently', async () => {
    const t1 = createProcessTracker({ filePath });
    // A pid that's almost certainly not running (chosen to be non-existent)
    await t1.track('sess1', 1);
    await t1.track('sess2', 999999);
    // Reap should not throw; dead pids are simply cleared
    const t2 = createProcessTracker({ filePath });
    const killed = await t2.reapOrphans();
    // Neither PID should have been killable (the one we track as dead above is not ours)
    // But the state should be cleared regardless.
    expect(t2._getState().sessions).toEqual({});
    // killed can be 0 or more depending on what OS thinks of those pids, but the
    // important invariant is that state is cleared.
    expect(typeof killed).toBe('number');
  });

  it('reapOrphans SIGTERMs a live orphan (integration)', async () => {
    // Spawn a tiny sleep process that survives briefly, track it, then reap it.
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid;
    expect(pid).toBeDefined();

    const t1 = createProcessTracker({ filePath });
    await t1.track('orphan-sess', pid);

    // Verify it's alive
    expect(() => process.kill(pid, 0)).not.toThrow();

    // New tracker instance reads the file and reaps
    const t2 = createProcessTracker({ filePath });
    const killed = await t2.reapOrphans();
    expect(killed).toBeGreaterThanOrEqual(1);

    // Give it a moment to die
    await new Promise((r) => setTimeout(r, 100));

    // State should be cleared
    expect(t2._getState().sessions).toEqual({});
  });

  it('track is idempotent on same sessionId (overwrites)', async () => {
    const t = createProcessTracker({ filePath });
    await t.track('sess1', 100);
    await t.track('sess1', 200);
    expect(t._getState().sessions.sess1.pid).toBe(200);
  });
});
