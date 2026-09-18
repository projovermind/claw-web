import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { inspectCreds, readClaudeCreds } from './cred-inspector.js';
import { resolveConfigDir, ensureConfigDirSync } from './config-dir.js';
import { DEFAULT_TIERS, normalizeTiers, migrateBackendTierModels } from './model-tiers.js';

const EMPTY = () => ({
  version: 1,
  activeBackend: 'claude',
  austerityMode: false,
  austerityBackend: 'zai',
  // 모델 티어 체계 — 에이전트는 급(order 의 한 항목)을 고르고, 백엔드가
  // tierModels 로 그 급의 실제 모델 ID 를 댄다. 이름/개수는 사용자가 바꿀 수 있다.
  tiers: DEFAULT_TIERS(),
  // 전역 폴백 — 어떤 백엔드가 실패했을 때 대신 쓸 백엔드. 백엔드별 `fallback`
  // 이 설정돼 있으면 그쪽이 우선한다. null 이면 폴백 없음.
  fallbackBackend: null,
  backends: {
    claude: {
      type: 'claude-cli',
      label: 'Claude (CLI)',
      envKey: null,
      models: {
        opus: 'claude-opus-4-6',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-sonnet-4-6'
      },
      tierModels: {
        high: 'claude-opus-4-6',
        middle: 'claude-sonnet-4-6',
        low: 'claude-sonnet-4-6'
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

  /**
   * 기존 파일에 티어 체계를 채워 넣는다. 멱등 — 이미 채워진 티어/order 는 건드리지
   * 않고, 보탤 것이 없으면 파일을 쓰지도 않는다(서버 재기동마다 쓰기 금지).
   */
  async function migrateTiers() {
    const current = cache;
    const needsTiers = !Array.isArray(current.tiers?.order) || current.tiers.order.length === 0;
    const patches = {};
    for (const [id, b] of Object.entries(current.backends ?? {})) {
      const next = migrateBackendTierModels(b);
      if (next) patches[id] = next;
    }
    if (!needsTiers && Object.keys(patches).length === 0) return;
    await writeWithLock((c) => {
      if (!Array.isArray(c.tiers?.order) || c.tiers.order.length === 0) c.tiers = DEFAULT_TIERS();
      for (const [id, tierModels] of Object.entries(patches)) {
        if (c.backends?.[id]) c.backends[id] = { ...c.backends[id], tierModels };
      }
      return c;
    });
  }

  await migrateTiers();

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
        tierModels: b.tierModels ?? {},
        contextWindows: b.contextWindows ?? {},
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
      fallbackBackend: cache.fallbackBackend ?? null,
      tiers: normalizeTiers(cache.tiers),
      backends
    };
  }

  return {
    getRaw: () => cache,
    getPublic: publicView,
    getBackend: (id) => cache.backends?.[id] ?? null,
    /** 이 백엔드에 저장된 managed OAuth 토큰(secrets.json 의 oauth.<id>). 없으면 null. */
    getOAuthToken: (id) => secretsStore?.getOAuth?.(id) ?? null,
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
        // 지운 백엔드를 가리키는 폴백 포인터는 같이 끊는다 — 남겨두면 폴백이
        // 매번 "Unknown backend" 로 조용히 실패한다.
        if (current.fallbackBackend === id) current.fallbackBackend = null;
        for (const [bid, b] of Object.entries(current.backends ?? {})) {
          if (b?.fallback === id) current.backends[bid] = { ...b, fallback: null };
        }
        // 티어 → 백엔드 포인터도 같이 끊는다. 남겨두면 그 티어를 쓰는 에이전트가
        // 매번 "등록되지 않은 백엔드" 경고를 내며 전역 백엔드로 샌다.
        for (const [tier, bid] of Object.entries(current.tiers?.backends ?? {})) {
          if (bid === id) delete current.tiers.backends[tier];
        }
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
      // 쿨다운 판정은 status 가 아니라 시각으로 한다. setCooldown 이 status 를
      // 'cooldown' 으로 바꿔놓는데 만료 후 'active' 로 되돌리는 주체가 없어서,
      // status 로 거르면 한 번 한도에 걸린 백엔드가 영영 자동 선택에서 빠진다.
      // cooldownUntil 은 ISO 문자열이라 숫자와 직접 비교하면 언제나 false 다.
      const now = Date.now();
      const cooling = (b) => {
        if (!b.cooldownUntil) return false;
        const until = new Date(b.cooldownUntil).getTime();
        return Number.isFinite(until) && until > now;
      };
      const candidates = Object.entries(cache.backends ?? {})
        .filter(([, b]) =>
          b.type === 'claude-cli' &&
          b.status !== 'disabled' &&
          !cooling(b)
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

    /**
     * Reveal a backend's raw stored secret value (env-style API key, e.g.
     * `sk-ant-api03-...` for Anthropic, ZAI/OpenAI keys etc).
     *
     * Returns null when no secret is stored. ONLY callers that have already
     * re-authenticated the user should expose this value to the browser.
     */
    getSecretValue(id) {
      if (!secretsStore?._getState) return null;
      const entry = secretsStore._getState().backends?.[id];
      if (!entry?.value) return null;
      return { envKey: entry.envKey, value: entry.value };
    },

    /**
     * For Claude CLI backends: read the raw OAuth credentials (accessToken /
     * refreshToken) from the backend's configDir/.credentials.json — or the
     * macOS Keychain if that's where the user actually stored them. Returns
     * null for non-claude-cli backends or when nothing is found.
     */
    getClaudeCliCreds(id) {
      const b = cache.backends?.[id];
      if (!b || b.type !== 'claude-cli') return null;
      const effectiveConfigDir = resolveConfigDir(id, b.configDir);
      return readClaudeCreds(effectiveConfigDir);
    },

    async setActive(backendId) {
      await writeWithLock((current) => {
        if (!current.backends?.[backendId]) throw new Error(`Unknown backend ${backendId}`);
        current.activeBackend = backendId;
        return current;
      });
    },

    /**
     * 전역 폴백 백엔드 지정 (null = 해제). 백엔드별 `fallback` 이 있으면 그것이
     * 우선하므로, 이 값은 "따로 지정하지 않은 모든 백엔드"의 폴백이 된다.
     */
    async setFallbackBackend(backendId) {
      await writeWithLock((current) => {
        if (backendId != null && !current.backends?.[backendId]) {
          throw new Error(`Unknown backend ${backendId}`);
        }
        current.fallbackBackend = backendId ?? null;
        return current;
      });
      return cache.fallbackBackend ?? null;
    },

    /**
     * 티어 체계(order + labels)를 통째로 교체한다. 추가/이름변경/삭제가 모두
     * 이 한 경로로 들어온다. 백엔드의 tierModels 는 건드리지 않는다 — 삭제한
     * 티어를 되살릴 때 매핑이 그대로 살아 있어야 한다.
     */
    async setTiers(tiers) {
      const next = normalizeTiers(tiers);
      await writeWithLock((current) => {
        current.tiers = next;
        return current;
      });
      return next;
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
