import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';

const EMPTY = () => ({ version: 1, devices: [] });

export async function createDevicesStore(filePath) {
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
    return (cache.devices ?? []).slice().sort((a, b) => {
      const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return (a.name ?? '').localeCompare(b.name ?? '');
    });
  }

  return {
    getAll: () => sorted(),
    getById: (id) => (cache.devices ?? []).find(d => d.id === id) ?? null,
    onChange: (cb) => emitter.on('change', cb),

    async create(device) {
      if ((cache.devices ?? []).some(d => d.id === device.id)) {
        const err = new Error(`Device ${device.id} exists`);
        err.code = 'DUPLICATE';
        throw err;
      }
      await writeWithLock((current) => {
        current.devices = [...(current.devices ?? []), device];
        return current;
      });
      return device;
    },

    async update(id, patch) {
      await writeWithLock((current) => {
        current.devices = (current.devices ?? []).map(d => d.id === id ? { ...d, ...patch } : d);
        return current;
      });
      return cache.devices.find(d => d.id === id);
    },

    async remove(id) {
      await writeWithLock((current) => {
        current.devices = (current.devices ?? []).filter(d => d.id !== id);
        return current;
      });
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
