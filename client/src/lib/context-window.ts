/**
 * Maps a model identifier to its maximum context window in tokens.
 *
 * Source: Anthropic public docs (Claude 3.5/4/4.5/4.6 = 200K, Sonnet 1M beta = 1M).
 * Unknown models fall back to 200K (the modern Claude default), which is a safe
 * lower bound for displaying a context-usage gauge.
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
