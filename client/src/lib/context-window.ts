import type { BackendsState } from './types';

/**
 * Heuristic mapping of a model id → max context window (tokens).
 * Used as a fallback when the backend doesn't declare contextWindow explicitly.
 */
export function modelContextWindow(model: string | null | undefined): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  // Sonnet 1M beta variants — model id usually contains "1m" or "-1m-"
  if (/(^|[-_])1m([-_]|$)/.test(m) || m.endsWith('-1m')) return 1_000_000;
  // Legacy small-context models
  if (m.includes('claude-instant')) return 100_000;
  if (m.includes('claude-2.0')) return 100_000;
  if (m.includes('claude-2.1')) return 200_000;
  // Default for Claude 3 / 3.5 / 4 / 4.5 / 4.6 family (Sonnet, Opus, Haiku)
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
