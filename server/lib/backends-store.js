import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';

const EMPTY = () => ({
  version: 1,
  activeBackend: 'claude',
  austerityMode: false,
  austerityBackend: 'zai',
  backends: {
    claude: {
      type: 'claude-cli',
      label: 'Claude (CLI)',
      envKey: null,
      models: {
        opus: 'claude-opus-4-6',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-sonnet-4-6'
      }
    }
  }
});

export async function createBackendsStore(filePath, { secretsStore } = {}) {
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

  // Mask sensitive data — return only envKey name and whether it's set in process.env
  function publicView() {
    const backends = {};
    for (const [id, b] of Object.entries(cache.backends ?? {})) {
      const envStatus = b.envKey ? (process.env[b.envKey] ? 'set' : 'unset') : 'n/a';
      const secretSource =
        b.envKey && secretsStore?._getState?.().backends?.[id]?.value
          ? 'managed'
          : b.envKey && process.env[b.envKey]
            ? 'shell'
            : 'none';

      // Claude CLI: OAuth 토큰 상태도 체크
      let oauthStatus = 'unset';
      let oauthSource = 'none';
      if (b.type === 'claude-cli') {
        const oauthKey = 'CLAUDE_CODE_OAUTH_TOKEN';
        oauthStatus = process.env[oauthKey] ? 'set' : 'unset';
        oauthSource = secretsStore?._getState?.().backends?.[`${id}_oauth`]?.value
          ? 'managed'
          : process.env[oauthKey]
            ? 'shell'
            : 'none';
      }

      backends[id] = {
        id,
        type: b.type,
        label: b.label,
        baseURL: b.baseURL ?? null,
        envKey: b.envKey ?? null,
        envStatus: b.type === 'claude-cli' && oauthStatus === 'set' && envStatus !== 'set' ? 'set (OAuth)' : envStatus,
        secretSource,
        models: b.models ?? {},
        fallback: b.fallback ?? null,
        ...(b.type === 'claude-cli' ? { oauthStatus, oauthSource } : {})
      };
    }
    return {
      activeBackend: cache.activeBackend,
      austerityMode: !!cache.austerityMode,
      austerityBackend: cache.austerityBackend,
      backends
    };
  }

  return {
    getRaw: () => cache,
    getPublic: publicView,
    getBackend: (id) => cache.backends?.[id] ?? null,
    onChange: (cb) => emitter.on('change', cb),

    async createBackend(id, data) {
      await writeWithLock((current) => {
        current.backends = current.backends ?? {};
        if (current.backends[id]) {
          const err = new Error(`Backend ${id} exists`);
          err.code = 'DUPLICATE';
          throw err;
        }
        current.backends[id] = data;
        return current;
      });
      return cache.backends[id];
    },

    async updateBackend(id, patch) {
      await writeWithLock((current) => {
        if (!current.backends?.[id]) return current;
        current.backends[id] = { ...current.backends[id], ...patch };
        return current;
      });
      return cache.backends[id];
    },

    async deleteBackend(id) {
      await writeWithLock((current) => {
        if (current.backends?.[id]?.type === 'claude-cli') {
          const err = new Error('Cannot delete built-in Claude CLI backend');
          err.code = 'PROTECTED';
          throw err;
        }
        if (current.backends) delete current.backends[id];
        return current;
      });
      // Also forget the secret for this backend
      if (secretsStore) await secretsStore.forget(id);
    },

    /**
     * Set or clear the API key secret for a backend. The value is written
     * to secrets.json AND injected live into process.env, so subsequent
     * Claude CLI spawns pick it up without a restart.
     */
    async setSecret(id, value) {
      if (!secretsStore) throw new Error('secrets store not configured');
      const b = cache.backends?.[id];
      if (!b) throw new Error(`Unknown backend ${id}`);
      if (!b.envKey) throw new Error(`Backend ${id} has no envKey (cannot store a secret)`);
      await secretsStore.set(id, b.envKey, value);
    },

    async setActive(backendId) {
      await writeWithLock((current) => {
        if (!current.backends?.[backendId]) throw new Error(`Unknown backend ${backendId}`);
        current.activeBackend = backendId;
        return current;
      });
    },

    async setAusterity(enabled, backendId) {
      await writeWithLock((current) => {
        current.austerityMode = !!enabled;
        if (backendId) {
          if (!current.backends?.[backendId]) throw new Error(`Unknown backend ${backendId}`);
          current.austerityBackend = backendId;
        }
        return current;
      });
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
