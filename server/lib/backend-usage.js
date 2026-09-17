import crypto from 'node:crypto';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveConfigDir } from './config-dir.js';
import { logger } from './logger.js';

/**
 * 백엔드별 사용량(5시간 창 / 7일 창 / 추가 크레딧) 조회.
 *
 * 토큰 출처는 Claude CLI 가 쓰는 것과 동일하다:
 *   1. <configDir>/.credentials.json        (Linux / 구버전 macOS)
 *   2. macOS Keychain generic password      (현재 macOS 기본)
 *
 * Keychain 서비스명은 configDir 에서 파생된다. Claude CLI 는 기본 설정 디렉터리
 * (~/.claude) 를 쓸 때만 접미사 없는 "Claude Code-credentials" 를 쓰고, 그 외
 * 디렉터리에는 sha256(configDir) 앞 8자를 붙인다. 이 규칙 덕분에 멀티 계정이
 * 서로 다른 키체인 항목을 갖는다.
 *
 * ⚠️ secrets.json 의 oauth.* (setup-token 으로 발급) 은 여기에 쓸 수 없다.
 *    그 토큰에는 `user:profile` 스코프가 없어서 /api/oauth/usage 가 403 이다.
 *
 * 한도는 configDir 이 아니라 Anthropic 계정(accountUuid) 단위다. 그래서 어떤
 * 백엔드의 configDir 에 유효한 토큰이 없더라도, 같은 accountUuid 로 로그인한
 * 다른 configDir(기본 ~/.claude 포함)의 토큰으로 대신 조회한다
 * (tokenSource: 'shared'). 자기 토큰을 쓴 경우는 'self'.
 *
 * ⚠️ 토큰 refresh 는 절대 하지 않는다. 키체인의 refreshToken 은 1회용이라
 *    여기서 돌리면 Claude CLI 가 들고 있는 값이 무효화돼 CLI 로그인이 깨진다.
 *
 * ⚠️ accessToken 은 절대 반환값이나 로그에 담지 않는다.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 일시적 실패는 짧게만 캐시해서 빨리 재시도한다. */
const ERROR_TTL_MS = 10_000;
/** Retry-After 를 존중하되 이 이상은 기다리지 않는다. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
/**
 * 마지막 ok 값을 stale 로 대신 내주는 최대 기간. 실제 상한은 창이 리셋되는 시각
 * (fiveHour.resetsAt)이고, 그게 없거나 더 멀면 이 값에서 끊는다.
 */
const STALE_MAX_MS = 12 * 60 * 60_000;
/** 재시도로 회복될 수 있는 상태. 그 외(expired/no-credentials)는 재시도 주기를 평소대로 둔다. */
const TRANSIENT_STATUSES = new Set(['error', 'unauthorized']);
const execFileP = promisify(execFile);

/** Claude CLI 가 configDir 에 대해 사용하는 키체인 서비스명. */
export function keychainServiceName(configDir) {
  const base = 'Claude Code-credentials';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!configDir) return base;
  const resolved = path.resolve(configDir);
  if (home && resolved === path.join(path.resolve(home), '.claude')) return base;
  const hash = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function parseCredsBlob(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const token = data?.claudeAiOauth ?? data;
  if (!token || typeof token.accessToken !== 'string' || !token.accessToken) return null;
  let expiresAt = null;
  if (token.expiresAt) {
    const ms = token.expiresAt > 1e12 ? token.expiresAt : token.expiresAt * 1000;
    expiresAt = new Date(ms).toISOString();
  }
  return {
    accessToken: token.accessToken,
    expiresAt,
    scopes: Array.isArray(token.scopes) ? token.scopes : null,
    subscriptionType: token.subscriptionType ?? null
  };
}

function readKeychain(service, execFileAsync) {
  return execFileAsync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-w'],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1 << 20 }
  );
}

