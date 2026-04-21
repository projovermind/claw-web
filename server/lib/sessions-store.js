import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import { nanoid } from 'nanoid';

/**
 * sessions-store — per-session file storage with in-memory index cache.
 *
 * Motivation:
 *   The previous implementation kept every session (with messages) in one JSON
 *   file. As conversations grew the file hit ~9 MB; every `appendMessage`
 *   rewrote the whole blob, and `list()`/`get()` re-parsed it on demand.
 *
 * New layout (on disk):
 *   <filePath>                     ← legacy single-file (renamed to *.migrated-<ts>
 *                                     on first boot after migration)
 *   <filePath>-store/
 *     _index.json                  ← meta-only snapshot (messages excluded)
 *     <sessionId>.json             ← full session with messages
 *
 * Behaviour:
 *   - On boot: if `_index.json` is missing, read legacy file, split to per-session
 *     files, rename legacy file to `<filePath>.migrated-<ts>` (never deleted).
 *     Otherwise, load every `<sessionId>.json` into memory in parallel.
 *   - `list()` / `get()` stay **synchronous** and return from the in-memory cache
 *     (API unchanged — callers in routes/ depend on sync access).
 *   - Writes touch one session file (KB-scale) plus the tiny `_index.json`.
 *   - Concurrency: per-session Promise chain serialises writes to the same
 *     session; different sessions run in parallel. Single Node process, so no
 *     cross-process lockfile is required.
 */

const newId = () => `sess_${nanoid(12)}`;

