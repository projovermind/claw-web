import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { nanoid } from 'nanoid';

const EMPTY = () => ({ version: 1, accounts: {} });
const newId = () => `acc_${nanoid(12)}`;

export async function createAccountsStore(filePath) {
  const emitter = new EventEmitter();
  let cache = EMPTY();

  if (!fssync.existsSync(filePath)) {
    await fs.writeFile(filePath, JSON.stringify(EMPTY(), null, 2));
  }

  async function read() {
    const raw = await fs.readFile(filePath, 'utf8');
    return { ...EMPTY(), ...JSON.parse(raw) };
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
    getAll: () => Object.values(cache.accounts ?? {}),
    getById: (id) => cache.accounts?.[id] ?? null,
    onChange: (cb) => emitter.on('change', cb),

    async create({ label, configDir, priority = 0 }) {
      const id = newId();
      const now = new Date().toISOString();
      const account = {
        id,
        label,
        configDir,
        status: 'active',
        lastUsedAt: null,
        usage: { windowStart: null, messagesUsed: 0 },
        priority,
        createdAt: now,
        updatedAt: now,
      };
      await writeWithLock((data) => {
        data.accounts[id] = account;
        return data;
      });
      return account;
    },

    async update(id, patch) {
      let updated = null;
      await writeWithLock((data) => {
        if (!data.accounts[id]) throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
        data.accounts[id] = {
          ...data.accounts[id],
          ...patch,
          id,
          updatedAt: new Date().toISOString(),
        };
        updated = data.accounts[id];
        return data;
      });
      return updated;
    },

    async delete(id) {
      await writeWithLock((data) => {
        if (!data.accounts[id]) throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
        delete data.accounts[id];
        return data;
      });
    },

    async markUsed(id) {
      await writeWithLock((data) => {
        if (!data.accounts[id]) return data;
        const acc = data.accounts[id];
        const now = new Date().toISOString();
        const windowStart = acc.usage?.windowStart ?? now;
        const windowAge = Date.now() - new Date(windowStart).getTime();
        // Reset window if older than 1 hour
        const messagesUsed = windowAge > 3600_000
          ? 1
          : (acc.usage?.messagesUsed ?? 0) + 1;
        data.accounts[id] = {
          ...acc,
          lastUsedAt: now,
          usage: {
            windowStart: windowAge > 3600_000 ? now : windowStart,
            messagesUsed,
          },
          updatedAt: now,
        };
        return data;
      });
    },

    async setCooldown(id, expiresAt) {
      await writeWithLock((data) => {
        if (!data.accounts[id]) return data;
        data.accounts[id] = {
          ...data.accounts[id],
          status: 'cooldown',
          cooldownUntil: expiresAt,
          updatedAt: new Date().toISOString(),
        };
        return data;
      });
    },
  };
}