/**
 * oauthAccount 메타(이메일/조직)는 토큰이 아니라 .claude.json 에 평문으로 있다.
 * 커스텀 configDir 은 <configDir>/.claude.json 이지만, 기본 디렉터리(~/.claude)를
 * 쓰는 계정은 레거시 레이아웃이라 한 단계 위의 ~/.claude.json 에 있다.
 */
function readAccountMeta(configDir) {
  if (!configDir) return null;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [path.join(configDir, '.claude.json')];
  if (home && path.resolve(configDir) === path.join(path.resolve(home), '.claude')) {
    candidates.push(path.join(home, '.claude.json'));
  }
  for (const file of candidates) {
    try {
      const acc = JSON.parse(fssync.readFileSync(file, 'utf8'))?.oauthAccount;
      if (acc) {
        return {
          accountUuid: acc.accountUuid ?? null,
          email: acc.emailAddress ?? null,
          organization: acc.organizationName ?? null
        };
      }
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** 기본 계정의 configDir (~/.claude). 키체인 항목은 접미사가 없다. */
export function defaultConfigDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.claude') : null;
}

/**
 * 한 configDir 의 자격증명을 읽는다. credentials.json → 키체인 순.
 * 없으면 null. 토큰은 호출부 밖으로 새지 않도록 주의할 것.
 *
 * `credsCache` 를 주면 같은 라운드 안에서 configDir 당 한 번만 읽는다
 * (키체인 조회는 /usr/bin/security 프로세스를 하나씩 띄운다).
 */
async function readCredsFor(configDir, { execFileAsync = execFileP, platform = process.platform, credsCache } = {}) {
  // 값이 아니라 promise 를 캐시한다 — getAll 이 백엔드를 병렬로 도는 동안
  // 같은 configDir 을 두 번 읽어 security 프로세스를 중복으로 띄우지 않도록.
  if (credsCache?.has(configDir)) return credsCache.get(configDir);
  const p = readCredsUncached(configDir, { execFileAsync, platform });
  credsCache?.set(configDir, p);
  return p;
}

async function readCredsUncached(configDir, { execFileAsync, platform }) {
  try {
    const credsFile = path.join(configDir, '.credentials.json');
    if (fssync.existsSync(credsFile)) {
      const parsed = parseCredsBlob(fssync.readFileSync(credsFile, 'utf8'));
      if (parsed) return parsed;
    }
  } catch { /* 키체인으로 폴백 */ }

  if (platform !== 'darwin') return null;
  try {
    const { stdout } = await readKeychain(keychainServiceName(configDir), execFileAsync);
    return parseCredsBlob(String(stdout).trim());
  } catch {
    return null;
  }
}

/**
 * accountUuid → 유효한(미만료) 자격증명 풀을 만든다.
 *
 * 같은 Anthropic 계정으로 로그인한 configDir 이 여럿일 때, 그 중 하나라도
 * 살아 있는 토큰을 갖고 있으면 나머지 백엔드도 그 토큰으로 사용량을 볼 수 있다.
 * accountUuid 를 모르는 configDir(로그인 이력 없음)은 풀에 넣지 않는다 —
 * 남의 계정 숫자를 엉뚱한 백엔드에 붙이지 않기 위해서다.
 *
 * @returns {Promise<Map<string, {configDir: string, creds: object}>>}
 */
export async function buildCredentialPool(configDirs, {
  execFileAsync = execFileP,
  platform = process.platform,
  now = () => Date.now(),
  credsCache
} = {}) {
  const pool = new Map();
  const seen = new Set();
  for (const dir of configDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const uuid = readAccountMeta(dir)?.accountUuid;
    if (!uuid || pool.has(uuid)) continue;   // 이미 유효 토큰을 확보한 계정은 건너뜀
    const creds = await readCredsFor(dir, { execFileAsync, platform, credsCache });
    if (!creds) continue;
    if (creds.expiresAt && new Date(creds.expiresAt).getTime() <= now()) continue;
    pool.set(uuid, { configDir: dir, creds });
  }
  return pool;
}

/** 응답용 account. accountUuid 는 최상위 필드로만 노출한다(중복 방지). */
function toAccount(meta, tier) {
  if (!meta && tier == null) return null;
  return {
    email: meta?.email ?? null,
    organization: meta?.organization ?? null,
    tier: tier ?? null
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return {
    utilization: num(w.utilization),
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null
  };
}

function normalizeExtraUsage(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    enabled: e.is_enabled === true,
    utilization: num(e.utilization),
    usedCredits: num(e.used_credits),
    monthlyLimit: num(e.monthly_limit),
    currency: typeof e.currency === 'string' ? e.currency : null
  };
}

/**
 * 429 의 Retry-After 를 ms 로. 초 단위 숫자와 HTTP-date 를 모두 받는다.
 * 헤더가 없거나 해석 불가면 null.
 */
function parseRetryAfter(res, nowMs) {
  if (res?.status !== 429) return null;
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * 하나의 백엔드에 대한 사용량 조회 (캐시 없음).
 * @returns {Promise<object>} 정규화된 결과. 실패해도 throw 하지 않는다.
 */
export async function fetchBackendUsage(id, backend, {
  fetchImpl = fetch,
  execFileAsync = execFileP,
  platform = process.platform,
  now = () => Date.now(),
  /** accountUuid → 유효 자격증명 맵. 없으면 이 백엔드 + 기본 계정으로 즉석에서 만든다. */
  getPool,
  /** configDir → creds 라운드 캐시 (풀과 자기 토큰 조회가 중복되지 않게). */
  credsCache
} = {}) {
  const fetchedAt = new Date(now()).toISOString();
  const base = {
    backendId: id,
    status: 'unsupported',
    fiveHour: null,
    sevenDay: null,
    extraUsage: null,
    account: null,
    accountUuid: null,
    tokenSource: null,
    fetchedAt
  };

  if (!backend || backend.type !== 'claude-cli') {
    return { ...base, reason: 'not a claude-cli backend' };
  }

  const configDir = resolveConfigDir(id, backend.configDir);
  const account = readAccountMeta(configDir);
  const accountUuid = account?.accountUuid ?? null;
  const meta = { ...base, accountUuid };

  const ownCreds = await readCredsFor(configDir, { execFileAsync, platform, credsCache });
  const ownExpired = !!(ownCreds?.expiresAt && new Date(ownCreds.expiresAt).getTime() <= now());

  let creds = ownCreds && !ownExpired ? ownCreds : null;
  let tokenSource = creds ? 'self' : null;
  let sharedFrom = null;

  // 자기 토큰이 없거나 만료 — 한도는 계정 단위이므로 같은 accountUuid 로
  // 로그인한 다른 configDir 의 살아 있는 토큰으로 대신 조회한다.
  if (!creds && accountUuid) {
    const resolvePool = getPool ?? (() => buildCredentialPool(
      [configDir, defaultConfigDir()],
      { execFileAsync, platform, now, credsCache }
    ));
    const hit = (await resolvePool())?.get(accountUuid);
    if (hit && hit.configDir !== configDir) {
      creds = hit.creds;
      tokenSource = 'shared';
      sharedFrom = hit.configDir;
    }
  }

  if (!creds) {
    if (ownExpired) {
      // 대체 토큰도 없음 → 이 계정은 어디서도 유효한 세션이 없다. 갱신은 하지 않는다.
      return {
        ...meta,
        status: 'expired',
        account: toAccount(account, ownCreds.subscriptionType),
        expiresAt: ownCreds.expiresAt
      };
    }
    return {
      ...meta,
      status: 'no-credentials',
      account: account ? toAccount(account, null) : null,
      reason: accountUuid
        ? '이 계정으로 로그인한 configDir 중 유효한 토큰을 가진 곳이 없습니다'
        : '이 백엔드의 configDir 에 로그인 이력이 없습니다'
    };
  }

  const acct = toAccount(account, creds.subscriptionType);

  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    // err.message 는 토큰을 담지 않는다(요청 URL 만 포함).
    return { ...meta, status: 'error', account: acct, tokenSource, reason: err?.message ?? 'request failed' };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ...meta,
      status: 'unauthorized',
      account: acct,
      tokenSource,
      httpStatus: res.status,
      reason: '토큰이 거부되었습니다 (user:profile 스코프가 없는 setup-token 일 수 있음)'
    };
  }
  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res, now());
    return {
      ...meta,
      status: 'error',
      account: acct,
      tokenSource,
      httpStatus: res.status,
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
      reason: `HTTP ${res.status}`
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ...meta, status: 'error', account: acct, tokenSource, reason: 'invalid JSON response' };
  }

  return {
    backendId: id,
    status: 'ok',
    fiveHour: normalizeWindow(body?.five_hour),
    sevenDay: normalizeWindow(body?.seven_day),
    extraUsage: normalizeExtraUsage(body?.extra_usage),
    account: acct,
    accountUuid,
    tokenSource,
    // 어느 configDir 의 토큰을 빌려 왔는지 (경로만, 토큰은 아님)
    ...(sharedFrom ? { tokenSourceDir: sharedFrom } : {}),
    fetchedAt
  };
}

