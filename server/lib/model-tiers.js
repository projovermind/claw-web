/**
 * 모델 티어(상/중/하) 체계.
 *
 * 에이전트는 "어떤 모델" 대신 "어느 급" 을 고르고(agent.modelTier), 백엔드마다
 * 그 급에 해당하는 실제 모델 ID 를 `tierModels` 로 들고 있다. 백엔드를 갈아타도
 * (폴백 포함) 급은 유지되고 모델 ID 만 그 백엔드 기준으로 다시 풀린다.
 *
 * 기존 `models` 맵은 "특정 모델 고정" 용으로 그대로 살아 있다 — 티어를 지정하지
 * 않은 에이전트는 예전처럼 별칭/ID 경로로 해석된다.
 */

export const DEFAULT_TIER_ORDER = ['high', 'middle', 'low'];

export const DEFAULT_TIER_LABELS = {
  high: '상 (고성능)',
  middle: '중 (균형)',
  low: '하 (경량)'
};

export const DEFAULT_TIERS = () => ({
  order: [...DEFAULT_TIER_ORDER],
  labels: { ...DEFAULT_TIER_LABELS },
  // 티어 → 백엔드 id. 비어 있으면 그 티어는 전역 백엔드를 따른다.
  // (HIGH=Claude, LOW=Z.AI 처럼 급마다 다른 제공자를 섞어 쓰기 위한 것)
  backends: {}
});

/** 기존 models 별칭 → 티어. 마이그레이션 기준표. */
export const ALIAS_TO_TIER = { opus: 'high', sonnet: 'middle', haiku: 'low' };

/**
 * order/labels/backends 를 항상 쓸 수 있는 형태로 정규화. 비어 있으면 기본 3단계.
 * backends 는 값이 없거나 null 인 티어를 아예 키에서 뺀다 = "전역 백엔드 따름".
 */
export function normalizeTiers(tiers) {
  const raw = Array.isArray(tiers?.order) ? tiers.order : [];
  const cleaned = [...new Set(raw.filter((t) => typeof t === 'string' && t.trim()))];
  const order = cleaned.length ? cleaned : [...DEFAULT_TIER_ORDER];
  const labels = {};
  const backends = {};
  for (const t of order) {
    const given = tiers?.labels?.[t];
    labels[t] = typeof given === 'string' && given.trim() ? given : (DEFAULT_TIER_LABELS[t] ?? t);
    const backendId = tiers?.backends?.[t];
    if (typeof backendId === 'string' && backendId.trim()) backends[t] = backendId.trim();
  }
  return { order, labels, backends };
}

/** 이 티어가 쓰기로 돼 있는 백엔드 id. 지정이 없으면 null(= 전역 따름). */
export function tierBackendId(tiers, tier) {
  if (typeof tier !== 'string' || !tier.trim()) return null;
  return normalizeTiers(tiers).backends[tier.trim()] ?? null;
}

/** 쓸 만한 모델 ID 하나를 고른다: default → auto → 첫 엔트리. 없으면 null. */
function pickSoleModel(models) {
  if (!models || typeof models !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return str(models.default)
    ?? str(models.auto)
    ?? (Object.values(models).map(str).find(Boolean) ?? null);
}

/**
 * models 맵에서 티어별 모델 ID 를 뽑아낸다 (opus→high, sonnet→middle, haiku→low).
 *
 * 별칭이 하나도 없는 백엔드(게이트웨이 프리셋처럼 자체 모델명을 쓰거나, 아예
 * 모델이 하나뿐인 백엔드)는 이대로 두면 티어가 전혀 해석되지 않아 티어 이름이
 * 그대로 전선에 실린다 → 쓸 수 있는 모델 하나를 기본 티어 전부에 똑같이 건다.
 */
export function tierModelsFromModels(models) {
  const out = {};
  for (const [alias, tier] of Object.entries(ALIAS_TO_TIER)) {
    const id = models?.[alias];
    if (typeof id === 'string' && id.trim()) out[tier] = id;
  }
  if (Object.keys(out).length > 0) return out;
  const sole = pickSoleModel(models);
  if (!sole) return out;
  for (const tier of DEFAULT_TIER_ORDER) out[tier] = sole;
  return out;
}

/**
 * 백엔드 하나의 tierModels 를 models 로부터 보충한다. 멱등 — 이미 채워진 티어는
 * 절대 덮어쓰지 않고, 채울 것이 없으면 null 을 돌려 "기록할 변경 없음" 을 알린다.
 */
export function migrateBackendTierModels(backend) {
  const current = backend?.tierModels && typeof backend.tierModels === 'object'
    ? backend.tierModels
    : null;
  const merged = { ...tierModelsFromModels(backend?.models), ...(current ?? {}) };
  if (Object.keys(merged).length === 0) return null;
  if (current && Object.keys(merged).length === Object.keys(current).length) return null;
  return merged;
}

/**
 * 티어 이름 → 이 백엔드에서 실제로 쓸 모델 ID.
 *
 * 1) tierModels[tier] 가 있으면 그대로.
 * 2) 없으면 order 상 한 칸씩 **아래** 티어로 강등하며 처음 만나는 모델.
 * 3) 그래도 없으면 models.default.
 *
 * 티어 체계에 없는 이름(= 평범한 모델 별칭)이면 null 을 돌려 호출자가 기존
 * 별칭 해석 경로를 그대로 타게 한다.
 *
 * @returns {{ modelId: string, tier: string|null, requestedTier: string, demoted: boolean, fromDefault: boolean }|null}
 */
export function resolveTierModel({ backendObj, tier, tiers } = {}) {
  if (!backendObj || typeof tier !== 'string' || !tier.trim()) return null;
  const tierModels = backendObj.tierModels && typeof backendObj.tierModels === 'object'
    ? backendObj.tierModels
    : {};
  const { order } = normalizeTiers(tiers);
  const known = order.includes(tier) || Object.hasOwn(tierModels, tier);
  if (!known) return null;

  const direct = tierModels[tier];
  if (typeof direct === 'string' && direct.trim()) {
    return { modelId: direct, tier, requestedTier: tier, demoted: false, fromDefault: false };
  }

  const idx = order.indexOf(tier);
  for (let i = idx + 1; i >= 1 && i < order.length; i++) {
    const id = tierModels[order[i]];
    if (typeof id === 'string' && id.trim()) {
      return { modelId: id, tier: order[i], requestedTier: tier, demoted: true, fromDefault: false };
    }
  }

  const def = backendObj.models?.default;
  if (typeof def === 'string' && def.trim()) {
    return { modelId: def, tier: null, requestedTier: tier, demoted: false, fromDefault: true };
  }
  return null;
}
