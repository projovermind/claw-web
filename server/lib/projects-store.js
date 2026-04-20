import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';

const EMPTY = () => ({ version: 1, projects: [] });

export async function createProjectsStore(filePath) {
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

  function sorted() {
    return (cache.projects ?? []).slice().sort((a, b) => {
      const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return (a.name ?? '').localeCompare(b.name ?? '');
    });
  }

  return {
    getAll: () => sorted(),
    getById: (id) => (cache.projects ?? []).find(p => p.id === id) ?? null,
    onChange: (cb) => emitter.on('change', cb),

    async create(project) {
      if ((cache.projects ?? []).some(p => p.id === project.id)) {
        const err = new Error(`Project ${project.id} exists`);
        err.code = 'DUPLICATE';
        throw err;
      }
      if (project.accountId && !project.backendId) project = { ...project, backendId: project.accountId };
      await writeWithLock((current) => {
        current.projects = [...(current.projects ?? []), project];
        return current;
      });
      return project;
    },

    async update(id, patch) {
      if (patch.accountId && !patch.backendId) patch = { ...patch, backendId: patch.accountId };
      await writeWithLock((current) => {
        current.projects = (current.projects ?? []).map(p => p.id === id ? { ...p, ...patch } : p);
        return current;
      });
      return cache.projects.find(p => p.id === id);
    },

    async remove(id) {
      await writeWithLock((current) => {
        current.projects = (current.projects ?? []).filter(p => p.id !== id);
        return current;
      });
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
