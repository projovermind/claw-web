import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { logger } from './logger.js';

const EMPTY = () => ({ version: 1, agents: {} });

export async function createMetadataStore(filePath) {
  const emitter = new EventEmitter();
  let cache = EMPTY();

  if (!fssync.existsSync(filePath)) {
    await fs.writeFile(filePath, JSON.stringify(EMPTY(), null, 2));
  }

  async function read() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return { ...EMPTY(), ...JSON.parse(raw) };
    } catch (err) {
      logger.warn({ err, filePath }, 'metadata-store: read failed, using empty');
      return EMPTY();
    }
  }

  cache = await read();

  async function writeWithLock(mutator) {
    const release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 100 } });
    try {
      const current = await read();
      const next = mutator(current);
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(next, null, 2));
      await fs.rename(tmp, filePath);
      cache = next;
      emitter.emit('change', cache);
      return next;
    } finally {
      await release();
    }
  }

  return {
    getAll: () => cache,
    getAgent: (id) => cache.agents?.[id] ?? null,
    onChange: (cb) => emitter.on('change', cb),

    async updateAgent(id, patch) {
      const now = new Date().toISOString();
      await writeWithLock((current) => {
        current.agents = current.agents ?? {};
        current.agents[id] = {
          ...(current.agents[id] ?? { createdAt: now }),
          ...patch,
          updatedAt: now
        };
        return current;
      });
      return cache.agents[id];
    },

    /**
     * Stamp an agent's updatedAt without changing any other field. Used so
     * config-only PATCH requests still bump the concurrency token.
     */
    async touchAgent(id) {
      const now = new Date().toISOString();
      await writeWithLock((current) => {
        current.agents = current.agents ?? {};
        current.agents[id] = {
          ...(current.agents[id] ?? { createdAt: now }),
          updatedAt: now
        };
        return current;
      });
      return cache.agents[id];
    },

    async deleteAgent(id) {
      await writeWithLock((current) => {
        if (current.agents) delete current.agents[id];
        return current;
      });
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
