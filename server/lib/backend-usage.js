import crypto from 'node:crypto';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveConfigDir } from './config-dir.js';

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
 * ⚠️ accessToken 은 절대 반환값이나 로그에 담지 않는다.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
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
          email: acc.emailAddress ?? null,
          organization: acc.organizationName ?? null
        };
      }
    } catch { /* 다음 후보 */ }
  }
  return null;
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
    isEnabled: e.is_enabled === true,
    utilization: num(e.utilization),
    usedCredits: num(e.used_credits),
    monthlyLimit: num(e.monthly_limit),
    currency: typeof e.currency === 'string' ? e.currency : null
  };
}

/**
 * 하나의 백엔드에 대한 사용량 조회 (캐시 없음).
 * @returns {Promise<object>} 정규화된 결과. 실패해도 throw 하지 않는다.
 */
export async function fetchBackendUsage(id, backend, {
  fetchImpl = fetch,
  execFileAsync = execFileP,
  platform = process.platform,
  now = () => Date.now()
} = {}) {
  const fetchedAt = new Date(now()).toISOString();
  const base = {
    backendId: id,
    status: 'unsupported',
    fiveHour: null,
    sevenDay: null,
    extraUsage: null,
    account: null,
    fetchedAt
  };

  if (!backend || backend.type !== 'claude-cli') {
    return { ...base, reason: 'not a claude-cli backend' };
  }

  const configDir = resolveConfigDir(id, backend.configDir);
  const account = readAccountMeta(configDir);

  let creds = null;
  try {
    const credsFile = path.join(configDir, '.credentials.json');
    if (fssync.existsSync(credsFile)) {
      creds = parseCredsBlob(fssync.readFileSync(credsFile, 'utf8'));
    }
  } catch { /* keychain 으로 폴백 */ }

  if (!creds && platform === 'darwin') {
    try {
      const { stdout } = await readKeychain(keychainServiceName(configDir), execFileAsync);
      creds = parseCredsBlob(String(stdout).trim());
    } catch { /* 항목 없음 → no-credentials */ }
  }

  if (!creds) {
    return { ...base, status: 'no-credentials', account, reason: '이 백엔드의 configDir 에 로그인 자격증명이 없습니다' };
  }

  const acct = { ...(account ?? {}), subscriptionType: creds.subscriptionType ?? null };

  // 만료 토큰은 갱신하지 않는다 — refresh 는 Claude CLI 의 몫이고, 여기서
  // 돌리면 CLI 와 경합해 양쪽 토큰이 함께 무효화될 수 있다.
  if (creds.expiresAt && new Date(creds.expiresAt).getTime() <= now()) {
    return { ...base, status: 'expired', account: acct, expiresAt: creds.expiresAt };
  }

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
    return { ...base, status: 'error', account: acct, reason: err?.message ?? 'request failed' };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ...base,
      status: 'unauthorized',
      account: acct,
      httpStatus: res.status,
      reason: '토큰이 거부되었습니다 (user:profile 스코프가 없는 setup-token 일 수 있음)'
    };
  }
  if (!res.ok) {
    return { ...base, status: 'error', account: acct, httpStatus: res.status, reason: `HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ...base, status: 'error', account: acct, reason: 'invalid JSON response' };
  }

  return {
    backendId: id,
    status: 'ok',
    fiveHour: normalizeWindow(body?.five_hour),
    sevenDay: normalizeWindow(body?.seven_day),
    extraUsage: normalizeExtraUsage(body?.extra_usage),
    account: acct,
    fetchedAt
  };
}

/**
 * 60초 캐시 + in-flight 중복 제거를 얹은 리더.
 */
export function createBackendUsageReader({
  backendsStore,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  ...deps
} = {}) {
  const cache = new Map();   // id -> { at, value }
  const inflight = new Map(); // id -> Promise

  async function getOne(id, backend, { force = false } = {}) {
    if (!force) {
      const hit = cache.get(id);
      if (hit && now() - hit.at < ttlMs) return { ...hit.value, cached: true };
    }
    if (inflight.has(id)) return inflight.get(id);

    const p = fetchBackendUsage(id, backend, { ...deps, now })
      .then((value) => {
        cache.set(id, { at: now(), value });
        return value;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  return {
    getOne,
    async getAll({ force = false } = {}) {
      const backends = backendsStore?.getRaw?.().backends ?? {};
      const entries = await Promise.all(
        Object.entries(backends).map(async ([id, b]) => [id, await getOne(id, b, { force })])
      );
      return Object.fromEntries(entries);
    },
    clearCache() {
      cache.clear();
    }
  };
}
