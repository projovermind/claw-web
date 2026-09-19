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
  // 2026-09 CLI 문구: "You've hit your session limit · resets 1:40am (Asia/Seoul)"
  // 이 패턴이 없어서 한도가 감지되지 않고 폴백도 안 돌았다.
  /session\s*limit/i,
  /hit\s+your\s+\w*\s*limit/i,
];

export function isRateLimitText(text) {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
/** CLI 한도 문구의 시각은 Asia/Seoul 로 찍힌다. 서버 TZ 와 무관하게 이 오프셋으로 해석한다. */
const SEOUL_OFFSET_MS = 9 * 3_600_000;
const WEEKLY_LIMIT_RE = /weekly\s*limit/i;
/** 주간 한도인데 리셋 시각을 못 읽었을 때의 하한. 5시간은 턱없이 짧아 한 턴씩 태운다. */
const WEEKLY_FALLBACK_MS = 24 * 3_600_000;

/**
 * "resets Sep 21 at 10am (Asia/Seoul)" 처럼 날짜가 붙은 리셋 시각 → epoch ms.
 * 문구에 연도가 없으므로 현재 연도로 보고, 하루 이상 과거면 다음 해로 민다
 * (12월 말에 "Jan 3" 가 오는 경우).
 */
function parseSeoulDatedReset(text, nowMs) {
  const m = text.match(
    /resets\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
  );
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[2], 10);
  let hour = parseInt(m[3], 10) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const minute = m[4] ? parseInt(m[4], 10) : 0;
  const year = new Date(nowMs + SEOUL_OFFSET_MS).getUTCFullYear();
  const at = Date.UTC(year, month, day, hour, minute) - SEOUL_OFFSET_MS;
  if (!Number.isFinite(at)) return null;
  if (at < nowMs - 86_400_000) {
    return Date.UTC(year + 1, month, day, hour, minute) - SEOUL_OFFSET_MS;
  }
  return at;
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

  // "resets Sep 21 at 10am (Asia/Seoul)" — 주간 한도가 쓰는 날짜 포함 형식.
  // 이걸 못 읽어서 기본 5시간으로 떨어지면 리셋 전에 계속 깨어나 한 턴씩 태웠다.
  const dated = parseSeoulDatedReset(text, Date.now());
  if (dated) return dated;

  // "resets 1:40am (Asia/Seoul)" — 시각만 있는 경우. 서버 로컬 시각(KST)으로 해석하고
  // 이미 지난 시각이면 다음 날로 본다. 날짜가 붙은 형식(주간 한도 등)은 기본값으로 떨어진다.
  const resetMatch = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (resetMatch) {
    let hour = parseInt(resetMatch[1]) % 12;
    if (resetMatch[3].toLowerCase() === 'pm') hour += 12;
    const at = new Date();
    at.setHours(hour, resetMatch[2] ? parseInt(resetMatch[2]) : 0, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }

  // Default: 5 hours — 단, 주간 한도 문구면 최소 24시간. 주간 창이 5시간 뒤에
  // 열릴 리 없으므로 그때 복구하면 곧바로 다시 한도에 걸린다.
  if (WEEKLY_LIMIT_RE.test(text)) return Date.now() + WEEKLY_FALLBACK_MS;
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

export function createAccountScheduler({ accountsStore, backendsStore, usageReader = null }) {
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

  /**
   * 쿨다운이 만료돼도 실제 잔량이 0 이면 되살리면 안 된다. 주간 한도는 쿨다운 시각을
   * 짧게 잡기 쉬운데, 그대로 복구하면 5시간마다 한 턴씩 태우고 곧바로 다시 걸린다.
   * 사용량 API 의 sevenDay.utilization 이 100 이고 resetsAt 이 미래면 그 시각을 돌려준다
   * (= 그때까지 쿨다운 연장, 복구 보류). 조회 실패는 null → 기존대로 복구한다.
   */
  async function exhaustedUntil(id, configDir) {
    if (!usageReader?.getOne) return null;
    try {
      const backend = backendsStore?.getBackend?.(id)
        ?? { type: 'claude-cli', configDir: configDir ?? null };
      const usage = await usageReader.getOne(id, backend);
      const util = Number(usage?.sevenDay?.utilization);
      if (!Number.isFinite(util) || util < 100) return null;
      const week = usage.sevenDay;
      const at = week.resetsAt ? Date.parse(week.resetsAt) : NaN;
      return Number.isFinite(at) && at > Date.now() ? at : null;
    } catch (err) {
      logger.warn({ backendId: id, err: err.message }, '[scheduler] usage check failed — restoring anyway');
      return null;
    }
  }

  /** 쿨다운 연장. 복구 대신 실제 리셋 시각까지 미룬다. */
  async function extendCooldown(id, untilMs, update) {
    const cooldownUntil = new Date(untilMs).toISOString();
    try {
      await update(id, { status: 'cooldown', cooldownUntil });
      logger.warn(
        { backendId: id, cooldownUntil },
        '[scheduler] weekly quota still exhausted — cooldown extended instead of restoring'
      );
    } catch (err) {
      logger.warn({ backendId: id, err: err.message }, '[scheduler] cooldown extend failed');
    }
  }

  async function autoRestoreCooldowns() {
    const now = Date.now();
    for (const acc of accountsStore.getAll()) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && new Date(acc.cooldownUntil).getTime() <= now) {
        const stillOut = await exhaustedUntil(acc.id, acc.configDir);
        if (stillOut) {
          await extendCooldown(acc.id, stillOut, (id, patch) => accountsStore.update(id, patch));
          continue;
        }
        try {
          await accountsStore.update(acc.id, { status: 'active', cooldownUntil: null });
          logger.info({ accountId: acc.id }, '[scheduler] cooldown expired — restored to active');
        } catch (err) {
          logger.warn({ accountId: acc.id, err: err.message }, '[scheduler] cooldown restore failed');
        }
      }
    }

    // 백엔드 쪽도 같이 되돌린다. setCooldown 이 status 를 'cooldown' 으로 바꾸는데
    // 복구하는 주체가 없으면 UI 배지가 만료 후에도 '쿨다운' 으로 남는다.
    for (const [id, b] of Object.entries(backendsStore?.getRaw?.()?.backends ?? {})) {
      if (b.status !== 'cooldown') continue;
      const until = b.cooldownUntil ? new Date(b.cooldownUntil).getTime() : 0;
      if (Number.isFinite(until) && until > now) continue;
      const stillOut = await exhaustedUntil(id, b.configDir);
      if (stillOut) {
        await extendCooldown(id, stillOut, (bid, patch) => backendsStore.updateBackend(bid, patch));
        continue;
      }
      try {
        await backendsStore.updateBackend(id, { status: 'active', cooldownUntil: null });
        logger.info({ backendId: id }, '[scheduler] backend cooldown expired — restored to active');
      } catch (err) {
        logger.warn({ backendId: id, err: err.message }, '[scheduler] backend cooldown restore failed');
      }
    }
  }

  /**
   * 쿨다운 중인지. cooldownUntil 은 저장 경로에 따라 epoch ms(숫자) 또는 ISO 문자열이라
   * 둘 다 받아 넘긴다. 파싱 불가/미설정이면 쿨다운 아님으로 본다.
   */
  function isCoolingDown(backend) {
    if (!backend?.cooldownUntil) return false;
    const until = new Date(backend.cooldownUntil).getTime();
    return Number.isFinite(until) && until > Date.now();
  }

  /**
   * 쿨다운에 걸린 지정 백엔드 대신 쓸 폴백을 고른다.
   * 우선순위: 해당 백엔드의 fallback > 전역 fallbackBackend.
   * 자기 자신/미등록/비활성/쿨다운 중인 폴백은 무시 → 호출자가 다음 단계로 내려간다.
   */
  function cooldownFallbackFor(backendId, backendObj) {
    if (!backendsStore) return null;
    const raw = backendsStore.getRaw?.() ?? null;
    const fallbackId = backendObj?.fallback || raw?.fallbackBackend || null;
    if (!fallbackId || fallbackId === backendId) return null;
    const fb = backendsStore.getBackend(fallbackId);
    if (!fb || fb.status === 'disabled' || isCoolingDown(fb)) {
      logger.warn({ backendId, fallbackId }, '[scheduler] cooldown fallback unusable — falling through');
      return null;
    }
    logger.warn({ backendId, fallbackId }, '[scheduler] specified backend is cooling down — switching to fallback');
    return { ...fb, id: fallbackId };
  }

  /**
   * 지정 백엔드 하나를 검증해서 쓸 수 있는 형태로 돌려준다.
   * 쿨다운이면 폴백으로 선회하고, 폴백도 못 쓰면 null (호출자가 다음 우선순위로).
   */
  function resolveSpecifiedBackend(backendId) {
    if (!backendId || !backendsStore) return null;
    const b = backendsStore.getBackend(backendId);
    if (!b || b.status === 'disabled') return null;
    if (!isCoolingDown(b)) return { ...b, id: backendId };
    return cooldownFallbackFor(backendId, b);
  }

  /**
   * 전역 activeBackend(설정 화면의 "활성 백엔드")를 쓸 수 있으면 돌려준다.
   * 지정 백엔드가 없을 때 LRU 라운드로빈보다 먼저 본다 — 그러지 않으면 메인 계정이
   * 멀쩡한데도 lastUsedAt 순서 때문에 서브 계정으로 새어 나간다.
   * claude-cli 타입 · 쿨다운 아님 · 인증 있음을 모두 만족해야 하고, 하나라도
   * 어긋나면 null 을 돌려 호출자가 라운드로빈으로 내려가게 한다(서브가 자동 승계).
   */
  function resolveGlobalActiveBackend() {
    if (!backendsStore) return null;
    const id = backendsStore.getRaw?.()?.activeBackend ?? null;
    if (!id) return null;
    const b = backendsStore.getBackend?.(id);
    if (!b || b.type !== 'claude-cli' || b.status === 'disabled') return null;
    if (isCoolingDown(b)) {
      logger.info({ backendId: id }, '[scheduler] active backend is cooling down — handing over to round-robin');
      return null;
    }
    if (!hasAuth({ id, configDir: b.configDir ?? null })) {
      logger.warn({ backendId: id }, '[scheduler] active backend has no credentials — handing over to round-robin');
      return null;
    }
    return { ...b, id };
  }

  /**
   * Pick the best backend for an agent run.
   * Priority:
   *   1. agent.backendId  — agent-level fixed backend (쿨다운이면 그 백엔드의 폴백)
   *   2. project.backendId — project-level fixed backend (동일)
   *   3. 전역 activeBackend — 쓸 수 있으면 그것
   *   4. backendsStore.pickClaudeCliBackend() — least recently used active backend
   *   5. null → use default auth (no CLAUDE_CONFIG_DIR override)
   */
  function pickBackend(agent, project) {
    const specified = resolveSpecifiedBackend(agent.backendId ?? agent.accountId ?? null);
    if (specified) return specified;

    const projectPicked = resolveSpecifiedBackend(project?.backendId ?? project?.accountId ?? null);
    if (projectPicked) return projectPicked;

    const globalActive = resolveGlobalActiveBackend();
    if (globalActive) return globalActive;

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
   *   3. sessionId 힌트 — 그 세션 파일을 가진 계정 (이어가기)
   *   4. 전역 activeBackend — 쓸 수 있으면 그것
   *   5. active accounts, least recently used (round-robin)
   *   6. null → use default auth (no CLAUDE_CONFIG_DIR override)
   */
  function pickAccount(agent, { sessionId = null, findSession = null } = {}) {
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

    // sessionId 힌트: 해당 세션 파일을 가진 계정 우선 선택 (라운드로빈 대신)
    if (sessionId && findSession && active.length > 0) {
      const sessionOwner = active.find((acc) => findSession(agent.workingDir, sessionId, acc.configDir ?? null));
      if (sessionOwner) {
        logger.info(
          { accountId: sessionOwner.id, sessionId },
          '[scheduler] pickAccount: session file matched — skipping round-robin'
        );
        return sessionOwner;
      }
    }

    // 4. 전역 activeBackend — 라운드로빈보다 먼저 본다.
    //    (이어가는 세션이 있으면 위에서 이미 그 계정으로 빠진 뒤다)
    const globalActive = resolveGlobalActiveBackend();
    if (globalActive) {
      logger.info(
        { agentId: agent.id, backendId: globalActive.id },
        '[scheduler] pickAccount: using global active backend'
      );
      return accountsStore.getById(globalActive.id)
        ?? { id: globalActive.id, configDir: globalActive.configDir ?? null };
    }

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

  return { pickAccount, pickBackend, pickNextAccount, pickNextBackend, markUsed, setCooldown, autoRestoreCooldowns, isRateLimitText, parseRateLimitExpiry };
}
