import { formatTokensCompact, usageTier, type UsageTier } from '../../lib/context-window';

interface Props {
  /** Tokens currently loaded into the context window (input + cache_read of last turn). */
  used: number;
  /** Model's max context window in tokens. */
  max: number;
}

const TIER_STYLES: Record<UsageTier, { text: string; bg: string; pulse?: boolean; label: string }> = {
  low:      { text: 'text-zinc-400',   bg: 'bg-zinc-800/60',   label: '여유' },
  mid:      { text: 'text-emerald-300', bg: 'bg-emerald-900/30', label: '보통' },
  high:     { text: 'text-amber-300',  bg: 'bg-amber-900/40',  label: '높음' },
  critical: { text: 'text-red-300',    bg: 'bg-red-900/50',    label: '매우 높음', pulse: true },
};

/**
 * Compact gauge shown in the composer's bottom-right corner — mirrors
 * Claude Desktop's context usage indicator.
 *
 * The "used" value is the *current* context-window load (last turn's input
 * tokens + cache_read tokens), NOT a cumulative session total. Once a session
 * gets compacted by Claude CLI, this number drops accordingly.
 */
export default function ContextUsageBadge({ used, max }: Props) {
  if (used <= 0 || max <= 0) return null;
  const ratio = Math.min(used / max, 1);
  const pct = Math.round(ratio * 100);
  const tier = usageTier(used, max);
  const style = TIER_STYLES[tier];

  return (
    <div
      className={`h-7 px-2 rounded text-[11px] font-mono flex items-center gap-1.5 ${style.bg} ${style.text} ${style.pulse ? 'animate-pulse' : ''}`}
      title={`컨텍스트 사용량: ${used.toLocaleString()} / ${max.toLocaleString()} 토큰 (${pct}%) — ${style.label}`}
    >
      <span>{formatTokensCompact(used)}</span>
      <span className="opacity-50">/</span>
      <span className="opacity-70">{formatTokensCompact(max)}</span>
      <span className="opacity-60">·</span>
      <span>{pct}%</span>
    </div>
  );
}