export async function createSessionsStore(legacyFilePath) {
  const emitter = new EventEmitter();
  const storeDir = legacyFilePath.replace(/\.json$/, '') + '-store';
  const indexPath = path.join(storeDir, '_index.json');

  await fs.mkdir(storeDir, { recursive: true });

  /** @type {Map<string, object>} authoritative in-memory cache */
  const cache = new Map();

  // ── Boot: migrate or load ────────────────────────────────────────────────
  if (!fssync.existsSync(indexPath)) {
    if (fssync.existsSync(legacyFilePath)) {
      try {
        const raw = await fs.readFile(legacyFilePath, 'utf8');
        const legacy = JSON.parse(raw);
        const sessions = legacy?.sessions ?? {};
        const entries = Object.entries(sessions);
        await Promise.all(entries.map(async ([id, s]) => {
          if (!s || typeof s !== 'object') return;
          const safeId = s.id || id;
          const session = { ...s, id: safeId };
          await atomicWriteJson(sessionFilePath(storeDir, safeId), session);
          cache.set(safeId, session);
        }));
        console.log(`[sessions-store] migrated ${entries.length} sessions from ${legacyFilePath}`);
      } catch (err) {
        console.error('[sessions-store] legacy migration failed:', err.message);
      }
    }
    await atomicWriteJson(indexPath, buildIndex(cache));
    if (fssync.existsSync(legacyFilePath)) {
      const bak = `${legacyFilePath}.migrated-${Date.now()}`;
      try {
        await fs.rename(legacyFilePath, bak);
        console.log(`[sessions-store] legacy file preserved at ${bak}`);
      } catch (err) {
        console.error('[sessions-store] failed to rename legacy file:', err.message);
      }
    }
  } else {
    const dirents = await fs.readdir(storeDir);
    const sessionFiles = dirents.filter((f) => f.endsWith('.json') && f !== '_index.json');
    await Promise.all(sessionFiles.map(async (f) => {
      try {
        const raw = await fs.readFile(path.join(storeDir, f), 'utf8');
        const s = JSON.parse(raw);
        if (s?.id) cache.set(s.id, s);
      } catch (err) {
        console.error(`[sessions-store] failed to load ${f}:`, err.message);
      }
    }));
  }

  // ── Per-session serialisation (Promise chain, single-process) ────────────
  /** @type {Map<string, Promise<any>>} */
  const perSessionChain = new Map();
  function withSessionLock(id, fn) {
    const prev = perSessionChain.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    perSessionChain.set(id, next);
    next.finally(() => {
      if (perSessionChain.get(id) === next) perSessionChain.delete(id);
    });
    return next;
  }

  // Index writes are coalesced: only the latest snapshot survives.
  let indexChain = Promise.resolve();
  let indexDirty = false;
  function scheduleIndexWrite() {
    indexDirty = true;
    const next = indexChain.catch(() => {}).then(async () => {
      if (!indexDirty) return;
      indexDirty = false;
      await atomicWriteJson(indexPath, buildIndex(cache));
    });
    indexChain = next;
    return next;
  }

  function fire() { emitter.emit('change'); }

  // ── Public API ───────────────────────────────────────────────────────────
  return {
    list(agentId, { includeArchived = false } = {}) {
      const all = Array.from(cache.values());
      const active = includeArchived ? all : all.filter((s) => !s._archived);
      return agentId ? active.filter((s) => s.agentId === agentId) : active;
    },

    get(id) {
      return cache.get(id) ?? null;
    },

    onChange(cb) { emitter.on('change', cb); },

    async create({ agentId, title, ...extra } = {}) {
      const id = newId();
      const now = new Date().toISOString();
      const session = {
        id,
        agentId,
        title: title ?? 'New session',
        createdAt: now,
        updatedAt: now,
        claudeSessionId: null,
        personaBakedInto: null,
        messages: [],
        ...(extra ?? {}),
      };
      await withSessionLock(id, async () => {
        await atomicWriteJson(sessionFilePath(storeDir, id), session);
        cache.set(id, session);
      });
      await scheduleIndexWrite();
      fire();
      return session;
    },

    async appendMessage(id, message) {
      const msg = { ...message, ts: new Date().toISOString() };
      let affected = false;
      await withSessionLock(id, async () => {
        const s = cache.get(id);
        if (!s) return;
        const updated = {
          ...s,
          messages: [...(s.messages ?? []), msg],
          updatedAt: msg.ts,
        };
        await atomicWriteJson(sessionFilePath(storeDir, id), updated);
        cache.set(id, updated);
        affected = true;
      });
      if (affected) {
        await scheduleIndexWrite();
        fire();
      }
      return msg;
    },

    async update(id, patch) {
      let updated = null;
      await withSessionLock(id, async () => {
        const s = cache.get(id);
        if (!s) return;
        updated = { ...s, ...patch, updatedAt: new Date().toISOString() };
        await atomicWriteJson(sessionFilePath(storeDir, id), updated);
        cache.set(id, updated);
      });
      if (updated) {
        await scheduleIndexWrite();
        fire();
      }
      return updated;
    },

    async remove(id) {
      let removed = false;
      await withSessionLock(id, async () => {
        if (!cache.has(id)) return;
        cache.delete(id);
        try { await fs.unlink(sessionFilePath(storeDir, id)); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        removed = true;
      });
      if (removed) {
        await scheduleIndexWrite();
        fire();
      }
    },

    async archiveByAgent(agentId) {
      const snapshot = Array.from(cache.values())
        .filter((s) => s.agentId === agentId && !s._archived);
      if (snapshot.length === 0) return [];
      // Write each affected session file in parallel (per-session locks
      // keep each one serialised against its own concurrent writers).
      await Promise.all(snapshot.map((s) => withSessionLock(s.id, async () => {
        const cur = cache.get(s.id);
        if (!cur) return;
        const updated = { ...cur, _archived: true };
        await atomicWriteJson(sessionFilePath(storeDir, s.id), updated);
        cache.set(s.id, updated);
      })));
      await scheduleIndexWrite();
      fire();
      return snapshot;
    },

    async unarchiveSessions(sessions) {
      if (!sessions || sessions.length === 0) return;
      await Promise.all(sessions.map((s) => withSessionLock(s.id, async () => {
        const restored = { ...s, _archived: false };
        await atomicWriteJson(sessionFilePath(storeDir, s.id), restored);
        cache.set(s.id, restored);
      })));
      await scheduleIndexWrite();
      fire();
    },

    async close() {
      // Drain any pending writes so tests / graceful shutdown observe final
      // state on disk before removing listeners.
      await Promise.allSettled(Array.from(perSessionChain.values()));
      await indexChain.catch(() => {});
      emitter.removeAllListeners();
    },
  };
}

function sessionFilePath(storeDir, id) {
  // `id` is generated via nanoid (`sess_<12 chars>`) or copied from the legacy
  // file. Both are URL-safe, so no further sanitisation is required for the
  // filename. We still refuse path traversal characters defensively.
  if (typeof id !== 'string' || id.length === 0 || /[/\\]/.test(id) || id === '..') {
    throw new Error(`[sessions-store] invalid session id: ${id}`);
  }
  return path.join(storeDir, `${id}.json`);
}

async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

function buildIndex(cache) {
  const sessions = {};
  for (const s of cache.values()) {
    sessions[s.id] = {
      id: s.id,
      agentId: s.agentId,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      _archived: !!s._archived,
      pinned: !!s.pinned,
      claudeSessionId: s.claudeSessionId ?? null,
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    };
  }
  return { version: 2, sessions };
}
