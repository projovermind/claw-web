/**
 * accounts-store — thin wrapper over backends-store (claude-cli backends).
 * Maintains backward-compatible API for account-scheduler and accounts router.
 */
import { nanoid } from 'nanoid';

const newId = () => `acc_${nanoid(12)}`;

/** Convert epoch ms or ISO string to ISO string, or null. */
function toIso(val) {
  if (val == null) return null;
  if (typeof val === 'number') return new Date(val).toISOString();
  return val;
}

/** Convert a claude-cli backend entry to the "account" shape expected by callers. */
function toAccount(id, b) {
  const cooldownUntil = b.cooldownUntil ?? null;
  const cooldownRemaining = (cooldownUntil && cooldownUntil > Date.now())
    ? Math.ceil((cooldownUntil - Date.now()) / 1000)
    : null;
  const usage = b.usage ?? { windowStart: null, messagesUsed: 0 };
  return {
    id,
    label: b.label ?? id,
    configDir: b.configDir ?? null,
    status: b.status ?? 'active',
    lastUsedAt: toIso(b.lastUsedAt),
    usage: { windowStart: toIso(usage.windowStart), messagesUsed: usage.messagesUsed ?? 0 },
    priority: b.priority ?? 50,
    cooldownUntil,
    cooldownRemaining,
    createdAt: b.createdAt ?? null,
    updatedAt: b.updatedAt ?? null,
  };
}

export async function createAccountsStore(_filePath, { backendsStore } = {}) {
  if (!backendsStore) {
    throw new Error('createAccountsStore requires backendsStore option');
  }

  function getAllClaudeCliBackends() {
    const raw = backendsStore.getRaw();
    return Object.entries(raw.backends ?? {})
      .filter(([, b]) => b.type === 'claude-cli')
      .map(([id, b]) => toAccount(id, b));
  }

  return {
    getAll: () => getAllClaudeCliBackends(),

    getById: (id) => {
      const b = backendsStore.getBackend(id);
      if (!b || b.type !== 'claude-cli') return null;
      return toAccount(id, b);
    },

    async create({ label, configDir, priority = 50, models = {}, status = 'disabled' }) {
      const id = newId();
      const now = new Date().toISOString();
      await backendsStore.createBackend(id, {
        type: 'claude-cli',
        label,
        configDir: configDir ?? null,
        status,  // 기본 disabled — 로그인 후 수동 활성화
        lastUsedAt: null,
        usage: { windowStart: null, messagesUsed: 0 },
        priority,
        cooldownUntil: null,
        models: models ?? {},
        createdAt: now,
        updatedAt: now,
      });
      const b = backendsStore.getBackend(id);
      return toAccount(id, b);
    },

    async update(id, patch) {
      const existing = backendsStore.getBackend(id);
      if (!existing || existing.type !== 'claude-cli') {
        throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
      }
      const updated = await backendsStore.updateBackend(id, {
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      return toAccount(id, updated ?? backendsStore.getBackend(id));
    },

    async delete(id) {
      const existing = backendsStore.getBackend(id);
      if (!existing || existing.type !== 'claude-cli') {
        throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
      }
      await backendsStore.deleteBackend(id);
    },

    // Alias for compatibility
    async remove(id) {
      return this.delete(id);
    },

    async markUsed(id) {
      await backendsStore.markUsed(id);
    },

    async setCooldown(id, expiresAt) {
      await backendsStore.setCooldown(id, expiresAt);
    },
  };
}
