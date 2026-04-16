import fs from 'node:fs/promises';
import fssync from 'node:fs';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const MAX_LINES = 1000; // keep last N entries; older ones pruned on write

/**
 * Simple append-only JSONL activity log.
 *
 * Each line is a JSON object: { ts, topic, ...payload }.
 * Subscribes to the eventBus and persists selected topics.
 * On rotation (when line count exceeds MAX_LINES), drops oldest entries.
 */
export function createActivityLog({ filePath, eventBus }) {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fssync.existsSync(dir)) {
    fssync.mkdirSync(dir, { recursive: true });
  }
  // Ensure file exists
  if (!fssync.existsSync(filePath)) {
    fssync.writeFileSync(filePath, '');
  }

  // Topics we record (excludes high-volume chunk streams)
  const RECORD_TOPICS = new Set([
    'agent.created',
    'agent.updated',
    'agent.deleted',
    'agent.cloned',
    'project.created',
    'project.updated',
    'project.deleted',
    'skill.created',
    'skill.updated',
    'skill.deleted',
    'skill.bulkAssign',
    'skill.bulkUnassign',
    'session.created',
    'session.updated',
    'session.deleted',
    'chat.started',
    'chat.done',
    'chat.error',
    'chat.aborted',
    'upload.created',
    'upload.deleted',
    'backends.updated',
    'settings.updated'
  ]);

  let writeQueue = Promise.resolve();
  let writeCount = 0;

  async function append(entry) {
    const line = JSON.stringify(entry) + '\n';
    // Serialize writes
    writeQueue = writeQueue.then(async () => {
      try {
        await fs.appendFile(filePath, line);
        writeCount += 1;
        // Rotate occasionally (every 50 writes check)
        if (writeCount % 50 === 0) {
          await rotate();
        }
      } catch (err) {
        logger.warn({ err, filePath }, 'activity-log: append failed');
      }
    });
    return writeQueue;
  }

  async function rotate() {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length <= MAX_LINES) return;
      const trimmed = lines.slice(-MAX_LINES).join('\n') + '\n';
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp, trimmed);
      await fs.rename(tmp, filePath);
      logger.info({ dropped: lines.length - MAX_LINES }, 'activity-log: rotated');
    } catch (err) {
      logger.warn({ err }, 'activity-log: rotate failed');
    }
  }

  async function readLast(limit = 50) {
    try {
      const rl = readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity
      });
      const buffer = [];
      for await (const line of rl) {
        if (!line.trim()) continue;
        buffer.push(line);
        if (buffer.length > limit * 2) buffer.splice(0, buffer.length - limit * 2);
      }
      const tail = buffer.slice(-limit).reverse();
      const entries = [];
      for (const line of tail) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
      return entries;
    } catch (err) {
      logger.warn({ err }, 'activity-log: read failed');
      return [];
    }
  }

  // Subscribe to eventBus
  const unsubscribe = eventBus.subscribe(({ topic, payload, ts }) => {
    if (!RECORD_TOPICS.has(topic)) return;
    append({ ts: ts ?? new Date().toISOString(), topic, ...payload });
  });

  return {
    append,
    readLast,
    async close() {
      unsubscribe();
      await writeQueue;
    }
  };
}
