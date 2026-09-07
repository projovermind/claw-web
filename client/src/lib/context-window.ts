import type { BackendsState } from './types';

/**
 * Heuristic mapping of a model id → max context window (tokens).
 *
 * Claude 4.6 이후의 Opus/Sonnet 과 Fable/Mythos 5 계열은 1M 창이다(기본값이며
 * 베타 게이트 아님). Haiku 는 4.5 기준 200K. 이 구분이 없으면 실측 1M 세션이
 * 200K 로 계산돼 게이지가 500% 를 가리키고, 자동 compact 임계도 무의미해진다.
 */
export function modelContextWindow(model: string | null | undefined): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (/(^|[-_])1m([-_]|$)/.test(m) || m.endsWith('-1m')) return 1_000_000;
  // Legacy small-context models
  if (m.includes('claude-instant')) return 100_000;
  if (m.includes('claude-2.0')) return 100_000;
  if (m.includes('claude-2.1')) return 200_000;
  // Haiku 는 1M 계열에 포함되지 않는다 — Opus/Sonnet 규칙보다 먼저 걸러낸다.
  if (m.includes('haiku')) return 200_000;
  // Opus/Sonnet 4.6+ 및 Opus 5 / Sonnet 5
  if (/claude-(opus|sonnet)-(4-6|4-7|4-8|5)(\b|[-_]|$)/.test(m)) return 1_000_000;
  // Fable / Mythos 5 계열
  if (/claude-(fable|mythos)-5(\b|[-_.]|$)/.test(m)) return 1_000_000;
  return 200_000;
}

/**
 * Resolves a model's context window using, in order:
 *   1. Explicit `contextWindows[model]` declared on the agent's backend
 *   2. Same lookup across any backend (in case the agent's backendId is stale)
 *   3. Heuristic from `modelContextWindow`
 *
 * Returns `{ tokens, source }` so callers can flag heuristic guesses to the
 * user (e.g. show "(추정)" or warn when the gauge overflows).
 */
export type ContextWindowSource = 'backend' | 'heuristic';

export function resolveContextWindow(
  model: string | null | undefined,
  backendId: string | null | undefined,
  backends: BackendsState | undefined,
): { tokens: number; source: ContextWindowSource } {
  if (model && backends?.backends) {
    const preferred = backendId ? backends.backends[backendId] : null;
    const preferredHit = preferred?.contextWindows?.[model];
    if (typeof preferredHit === 'number' && preferredHit > 0) {
      return { tokens: preferredHit, source: 'backend' };
    }
    for (const b of Object.values(backends.backends)) {
      const hit = b.contextWindows?.[model];
      if (typeof hit === 'number' && hit > 0) {
        return { tokens: hit, source: 'backend' };
      }
    }
  }
  return { tokens: modelContextWindow(model), source: 'heuristic' };
}

/** Color tier for a usage ratio (0..1). */
export type UsageTier = 'low' | 'mid' | 'high' | 'critical';

export function usageTier(used: number, max: number): UsageTier {
  if (max <= 0) return 'low';
  const r = used / max;
  if (r >= 0.9) return 'critical';
  if (r >= 0.7) return 'high';
  if (r >= 0.5) return 'mid';
  return 'low';
}

export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
