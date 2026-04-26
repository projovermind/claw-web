import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

/**
 * configDir에 로그인된 계정이 있는지 확인.
 * Claude CLI 인증 방식 2가지를 모두 지원:
 *   - 구형: .credentials.json
 *   - 신형: .claude.json 안의 oauthAccount 필드
 * configDir이 null/빈 문자열이면 기본 ~/.claude/ 사용 → 항상 통과.
 */
function hasCredentials(configDir) {
  if (!configDir) return true; // 기본 claude 계정 — 별도 configDir 없음
  try {
    // 구형 credentials 파일
    if (fssync.existsSync(path.join(configDir, '.credentials.json'))) return true;
    // 신형 .claude.json + oauthAccount
    const claudeJson = path.join(configDir, '.claude.json');
    if (fssync.existsSync(claudeJson)) {
      const raw = fssync.readFileSync(claudeJson, 'utf8');
      const data = JSON.parse(raw);
      if (data?.oauthAccount?.accountUuid) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 기본 Claude CLI 계정(~/.claude/) 존재 여부 확인.
 */
function defaultClaudeHasCredentials() {
  return hasCredentials(path.join(os.homedir(), '.claude'));
}

export function createAccountScheduler({ accountsStore, backendsStore }) {
  /**
   * 인증 가능 여부 — 다음 중 하나라도 만족하면 true:
   *   1. backend 에 managed OAuth 토큰이 저장돼 있음 (secrets.json)
   *   2. configDir 에 .credentials.json 또는 oauthAccount 가 있음
   *   3. configDir 미지정 (기본 ~/.claude/ 사용)
   */
  function hasAuth(idAndConfigDir) {
    const id = idAndConfigDir?.id;
    const configDir = idAndConfigDir?.configDir ?? null;
    if (id && backendsStore?.getOAuthToken?.(id)) return true;
    return hasCredentials(configDir);
  }

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
   * Pick the best backend for an agent run.
   * Priority:
   *   1. agent.backendId  — agent-level fixed backend
   *   2. project.backendId — project-level fixed backend
   *   3. backendsStore.pickClaudeCliBackend() — least recently used active backend
   *   4. null → use default auth (no CLAUDE_CONFIG_DIR override)
   */
  function pickBackend(agent, project) {
    const backendId = agent.backendId ?? agent.accountId ?? null;
    if (backendId && backendsStore) {
      const b = backendsStore.getBackend(backendId);
      if (b && b.status !== 'disabled') return { ...b, id: backendId };
    }

    const projectBackendId = project?.backendId ?? project?.accountId ?? null;
    if (projectBackendId && backendsStore) {
      const b = backendsStore.getBackend(projectBackendId);
      if (b && b.status !== 'disabled') return { ...b, id: projectBackendId };
    }

    if (backendsStore) {
      const b = backendsStore.pickClaudeCliBackend();
      if (b) return b;
    }

    return null;
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

    // 1. 에이전트 명시 accountId
    if (agent.accountId) {
      const acc = accountsStore.getById(agent.accountId);
      if (acc && acc.status !== 'disabled' && hasAuth(acc)) return acc;
    }

    // 2. backendId가 claude-cli 타입 계정이면 해당 계정 직접 사용
    //    (AgentModal "AI 회사" 드롭다운에서 서브계정 선택한 경우)
    //    ⚠️ disabled 상태여도 사용 — disabled는 "자동선택 제외"이지 "사용 금지"가 아님.
    //       에이전트가 명시적으로 지정한 경우 반드시 해당 계정을 사용해야 함.
    if (agent.backendId && backendsStore) {
      const b = backendsStore.getBackend(agent.backendId);
      if (b?.type === 'claude-cli') {
        if (hasAuth({ id: agent.backendId, configDir: b.configDir })) {
          // accountsStore 에서 찾거나 직접 configDir 포함 객체 반환
          const acc = accountsStore.getById(agent.backendId);
          logger.info(
            { agentId: agent.id, backendId: agent.backendId, status: b.status, configDir: b.configDir, oauth: !!backendsStore.getOAuthToken?.(agent.backendId) },
            '[scheduler] using explicitly specified claude-cli backend'
          );
          return acc ?? { id: agent.backendId, configDir: b.configDir ?? null };
        } else {
          logger.warn(
            { agentId: agent.id, backendId: agent.backendId, configDir: b.configDir },
            '[scheduler] selected claude-cli backend has no credentials — falling back to default'
          );
          // credentials 없으면 fallback: configDir 없이 기본 계정 사용
          return { id: agent.backendId, configDir: null };
        }
      }
    }

    // 3. 프로젝트 레벨 accountId
    if (agent.projectAccountId) {
      const acc = accountsStore.getById(agent.projectAccountId);
      if (acc && acc.status !== 'disabled' && hasAuth(acc)) return acc;
    }

    const active = accountsStore
      .getAll()
      .filter((a) => {
        if (a.status !== 'active') return false;
        // managed OAuth 토큰이 있으면 configDir 무관하게 사용 가능
        if (backendsStore?.getOAuthToken?.(a.id)) return true;
        // configDir이 있는 서브계정은 credentials.json 있어야 사용 가능
        if (a.configDir && !hasCredentials(a.configDir)) {
          logger.warn({ accountId: a.id, configDir: a.configDir },
            '[scheduler] skipping account — no .credentials.json (run /login first)');
          return false;
        }
        // 기본 claude 계정(configDir 없음)도 credentials 확인
        if (!a.configDir && !defaultClaudeHasCredentials()) {
          logger.warn({ accountId: a.id }, '[scheduler] skipping default claude — no .credentials.json');
          return false;
        }
        return true;
      })
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

  // pickNextBackend is an alias for pickNextAccount (backward compat)
  const pickNextBackend = pickNextAccount;

  return { pickAccount, pickBackend, pickNextAccount, pickNextBackend, markUsed, setCooldown, isRateLimitText, parseRateLimitExpiry };
}
