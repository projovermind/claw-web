import { describe, it, expect } from 'vitest';
import { createHealthCheck } from '../server/lib/health-check.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('healthCheck', () => {
  it('reports bot online when pid file points to live process', async () => {
    const pidFile = path.join(os.tmpdir(), `pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(pidFile, String(process.pid));
    const hc = createHealthCheck({ botPidFile: pidFile });
    const s = await hc.check({ noCache: true });
    expect(s.botOnline).toBe(true);
    expect(s.botPid).toBe(process.pid);
    fs.unlinkSync(pidFile);
  });

  it('reports offline when pid file missing', async () => {
    const hc = createHealthCheck({ botPidFile: '/nonexistent-pid-file-xyz.pid' });
    const s = await hc.check({ noCache: true });
    expect(s.botOnline).toBe(false);
    expect(s.botPid).toBeNull();
  });

  it('reports offline when pid does not exist as process', async () => {
    const pidFile = path.join(os.tmpdir(), `pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(pidFile, '9999999');
    const hc = createHealthCheck({ botPidFile: pidFile });
    const s = await hc.check({ noCache: true });
    expect(s.botOnline).toBe(false);
    fs.unlinkSync(pidFile);
  });
});
