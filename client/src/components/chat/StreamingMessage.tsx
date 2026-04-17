import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ToolCall } from '../../store/chat-store';
import ToolCallCard from './ToolCallCard';
import { ChoicesList, extractChoices } from './MessageList';
import { Loader2, Activity, Wrench, ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../../lib/i18n';

interface Props {
  text: string;
  toolCalls: ToolCall[];
  running: boolean;
  error: string | null;
  onChoice?: (choice: string) => void;
}

export default function StreamingMessage({ text, toolCalls, running, error, onChoice }: Props) {
  const t = useT();
  const [toolsOpen, setToolsOpen] = useState(false);
  const { body, choices } = useMemo(() => extractChoices(text), [text]);

  if (!running && !error) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-4 py-3 text-sm break-words bg-zinc-900/60 border border-zinc-800 text-zinc-200 space-y-2">
        {/* Activity indicator */}
        {running && (
          <div className="flex items-center gap-2 pb-2 border-b border-zinc-800/60 text-[11px] text-zinc-500 uppercase tracking-wider">
            <Activity size={10} className="text-emerald-400 animate-pulse" />
            <span>
              {toolCalls.length === 0
                ? t('stream.generating')
                : t('stream.toolProgress', { count: toolCalls.length })}
            </span>
          </div>
        )}

        {/* Tool calls — 기본 접힘, 토글로 펼치기 */}
        {toolCalls.length > 0 && (
          <div>
            <button
              onClick={() => setToolsOpen(v => !v)}
              className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {toolsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <Wrench size={11} />
              <span>도구 {toolCalls.length}회 사용</span>
              {!toolsOpen && (
                <span className="text-zinc-600 truncate max-w-[200px]">
                  · {toolCalls.slice(-3).map(tc => tc.name).join(', ')}
                  {toolCalls.length > 3 && ' ...'}
                </span>
              )}
            </button>
            {toolsOpen && (
              <div className="space-y-1.5 mt-2">
                {toolCalls.map((tc, i) => (
                  <ToolCallCard key={i} tool={tc} index={i + 1} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Streaming text — 마크다운 렌더 */}
        {body && (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        )}

        {/* 선택지 버튼 (기타 입력 포함) */}
        {choices.length > 0 && onChoice && (
          <ChoicesList choices={choices} onChoice={onChoice} />
        )}

        {running && (
          <div className="inline-flex items-center gap-1 text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
          </div>
        )}

        {error && (
          <div className="mt-2 px-3 py-2 rounded bg-red-950/50 border border-red-900/50 text-xs text-red-300">
            <span className="font-semibold text-red-400">{t('common.error')}</span>
            <div className="mt-1 text-red-300/80 break-all">{error}</div>
          </div>
        )}
      </div>
    </div>
  );
}
