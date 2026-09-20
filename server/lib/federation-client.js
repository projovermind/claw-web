import { logger } from './logger.js';

/**
 * 연합(크로스호스트 위임)의 아웃바운드 HTTP 호출 — 헬스체크 / 위임 발주 / 결과 콜백.
 *
 * 모든 호출에 타임아웃이 걸린다. 원격이 죽어 있을 때 리드가 무한히 pending 으로
 * 남는 것이 이 기능의 가장 큰 실패 모드라, 발주는 특히 짧게(4초) 끊는다.
 */

/** 연합 엔드포인트가 처음 생긴 버전. 이보다 낮으면 위임을 보내지 않는다. */
export const FEDERATION_MIN_VERSION = '1.21.0';

const DELEGATE_TIMEOUT_MS = 4000;
const HEALTH_TIMEOUT_MS = 5000;
const CALLBACK_TIMEOUT_MS = 15_000;

/** 콜백 재시도 간격 — 스펙 고정값. 3회 모두 실패하면 포기하고 로그만 남긴다. */
export const CALLBACK_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

/** "1.21.0" >= "1.20.0" 같은 느슨한 semver 비교. 파싱 불가는 -1(더 낮음)로 본다. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').trim().replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  if (!Number.isFinite(pa[0])) return -1;
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 이 헬스 응답이 연합을 받을 수 있는 인스턴스의 것인가.
 * `federation: true` 를 명시하면 그것을 믿고, 없으면 버전으로 판정한다
 * (윈도우 v1.17.75 처럼 필드 자체가 없는 구버전 대응).
 */
export function supportsFederation(health) {
  if (!health || health.ok === false) return false;
  if (health.federation === true) return true;
  return compareVersions(health.version, FEDERATION_MIN_VERSION) >= 0;
}

function joinUrl(baseUrl, pathname) {
  return String(baseUrl).replace(/\/+$/, '') + pathname;
}

async function postJson(url, body, { token, originId, timeoutMs }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Claw-Origin': originId
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* 본문이 JSON 이 아닐 수 있다 */ }
  return { status: res.status, ok: res.ok, payload };
}

/**
 * 원격 `/api/health` 조회. 인증이 필요 없는 엔드포인트라 토큰 없이 부른다.
 * 실패도 정상 반환값으로 돌려준다 — 헬스체크가 throw 하면 UI 가 상태를 못 그린다.
 */
export async function checkInstanceHealth(baseUrl) {
  const startedAt = Date.now();
  try {
    const res = await fetch(joinUrl(baseUrl, '/api/health'), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, version: null, latencyMs, federation: false, error: `HTTP ${res.status}` };
    }
    const body = await res.json();
    return {
      ok: true,
      version: body?.version ?? null,
      latencyMs,
      federation: supportsFederation({ ok: true, version: body?.version, federation: body?.federation === true }),
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      version: null,
      latencyMs: Date.now() - startedAt,
      federation: false,
      error: err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? 'unreachable')
    };
  }
}

/**
 * 원격에 위임을 발주한다. 워커 완료를 기다리지 않고 접수 여부만 받는다.
 * @returns {{accepted:boolean, remoteSessionId?:string, error?:string}}
 */
export async function postDelegate(instance, originId, payload) {
  try {
    const { status, ok, payload: body } = await postJson(
      joinUrl(instance.baseUrl, '/api/federation/delegate'),
      payload,
      { token: instance.token, originId, timeoutMs: DELEGATE_TIMEOUT_MS }
    );
    if (ok && body?.accepted) {
      return { accepted: true, remoteSessionId: body.remoteSessionId ?? null, remoteInstance: body.remoteInstance ?? null };
    }
    return { accepted: false, error: body?.error ?? `HTTP ${status}` };
  } catch (err) {
    return { accepted: false, error: err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? 'unreachable') };
  }
}

/**
 * 결과 콜백을 origin 에 되돌려준다. 최대 3회 재시도(5s/30s/120s).
 * 전부 실패하면 로그만 남기고 포기한다 — origin 쪽 스톨 스윕이 회수한다.
 *
 * `sleep` 은 테스트에서 타이머를 즉시 흘려보내기 위한 주입점.
 */
export async function postCallback({ callbackUrl, token, originId, body, sleep = null }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  for (let attempt = 0; attempt <= CALLBACK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { ok, status } = await postJson(callbackUrl, body, {
        token, originId, timeoutMs: CALLBACK_TIMEOUT_MS
      });
      if (ok) return { delivered: true, attempts: attempt + 1 };
      // 4xx 는 재시도해도 같은 답이 온다 — 자격/대상 문제라 즉시 포기.
      if (status >= 400 && status < 500) {
        logger.warn({ callbackUrl, status, delegationId: body?.delegationId }, 'federation: 콜백 거절 — 재시도하지 않음');
        return { delivered: false, attempts: attempt + 1, error: `HTTP ${status}` };
      }
      if (attempt === CALLBACK_RETRY_DELAYS_MS.length) {
        return { delivered: false, attempts: attempt + 1, error: `HTTP ${status}` };
      }
    } catch (err) {
      if (attempt === CALLBACK_RETRY_DELAYS_MS.length) {
        return { delivered: false, attempts: attempt + 1, error: err?.message ?? 'unreachable' };
      }
    }
    await wait(CALLBACK_RETRY_DELAYS_MS[attempt]);
  }
  return { delivered: false, attempts: CALLBACK_RETRY_DELAYS_MS.length + 1, error: 'exhausted' };
}
