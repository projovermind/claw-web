import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { inspectCreds } from './cred-inspector.js';
import { resolveConfigDir, ensureConfigDirSync } from './config-dir.js';

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
      // 우선순위: managed (per-backend secrets.json) > shell (process.env)
      let oauthStatus = 'unset';
      let oauthSource = 'none';
      if (b.type === 'claude-cli') {
        const oauthKey = 'CLAUDE_CODE_OAUTH_TOKEN';
        const managed = secretsStore?.hasOAuth?.(id) ?? false;
        if (managed) {
          oauthStatus = 'set';
          oauthSource = 'managed';
        } else if (process.env[oauthKey]) {
          oauthStatus = 'set';
          oauthSource = 'shell';
        }
      }

      // Claude CLI: configDir 미설정시 ~/.claude-claw/account-{id} 폴백 자동 적용.
      //  → 초보자가 configDir 설정 없이도 모든 인증 기능 사용 가능.
      //  실제 폴더는 inspectCreds 호출 전에 생성 (없으면 inspectCreds 가 has=false 반환)
      let effectiveConfigDir = null;
      let configDirAutoCreated = false;
      if (b.type === 'claude-cli') {
        effectiveConfigDir = resolveConfigDir(id, b.configDir);
        if (!b.configDir || !b.configDir.trim()) {
          configDirAutoCreated = true;
          ensureConfigDirSync(effectiveConfigDir); // 멱등 — 이미 있으면 no-op
        }
      }

      // Claude CLI: cred 정보(파일 존재 + 만료시각) 도 함께 노출 → UI 배지/상태 표시
      const cred = b.type === 'claude-cli'
        ? inspectCreds(effectiveConfigDir, { managedOAuth: oauthSource === 'managed' })
        : undefined;

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
        ...(b.type === 'claude-cli' ? {
          oauthStatus, oauthSource, cred,
          configDir: effectiveConfigDir,
          configDirAutoCreated,
          status: b.status ?? 'active', priority: b.priority ?? 50,
          lastUsedAt: b.lastUsedAt ?? null, usage: b.usage ?? null, cooldownUntil: b.cooldownUntil ?? null,
        } : {})
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
        if (id === 'claude' && current.backends?.[id]?.type === 'claude-cli') {
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

    async markUsed(id) {
      await writeWithLock((current) => {
        const b = current.backends?.[id];
        if (!b || b.type !== 'claude-cli') return current;
        const now = Date.now();
        const windowStart = b.usage?.windowStart ?? now;
        const windowAge = now - windowStart;
        current.backends[id] = {
          ...b,
          lastUsedAt: now,
          usage: {
            windowStart: windowAge > 3_600_000 ? now : windowStart,
            messagesUsed: windowAge > 3_600_000 ? 1 : (b.usage?.messagesUsed ?? 0) + 1,
          },
        };
        return current;
      });
    },

    async setCooldown(id, expiresAt) {
      await writeWithLock((current) => {
        if (!current.backends?.[id]) return current;
        current.backends[id] = {
          ...current.backends[id],
          status: 'cooldown',
          cooldownUntil: expiresAt,
        };
        return current;
      });
    },

    pickClaudeCliBackend() {
      const candidates = Object.entries(cache.backends ?? {})
        .filter(([, b]) =>
          b.type === 'claude-cli' &&
          b.status === 'active' &&
          (b.cooldownUntil == null || b.cooldownUntil < Date.now())
        )
        .map(([id, b]) => ({ id, ...b }));

      candidates.sort((a, b) => {
        const aUsed = a.lastUsedAt ?? 0;
        const bUsed = b.lastUsedAt ?? 0;
        if (aUsed !== bUsed) return aUsed - bUsed;
        return (b.priority ?? 50) - (a.priority ?? 50);
      });

      return candidates[0] ?? null;
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

    /**
     * Set or clear a managed OAuth token (CLAUDE_CODE_OAUTH_TOKEN) for a
     * claude-cli backend. The token is stored per-backend (does NOT touch
     * process.env to avoid collisions); the runner injects it at spawn time.
     */
    async setOAuthToken(id, token) {
      if (!secretsStore) throw new Error('secrets store not configured');
      const b = cache.backends?.[id];
      if (!b) throw new Error(`Unknown backend ${id}`);
      if (b.type !== 'claude-cli') throw new Error(`Backend ${id} is not claude-cli`);
      await secretsStore.setOAuth(id, token);
    },

    getOAuthToken(id) {
      return secretsStore?.getOAuth?.(id) ?? null;
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

    getSecretsFilePath: () => secretsStore?.getFilePath?.() ?? null,

    async close() {
      emitter.removeAllListeners();
    }
  };
}
