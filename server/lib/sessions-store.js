import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { nanoid } from 'nanoid';

const EMPTY = () => ({ version: 1, sessions: {} });
const newId = () => `sess_${nanoid(12)}`;

export async function createSessionsStore(filePath) {
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
    list(agentId, { includeArchived = false } = {}) {
      const all = Object.values(cache.sessions ?? {});
      const active = includeArchived ? all : all.filter((s) => !s._archived);
      return agentId ? active.filter((s) => s.agentId === agentId) : active;
    },
    get: (id) => cache.sessions?.[id] ?? null,
    onChange: (cb) => emitter.on('change', cb),

    async create({ agentId, title, ...extra }) {
      const id = newId();
      const now = new Date().toISOString();
      const session = {
        id,
        agentId,
        title: title ?? 'New session',
        createdAt: now,
        updatedAt: now,
        claudeSessionId: null,
        messages: [],
        ...(extra ?? {})
      };
      await writeWithLock((current) => {
        current.sessions = { ...(current.sessions ?? {}), [id]: session };
        return current;
      });
      return session;
    },

    async appendMessage(id, message) {
      const msg = { ...message, ts: new Date().toISOString() };
      await writeWithLock((current) => {
        const s = current.sessions?.[id];
        if (!s) return current;
        s.messages = [...(s.messages ?? []), msg];
        s.updatedAt = msg.ts;
        return current;
      });
      return msg;
    },

    async update(id, patch) {
      await writeWithLock((current) => {
        const s = current.sessions?.[id];
        if (!s) return current;
        current.sessions[id] = { ...s, ...patch, updatedAt: new Date().toISOString() };
        return current;
      });
      return cache.sessions[id];
    },

    async remove(id) {
      await writeWithLock((current) => {
        if (current.sessions) delete current.sessions[id];
        return current;
      });
    },

    async archiveByAgent(agentId) {
      const snapshot = Object.values(cache.sessions ?? {})
        .filter((s) => s.agentId === agentId && !s._archived);
      if (snapshot.length === 0) return [];
      await writeWithLock((current) => {
        for (const s of snapshot) {
          if (current.sessions[s.id]) current.sessions[s.id]._archived = true;
        }
        return current;
      });
      return snapshot;
    },

    async unarchiveSessions(sessions) {
      if (!sessions || sessions.length === 0) return;
      await writeWithLock((current) => {
        for (const s of sessions) {
          current.sessions[s.id] = { ...s, _archived: false };
        }
        return current;
      });
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
