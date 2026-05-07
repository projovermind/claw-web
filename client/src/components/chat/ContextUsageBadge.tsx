import { formatTokensCompact, usageTier, type UsageTier, type ContextWindowSource } from '../../lib/context-window';

/**
 * Where `used` came from:
 *   - 'accurate'   = runner's per-call `contextTokens` (true context-window load)
 *   - 'legacy-sum' = `inputTokens + cacheReadTokens` from old messages saved
 *                    before per-call tracking; on tool-loop turns this sum
 *                    overflows the model window because the CLI aggregates
 *                    cache_read across all internal calls.
 */
export type UsedSource = 'accurate' | 'legacy-sum';

interface Props {
  /** Tokens currently loaded into the context window. */
  used: number;
  /** Model's max context window in tokens. */
  max: number;
  /** Where `max` came from — affects how we display overflows. */
  source?: ContextWindowSource;
  /** Where `used` came from. Defaults to 'accurate'. */
  usedSource?: UsedSource;
  /** Optional diagnostic breakdown for the tooltip. */
  diag?: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    model: string | null;
  };
}

const TIER_STYLES: Record<UsageTier, { text: string; bg: string; pulse?: boolean; label: string }> = {
  low:      { text: 'text-zinc-400',   bg: 'bg-zinc-800/60',   label: '여유' },
  mid:      { text: 'text-emerald-300', bg: 'bg-emerald-900/30', label: '보통' },
  high:     { text: 'text-amber-300',  bg: 'bg-amber-900/40',  label: '높음' },
  critical: { text: 'text-red-300',    bg: 'bg-red-900/50',    label: '매우 높음', pulse: true },
};

const OVER_STYLE = { text: 'text-fuchsia-200', bg: 'bg-fuchsia-900/50', pulse: true, label: '오버' };

/**
 * Compact gauge shown in the composer's bottom-right corner — mirrors
 * Claude Desktop's context usage indicator.
 *
 * `used` = current context-window load (last turn's input + cache_read tokens),
 * NOT a cumulative session total. Once Claude CLI compacts the session, this
 * naturally drops on the next response.
 *
 * If `used > max` we render an explicit "오버" state instead of capping the
 * percentage at 100% — the cap was hiding a real misconfiguration (model
 * context window unknown, or cache_read reporting larger than the window).
 */
function overflowReason(usedSource: UsedSource, source: ContextWindowSource): string {
  // Legacy-sum overflow is the most common case — explain it before blaming
  // the heuristic or claiming a real overrun.
  if (usedSource === 'legacy-sum') {
    return '레거시 메시지 — 도구 루프 cache_read 합산값(실제 부하 아님). 다음 턴부터는 정확히 표시됨.';
  }
  if (source === 'heuristic') {
    return '모델 컨텍스트 윈도우 미상 — 백엔드 설정에 contextWindows 추가 권장';
  }
  return '실제 사용량이 백엔드가 알려준 한계를 초과 — 컴팩트 필요';
}

export default function ContextUsageBadge({ used, max, source = 'heuristic', usedSource = 'accurate', diag }: Props) {
  if (used <= 0 || max <= 0) return null;
  const ratio = used / max;
  const pct = Math.round(ratio * 100);
  const over = ratio > 1.05; // 5% slack — small overshoots are usually rounding
  const tier = usageTier(used, max);
  const style = over ? OVER_STYLE : TIER_STYLES[tier];

  const reason = over ? overflowReason(usedSource, source) : style.label;

  const titleParts: string[] = [
    `컨텍스트 사용량: ${used.toLocaleString()} / ${max.toLocaleString()} 토큰 (${pct}%)`,
    `상태: ${reason}`,
    `한계 출처: ${source === 'backend' ? '백엔드 설정' : '휴리스틱(추정)'}`,
  ];
  if (diag) {
    const sourceLine = usedSource === 'accurate'
      ? `· 게이지 출처: 마지막 LLM call 의 prompt 크기 (정확)`
      : `· 게이지 출처: input + cache_read 합산 (레거시 — 도구 루프 시 과대표시 가능)`;
    titleParts.push(
      `\n진단:`,
      sourceLine,
      `· input_tokens(누적): ${diag.inputTokens.toLocaleString()}`,
      `· cache_read_input_tokens(누적): ${diag.cacheReadTokens.toLocaleString()}`,
      `· output_tokens(누적): ${diag.outputTokens.toLocaleString()}`,
      `· model: ${diag.model ?? '(미상)'}`,
    );
  }

  return (
    <div
      className={`h-7 px-2 rounded text-[11px] font-mono flex items-center gap-1.5 ${style.bg} ${style.text} ${style.pulse ? 'animate-pulse' : ''}`}
      title={titleParts.join('\n')}
    >
      <span>{formatTokensCompact(used)}</span>
      <span className="opacity-50">/</span>
      <span className="opacity-70">{formatTokensCompact(max)}</span>
      <span className="opacity-60">·</span>
      {over ? <span>오버 {pct}%</span> : <span>{pct}%</span>}
      {source === 'heuristic' && !over && <span className="opacity-50" title="추정">~</span>}
    </div>
  );
}
