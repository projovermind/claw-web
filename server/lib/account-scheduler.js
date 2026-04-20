import { logger } from './logger.js';

const RATE_LIMIT_PATTERNS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /try\s*again\s*in/i,
  /5[\s-]hour\s*limit/i,
  /weekly\s*limit/i,
];

export function isRateLimitText(text) {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

/**
 * Parse cooldown expiry from rate-limit message text.
 * Falls back to 5 hours if no duration is found.
 */
export function parseRateLimitExpiry(text) {
  const hoursMatch = text.match(/try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*hour/i);
  if (hoursMatch) return Date.now() + parseFloat(hoursMatch[1]) * 3_600_000;

  const minsMatch = text.match(/try\s+again\s+in\s+(\d+)\s*min/i);
  if (minsMatch) return Date.now() + parseInt(minsMatch[1]) * 60_000;

  // Default: 5 hours
  return Date.now() + 5 * 3_600_000;
}

export function createAccountScheduler({ accountsStore }) {
  async function autoRestoreCooldowns() {
    const now = Date.now();
    for (const acc of accountsStore.getAll()) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && new Date(acc.cooldownUntil).getTime() <= now) {
        try {
          await accountsStore.update(acc.id, { status: 'active', cooldownUntil: null });
          logger.info({ accountId: acc.id }, '[scheduler] cooldown expired — restored to active');
        } catch (err) {
          logger.warn({ accountId: acc.id, err: err.message }, '[scheduler] cooldown restore failed');
        }
      }
    }
  }

  /**
   * Pick the best account for an agent run.
   * Priority:
   *   1. agent.accountId  — agent-level fixed account
   *   2. agent.projectAccountId — project-level fixed account
   *   3. active accounts, least recently used (round-robin)
   *   4. null → use default auth (no CLAUDE_CONFIG_DIR override)
   */
  function pickAccount(agent) {
    autoRestoreCooldowns().catch(() => {});

    if (agent.accountId) {
      const acc = accountsStore.getById(agent.accountId);
      if (acc && acc.status !== 'disabled') return acc;
    }

    if (agent.projectAccountId) {
      const acc = accountsStore.getById(agent.projectAccountId);
      if (acc && acc.status !== 'disabled') return acc;
    }

    const active = accountsStore
      .getAll()
      .filter((a) => a.status === 'active')
      .sort((a, b) => {
        if (!a.lastUsedAt) return -1;
        if (!b.lastUsedAt) return 1;
        return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
      });

    return active.length > 0 ? active[0] : null;
  }

  async function markUsed(accountId) {
    if (!accountId) return;
    try {
      await accountsStore.markUsed(accountId);
    } catch (err) {
      logger.warn({ accountId, err: err.message }, '[scheduler] markUsed failed');
    }
  }

  async function setCooldown(accountId, expiresAt) {
    if (!accountId) return;
    try {
      await accountsStore.setCooldown(accountId, expiresAt);
      logger.warn({ accountId, expiresAt }, '[scheduler] account cooldown set');
    } catch (err) {
      logger.warn({ accountId, err: err.message }, '[scheduler] setCooldown failed');
    }
  }

  /**
   * Pick the next available account excluding the given one.
   * Used immediately after rate-limit detection (before async cooldown persists).
   */
  function pickNextAccount(excludeId) {
    const active = accountsStore
      .getAll()
      .filter((a) => a.status === 'active' && a.id !== excludeId)
      .sort((a, b) => {
        if (!a.lastUsedAt) return -1;
        if (!b.lastUsedAt) return 1;
        return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
      });
    return active.length > 0 ? active[0] : null;
  }

  return { pickAccount, pickNextAccount, markUsed, setCooldown, isRateLimitText, parseRateLimitExpiry };
}