/**
 * 60초 캐시 + in-flight 중복 제거를 얹은 리더.
 *
 * 실패는 성공과 다르게 다룬다: 어떤 실패든 직전 ok 값을 덮어쓰지 않고 stale:true 로
 * 대신 내준다(창 리셋 시각까지, 최대 12시간). 토큰이 만료되거나 로그아웃돼도 한도
 * 자체는 그대로이므로, 게이지를 비우는 대신 마지막으로 본 숫자를 staleStatus 와 함께
 * 보여 주는 편이 낫다. 재시도 주기는 그대로다 — error/unauthorized 는 10초
 * (429 면 Retry-After), 그 외는 평소 ttl.
 *
 * lastOk 는 persistPath 에 저장돼 재기동 후에도 게이지가 유지된다.
 */
export function createBackendUsageReader({
  backendsStore,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  /** lastOk 영속화 경로 (data/user/backend-usage-last.json). 없으면 메모리에만 둔다. */
  persistPath = null,
  ...deps
} = {}) {
  const cache = new Map();   // id -> { at, value, ttl }
  const lastOk = new Map();  // id -> { at, value } — 실패 시 대신 내줄 직전 성공값
  const inflight = new Map(); // id -> Promise

  /**
   * 재기동 후에도 게이지를 유지하려고 마지막 ok 값을 파일에 남긴다.
   * 손상/부재는 조용히 무시한다 — 캐시일 뿐이고, 없으면 첫 조회가 채운다.
   */
  function loadLastOk() {
    if (!persistPath) return;
    try {
      const parsed = JSON.parse(fssync.readFileSync(persistPath, 'utf8'));
      for (const [id, entry] of Object.entries(parsed?.backends ?? {})) {
        if (Number.isFinite(entry?.at) && entry?.value?.status === 'ok') {
          lastOk.set(id, { at: entry.at, value: entry.value });
        }
      }
    } catch { /* 캐시 없음 또는 손상 */ }
  }

  function saveLastOk() {
    if (!persistPath) return;
    try {
      fssync.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmp = `${persistPath}.tmp`;
      fssync.writeFileSync(tmp, JSON.stringify({ version: 1, backends: Object.fromEntries(lastOk) }));
      fssync.renameSync(tmp, persistPath);
    } catch (err) {
      logger.warn({ persistPath, err: err.message }, 'backend-usage: lastOk 저장 실패');
    }
  }

  loadLastOk();

  /**
   * 등록된 모든 claude-cli 백엔드의 configDir + 기본 계정(~/.claude).
   * 한 라운드에서 계정 공유 토큰을 찾는 후보 목록이다.
   */
  function candidateConfigDirs() {
    const backends = backendsStore?.getRaw?.().backends ?? {};
    const dirs = Object.entries(backends)
      .filter(([, b]) => b?.type === 'claude-cli')
      .map(([id, b]) => resolveConfigDir(id, b.configDir));
    const fallback = defaultConfigDir();
    if (fallback) dirs.push(fallback);
    return dirs;
  }

  /**
   * 풀은 한 라운드에 한 번만 만든다(키체인 조회가 configDir 당 1회).
   * 전부 캐시 히트면 아예 만들지 않도록 지연 생성한다.
   */
  function newRound() {
    const credsCache = new Map();
    let promise = null;
    const getPool = () => (promise ??= buildCredentialPool(
      candidateConfigDirs(), { ...deps, now, credsCache }
    ));
    return { getPool, credsCache };
  }

  /**
   * stale 로 대신 내줄 수 있는 마지막 시각.
   * 창이 리셋되면 옛 숫자는 의미가 없으므로 resetsAt 에서 끊고, 그게 없거나
   * 12시간보다 멀면 STALE_MAX_MS 에서 끊는다.
   */
  function staleUntil(prev) {
    const cap = prev.at + STALE_MAX_MS;
    const resets = prev.value?.fiveHour?.resetsAt ?? prev.value?.sevenDay?.resetsAt ?? null;
    const at = resets ? Date.parse(resets) : NaN;
    if (Number.isNaN(at) || at <= prev.at) return cap;
    return Math.min(at, cap);
  }

  /**
   * 실패는 직전 ok 값을 stale 로 대신 내준다. 그래야 API 가 흔들리거나 토큰이
   * 만료돼도 UI 에서 한도 게이지가 통째로 사라지지 않는다. 실제 실패 사유는
   * staleStatus/staleReason 으로 남는다.
   */
  function staleOr(id, failure) {
    const prev = lastOk.get(id);
    if (!prev) return failure;
    const at = now();
    if (at > staleUntil(prev)) {
      lastOk.delete(id);
      saveLastOk();
      return failure;
    }
    return {
      ...prev.value,
      stale: true,
      staleAgeMs: at - prev.at,
      staleStatus: failure.status,
      staleReason: failure.reason ?? null
    };
  }

  /** 결과를 캐시에 반영하고, 호출자에게 실제로 내줄 값을 돌려준다. */
  function record(id, value) {
    const at = now();
    if (value.status === 'ok') {
      lastOk.set(id, { at, value });
      saveLastOk();
      cache.set(id, { at, value, ttl: ttlMs });
      return value;
    }
    const served = staleOr(id, value);
    // 재시도 주기는 상태에 따라 다르다 — 일시적 실패만 짧게 잡고 빨리 되묻는다.
    const ttl = TRANSIENT_STATUSES.has(value.status)
      ? Math.min(Math.max(value.retryAfterMs ?? ERROR_TTL_MS, ERROR_TTL_MS), MAX_RETRY_AFTER_MS)
      : ttlMs;
    cache.set(id, { at, value: served, ttl });
    return served;
  }

  async function getOne(id, backend, { force = false, round } = {}) {
    if (!force) {
      const hit = cache.get(id);
      if (hit && now() - hit.at < hit.ttl) return { ...hit.value, cached: true };
    }
    if (inflight.has(id)) return inflight.get(id);

    const { getPool, credsCache } = round ?? newRound();
    const p = fetchBackendUsage(id, backend, { ...deps, now, getPool, credsCache })
      .then((value) => record(id, value))
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  return {
    getOne,
    async getAll({ force = false } = {}) {
      const backends = backendsStore?.getRaw?.().backends ?? {};
      const round = newRound();
      const entries = await Promise.all(
        Object.entries(backends).map(async ([id, b]) => [id, await getOne(id, b, { force, round })])
      );
      return Object.fromEntries(entries);
    },
    clearCache() {
      cache.clear();
      lastOk.clear();
      saveLastOk();
    }
  };
}
