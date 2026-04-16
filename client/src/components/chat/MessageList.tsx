import { useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '../../lib/types';
import ToolCallCard from './ToolCallCard';

interface MessageListProps {
  messages: ChatMessage[];
  searchQuery?: string;
}

export default function MessageList({ messages, searchQuery }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const filtered = useMemo(() => {
    if (!searchQuery) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  return (
    <div className="flex flex-col gap-4 py-4">
      {filtered.map((m, i) => (
        <MessageBubble key={i} message={m} searchQuery={searchQuery} />
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

function MessageBubble({ message, searchQuery }: { message: ChatMessage; searchQuery?: string }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm break-words ${
          isUser
            ? 'bg-zinc-700/60 text-zinc-100 whitespace-pre-wrap'
            : 'bg-zinc-900/60 border border-zinc-800 text-zinc-200'
        }`}
      >
        {isUser ? (
          searchQuery ? <HighlightText text={message.content} query={searchQuery} /> : message.content
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {message.toolCalls.map((t, i) => (
              <ToolCallCard
                key={i}
                index={i + 1}
                tool={{ name: t.name, input: t.input, ts: message.ts ?? '' }}
              />
            ))}
          </div>
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
