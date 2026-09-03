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

  /**
   * 쓰기 직전 재읽기는 실패를 삼키면 안 된다 — 읽기 실패 시 EMPTY 를 깔고 쓰면
   * 다른 에이전트의 메타데이터가 통째로 날아간다. 여기서는 throw 시켜 쓰기를 중단.
   */
  async function readStrict() {
    const raw = await fs.readFile(filePath, 'utf8');
    return { ...EMPTY(), ...JSON.parse(raw) };
  }

  async function writeWithLock(mutator) {
    const release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 100 } });
    try {
      const current = await readStrict();
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
