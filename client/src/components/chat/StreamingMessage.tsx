import type { ToolCall } from '../../store/chat-store';
import ToolCallCard from './ToolCallCard';
import { Loader2, Activity } from 'lucide-react';

interface Props {
  text: string;
  toolCalls: ToolCall[];
  running: boolean;
  error: string | null;
}

/**
 * Renders the in-flight assistant response bubble.
 *
 * Visible when:
 *  - running === true (agent is actively working)
 *  - OR error is set (show failure message)
 *
 * Deliberately NOT rendered after running becomes false, even if text or
 * toolCalls are still populated — the ordering fix in useWebSocket clears
 * runtime state on chat.done AFTER the session query refetches, so by the
 * time running is false, the persisted message is already in MessageList.
 * Gating strictly on `running || error` eliminates the "response shown
 * twice" bug.
 */
export default function StreamingMessage({ text, toolCalls, running, error }: Props) {
  if (!running && !error) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap break-words bg-zinc-900/60 border border-zinc-800 text-zinc-200 space-y-2">
        {/* Activity indicator bar — visible whenever running, shows current step count */}
        {running && (
          <div className="flex items-center gap-2 pb-2 border-b border-zinc-800/60 text-[11px] text-zinc-500 uppercase tracking-wider">
            <Activity size={10} className="text-emerald-400 animate-pulse" />
            <span>
              {toolCalls.length === 0
                ? '응답 생성 중…'
                : `작업 ${toolCalls.length}단계 · 진행 중…`}
            </span>
          </div>
        )}

        {/* Live tool call log — expanded by default while running so the user
            sees what the agent is actually doing step-by-step */}
        {toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {toolCalls.map((t, i) => (
              <ToolCallCard key={i} tool={t} index={i + 1} />
            ))}
          </div>
        )}

        {/* Streaming text body */}
        {text && <div>{text}</div>}

        {/* Cursor spinner — only while still streaming */}
        {running && (
          <div className="inline-flex items-center gap-1 text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
          </div>
        )}

        {error && (
          <div className="mt-2 px-3 py-2 rounded bg-red-950/50 border border-red-900/50 text-xs text-red-300">
            <span className="font-semibold text-red-400">오류 발생</span>
            <div className="mt-1 text-red-300/80 break-all">{error}</div>
          </div>
        )}
      </div>
    </div>
  );
}
