import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadWebConfig } from '../server/lib/web-config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('loadWebConfig', () => {
  let tmpFile;
  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `web-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('returns parsed config with defaults', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      port: 3838,
      configPath: '/tmp/config.json',
      features: { dashboard: true }
    }));
    const cfg = loadWebConfig(tmpFile);
    expect(cfg.port).toBe(3838);
    expect(cfg.configPath).toBe('/tmp/config.json');
    expect(cfg.features.dashboard).toBe(true);
    // defaults present
    expect(cfg.features.chat).toBe(true);
    expect(cfg.auth.enabled).toBe(false);
  });

  it('defaults delegation retention to 30 days in dry-run', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ port: 3838, chat: { autoCompactPct: 80 } }));
    const cfg = loadWebConfig(tmpFile);
    expect(cfg.chat.autoCompactPct).toBe(80);
    expect(cfg.chat.delegationRetentionDays).toBe(30);
    expect(cfg.chat.delegationRetentionDryRun).toBe(true);
  });

  it('throws on missing file', () => {
    expect(() => loadWebConfig('/nonexistent-file.json')).toThrow();
  });

  it('throws on invalid JSON', () => {
    fs.writeFileSync(tmpFile, 'not json');
    expect(() => loadWebConfig(tmpFile)).toThrow();
  });
});
