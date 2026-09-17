import type { ModelTiers } from '../../lib/types';
import { tierLabel } from '../../lib/model-tiers';
import { useT } from '../../lib/i18n';

/**
 * 티어 → 실제 모델 id 매핑 표.
 * 저장은 호출부가 맡는다 — BackendCard 는 즉시 PATCH, 계정 편집 모달은 '저장' 버튼까지 버퍼링.
 */
export function TierModelMap({
  tiers,
  models,
  value,
  onChange,
  disabled
}: {
  tiers: ModelTiers;
  /** 이 백엔드의 단축명 → 모델 id */
  models: Record<string, string>;
  /** 티어 키 → 모델 id */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const t = useT();

  // 같은 모델 id 를 가리키는 단축명이 여러 개일 수 있다 — id 기준으로 한 번만 노출.
  const options: { modelId: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const [alias, modelId] of Object.entries(models)) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    options.push({ modelId, label: alias === modelId ? alias : `${alias}  →  ${modelId}` });
  }

  const setTier = (tier: string, modelId: string) => {
    const next = { ...value };
    if (modelId) next[tier] = modelId;
    else delete next[tier];
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-zinc-600 leading-snug">{t('tierMap.desc')}</p>
      {tiers.order.length === 0 && (
        <div className="text-[11px] text-zinc-600 italic">{t('tierMap.noTiers')}</div>
      )}
      {tiers.order.map((tier) => {
        const current = value[tier] ?? '';
        // 모델 목록에서 사라진 매핑도 표에는 남겨서 조용히 유실되지 않게 한다.
        const stale = current && !seen.has(current);
        return (
          <div key={tier} className="flex items-center gap-1.5">
            <span className="w-24 shrink-0 truncate text-[11px] font-semibold text-zinc-400">
              {tierLabel(tiers, tier)}
            </span>
            <select
              value={current}
              disabled={disabled}
              onChange={(e) => setTier(tier, e.target.value)}
              className={`flex-1 min-w-0 bg-zinc-950 border rounded px-2 py-1 text-[11px] font-mono disabled:opacity-50 ${
                stale ? 'border-amber-800 text-amber-300' : 'border-zinc-800 text-zinc-300'
              }`}
            >
              <option value="">{t('tierMap.unset')}</option>
              {stale && <option value={current}>{current} ({t('tierMap.stale')})</option>}
              {options.map((o) => (
                <option key={o.modelId} value={o.modelId}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {options.length === 0 && (
        <div className="text-[11px] text-amber-400/80 leading-snug">{t('tierMap.noModels')}</div>
      )}
    </div>
  );
}
