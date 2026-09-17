import type { BackendsState, ModelTiers } from './types';

/**
 * 서버가 아직 tiers 를 안 내려줄 때 쓰는 기본 티어.
 * 라벨은 키 그대로 — 실제 이름은 설정 > 백엔드 > Global 에서 사용자가 정한다.
 */
export const DEFAULT_TIERS: ModelTiers = {
  order: ['high', 'middle', 'low'],
  labels: { high: '상 (고성능)', middle: '중 (균형)', low: '하 (경량)' },
  backends: {}
};

/**
 * 티어별 백엔드 맵 정규화. order 에 없는 티어, 빈 문자열, 문자열이 아닌 값은 전부
 * 버리고 null(= 전역 따름)로 통일한다. 서버가 아직 이 필드를 안 내려줘도 `{}` 가 나온다.
 */
function normalizeTierBackends(
  raw: Record<string, string | null> | undefined,
  order: string[]
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const tier of order) {
    const v = raw?.[tier];
    out[tier] = typeof v === 'string' && v.trim() ? v : null;
  }
  return out;
}

/** GET /api/backends 응답에서 티어 정의를 꺼낸다. 없거나 비어 있으면 기본값. */
export function resolveTiers(state?: Pick<BackendsState, 'tiers'> | null): ModelTiers {
  const t = state?.tiers;
  if (!t || !Array.isArray(t.order) || t.order.length === 0) return DEFAULT_TIERS;
  return {
    order: t.order,
    labels: t.labels ?? {},
    backends: normalizeTierBackends(t.backends, t.order)
  };
}

/** 이 티어가 쓸 백엔드 id. null 이면 전역 백엔드를 따른다. */
export function tierBackendOf(tiers: ModelTiers, tier: string): string | null {
  return tiers.backends?.[tier] ?? null;
}

/**
 * 티어별 백엔드가 하나라도 지정돼 있는가.
 * true 면 에이전트에 백엔드를 개별 지정하는 순간 티어 라우팅이 무시되므로 UI 가 알려야 한다.
 */
export function hasTierBackends(tiers: ModelTiers): boolean {
  return Object.values(tiers.backends ?? {}).some((v) => !!v);
}

/** 티어 키 → 표시 이름. 라벨이 없으면 키를 그대로 보여준다. */
export function tierLabel(tiers: ModelTiers, key: string): string {
  const label = tiers.labels?.[key];
  return label && label.trim() ? label : key;
}

/**
 * 사용자가 입력한 새 티어 키를 정규화.
 * 서버 스키마(`/^[a-z0-9_-]+$/i`, 1~32자)를 통과하는 형태로만 남긴다.
 */
export function normalizeTierKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
}
