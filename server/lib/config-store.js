import fs from 'node:fs/promises';
import chokidar from 'chokidar';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { logger } from './logger.js';

export async function createConfigStore(configPath) {
  const emitter = new EventEmitter();
  let cache = { agents: {}, channels: {} };

  async function readFile() {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw);
  }

  async function refresh() {
    try {
      cache = await readFile();
      emitter.emit('change', cache);
    } catch (err) {
      logger.error({ err }, 'config-store: failed to refresh');
    }
  }

  await refresh();

  const watcher = chokidar.watch(configPath, {
    ignoreInitial: true,
    usePolling: true,
    interval: 100,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });
  watcher.on('change', refresh);

  return {
    getAll: () => cache,
    getAgents: () => cache.agents ?? {},
    getAgent: (id) => (cache.agents?.[id] ?? null),
    onChange: (cb) => emitter.on('change', cb),
    async updateAgent(id, patch) {
      const release = await lockfile.lock(configPath, { retries: { retries: 10, minTimeout: 100 } });
      try {
        const current = await readFile();
        current.agents = current.agents ?? {};
        current.agents[id] = { ...(current.agents[id] ?? {}), ...patch };
        const tmp = configPath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(current, null, 2));
        await fs.rename(tmp, configPath);
        cache = current;
        emitter.emit('change', cache);
        return current.agents[id];
      } finally {
        await release();
      }
    },

    async createAgent(id, data) {
      const release = await lockfile.lock(configPath, { retries: { retries: 10, minTimeout: 100 } });
      try {
        const current = await readFile();
        current.agents = current.agents ?? {};
        if (current.agents[id]) {
          const err = new Error(`Agent ${id} already exists`);
          err.code = 'DUPLICATE';
          throw err;
        }
        current.agents[id] = { ...data };
        const tmp = configPath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(current, null, 2));
        await fs.rename(tmp, configPath);
        cache = current;
        emitter.emit('change', cache);
        return current.agents[id];
      } finally {
        await release();
      }
    },

    async deleteAgent(id) {
      const release = await lockfile.lock(configPath, { retries: { retries: 10, minTimeout: 100 } });
      try {
        const current = await readFile();
        if (!current.agents?.[id]) return false;
        delete current.agents[id];
        const tmp = configPath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(current, null, 2));
        await fs.rename(tmp, configPath);
        cache = current;
        emitter.emit('change', cache);
        return true;
      } finally {
        await release();
      }
    },
    async close() {
      await watcher.close();
      emitter.removeAllListeners();
    }
  };
}
