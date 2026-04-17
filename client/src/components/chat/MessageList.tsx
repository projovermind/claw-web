import { useEffect, useRef, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Wrench, ChevronDown, ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../lib/types';
import ToolCallCard from './ToolCallCard';

// 도구 호출 접혀있는 뷰
function ToolCallsCollapsed({ toolCalls, ts }: { toolCalls: { name: string; input: Record<string, unknown>; ts?: string }[]; ts: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Wrench size={11} />
        <span>도구 {toolCalls.length}회 사용</span>
        {!open && (
          <span className="text-zinc-600 truncate max-w-[220px]">
            · {toolCalls.slice(0, 4).map(tc => tc.name).join(', ')}
            {toolCalls.length > 4 && ` +${toolCalls.length - 4}`}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 mt-2">
          {toolCalls.map((t, i) => (
            <ToolCallCard
              key={i}
              index={i + 1}
              tool={{ name: t.name, input: t.input, ts: t.ts ?? ts }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 선택지 + 기타(직접 입력) 컴포넌트
export function ChoicesList({ choices, onChoice }: { choices: string[]; onChoice: (c: string) => void }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const submitCustom = () => {
    const v = custom.trim();
    if (!v) return;
    onChoice(v);
    setCustom('');
    setCustomOpen(false);
  };

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {choices.map((c, i) => (
        <button
          key={i}
          onClick={() => onChoice(c)}
          className="text-left px-3 py-2 rounded border border-zinc-700 bg-zinc-800/40 hover:border-emerald-600 hover:bg-emerald-900/20 text-zinc-200 text-xs transition-colors"
        >
          <span className="text-emerald-400 font-mono mr-2">{i + 1}.</span>
          <span className="markdown-body inline-block" style={{ display: 'inline' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}
              components={{ p: ({children}) => <span>{children}</span> }}>
              {c}
            </ReactMarkdown>
          </span>
        </button>
      ))}
      {customOpen ? (
        <div className="flex gap-1">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom();
              if (e.key === 'Escape') { setCustomOpen(false); setCustom(''); }
            }}
            placeholder="직접 입력..."
            autoFocus
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-2 text-xs outline-none focus:border-sky-500"
          />
          <button
            onClick={submitCustom}
            disabled={!custom.trim()}
            className="px-3 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 text-white text-xs"
          >전송</button>
        </div>
      ) : (
        <button
          onClick={() => setCustomOpen(true)}
          className="text-left px-3 py-2 rounded border border-dashed border-zinc-700 bg-zinc-900/20 hover:border-sky-600 hover:bg-sky-900/20 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
        >
          <span className="text-sky-400 font-mono mr-2">✎</span>
          기타 (직접 입력)
        </button>
      )}
    </div>
  );
}

interface MessageListProps {
  messages: ChatMessage[];
  searchQuery?: string;
  onChoice?: (choice: string) => void;
  isLastAssistant?: (idx: number) => boolean;
}

function extractChoices(text: string): { body: string; choices: string[] } {
  const tagMatch = text.match(/<choices>([\s\S]*?)<\/choices>/i);
  if (tagMatch) {
    const inner = tagMatch[1];
    const choices = inner
      .split('\n')
      .map(l => l.replace(/^\s*[-*\d.]+\s*/, '').trim())
      .filter(Boolean);
    const body = text.replace(tagMatch[0], '').trim();
    return { body, choices };
  }
  return { body: text, choices: [] };
}

export default function MessageList({ messages, searchQuery, onChoice }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const filtered = useMemo(() => {
    if (!searchQuery) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  // 마지막 assistant 메시지에만 선택지 버튼 활성화
  const lastAssistantIdx = filtered.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i !== -1).pop() ?? -1;

  return (
    <div className="flex flex-col gap-4 py-4">
      {filtered.map((m, i) => (
        <MessageBubble
          key={i}
          message={m}
          searchQuery={searchQuery}
          onChoice={i === lastAssistantIdx ? onChoice : undefined}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let lastIdx = 0;
  let idx = lower.indexOf(qLower);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push({ text: text.slice(lastIdx, idx), match: false });
    parts.push({ text: text.slice(idx, idx + query.length), match: true });
    lastIdx = idx + query.length;
    idx = lower.indexOf(qLower, lastIdx);
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), match: false });
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="bg-amber-500/30 text-amber-200 rounded px-0.5">{p.text}</mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

function MessageBubble({ message, searchQuery, onChoice }: { message: ChatMessage; searchQuery?: string; onChoice?: (c: string) => void }) {
  const isUser = message.role === 'user';
  const isQueued = isUser && (message as ChatMessage & { queued?: boolean }).queued;
  const { body, choices } = useMemo(() => isUser ? { body: message.content, choices: [] } : extractChoices(message.content), [message.content, isUser]);
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm break-words relative ${
          isUser
            ? isQueued
              ? 'bg-sky-900/40 border border-sky-700/50 text-zinc-100'
              : 'bg-zinc-700/60 text-zinc-100'
            : 'bg-zinc-900/60 border border-zinc-800 text-zinc-200'
        }`}
      >
        {isQueued && (
          <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-sky-600 text-white text-[10px] font-semibold animate-pulse">
            대기 중
          </div>
        )}
        {isUser ? (
          searchQuery ? (
            <HighlightText text={message.content} query={searchQuery} />
          ) : (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {body}
            </ReactMarkdown>
          </div>
        )}
        {!isUser && choices.length > 0 && onChoice && (
          <ChoicesList choices={choices} onChoice={onChoice} />
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsCollapsed toolCalls={message.toolCalls} ts={message.ts ?? ''} />
        )}
        {(message.model || message.usage) && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
            {message.model && <span>{message.model}</span>}
            {message.usage && message.usage.totalTokens > 0 && (
              <span className="font-mono">
                ↑{message.usage.inputTokens} ↓{message.usage.outputTokens}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
