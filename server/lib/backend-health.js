/**
 * 백엔드를 지금 실행에 쓸 수 있는지 판정한다.
 *
 * 폴백 대상은 "등록돼 있다"는 것만 확인하고 그대로 실행됐다. 그래서 주간 한도가
 * 소진돼 쿨다운에 들어간 서브 계정으로도 폴백이 나갔고, 메인 백엔드는 멀쩡한데
 * 사용자 화면에는 서브 계정의 weekly limit 문구가 떴다.
 */

/** 실행 자체가 불가능한 상태값. */
const UNUSABLE_STATUSES = new Set(['disabled', 'needs-relogin']);

/**
 * @returns {'missing'|'disabled'|'needs-relogin'|'cooldown'|null} 못 쓰는 이유, 쓸 수 있으면 null.
 */
export function backendUnhealthyReason(backend, now = Date.now()) {
  if (!backend) return 'missing';
  if (UNUSABLE_STATUSES.has(backend.status)) return backend.status;
  // 쿨다운은 status 가 아니라 시각으로 판정한다 — 만료 복구가 늦어 status 만 'cooldown'
  // 으로 남아 있는 백엔드까지 막으면 멀쩡한 폴백이 영영 안 쓰인다.
  if (backend.cooldownUntil) {
    const until = new Date(backend.cooldownUntil).getTime();
    if (Number.isFinite(until) && until > now) return 'cooldown';
  }
  return null;
}
