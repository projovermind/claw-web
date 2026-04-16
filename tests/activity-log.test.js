import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createActivityLog } from '../server/lib/activity-log.js';
import { createEventBus } from '../server/lib/event-bus.js';

describe('activity-log', () => {
  let logPath, logDir, log, bus;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logDir = path.join(os.tmpdir(), `activity-${id}`);
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, 'activity.jsonl');
    bus = createEventBus();
    log = createActivityLog({ filePath: logPath, eventBus: bus });
  });

  afterEach(async () => {
    await log.close();
    try {
      await fsp.rm(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('appends events published on the event bus (for allowlisted topics)', async () => {
    bus.publish('agent.created', { agentId: 'foo' });
    bus.publish('skill.created', { skill: { id: 'sk1', name: 'Test' } });
    // Wait for async writes to flush
    await new Promise((r) => setTimeout(r, 50));
    const entries = await log.readLast(10);
    expect(entries.length).toBe(2);
    const topics = entries.map((e) => e.topic).sort();
    expect(topics).toEqual(['agent.created', 'skill.created']);
  });

  it('readLast returns entries in reverse chronological order (newest first)', async () => {
    bus.publish('agent.created', { agentId: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    bus.publish('agent.created', { agentId: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    bus.publish('agent.created', { agentId: 'c' });
    await new Promise((r) => setTimeout(r, 50));
    const entries = await log.readLast(10);
    expect(entries.length).toBe(3);
    expect(entries[0].agentId).toBe('c');
    expect(entries[1].agentId).toBe('b');
    expect(entries[2].agentId).toBe('a');
  });

  it('respects limit in readLast', async () => {
    for (let i = 0; i < 5; i++) {
      bus.publish('agent.created', { agentId: `a${i}` });
    }
    await new Promise((r) => setTimeout(r, 50));
    const entries = await log.readLast(3);
    expect(entries.length).toBe(3);
    // Should get the latest 3
    expect(entries[0].agentId).toBe('a4');
  });

  it('does NOT log excluded high-volume topics like chat.chunk', async () => {
    bus.publish('chat.chunk', { sessionId: 's1', text: 'hello' });
    bus.publish('agent.created', { agentId: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    const entries = await log.readLast(10);
    expect(entries.length).toBe(1);
    expect(entries[0].topic).toBe('agent.created');
  });

  it('readLast returns empty array when file does not exist yet', async () => {
    const entries = await log.readLast(10);
    expect(entries).toEqual([]);
  });

  it('each entry has a ts field', async () => {
    bus.publish('agent.created', { agentId: 'foo' });
    await new Promise((r) => setTimeout(r, 50));
    const [entry] = await log.readLast(1);
    expect(entry.ts).toBeDefined();
    // Should parse as a valid date
    expect(new Date(entry.ts).toString()).not.toBe('Invalid Date');
  });
});
