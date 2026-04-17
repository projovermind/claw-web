import { useEffect, useRef, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Wrench, ChevronDown, ChevronRight, ArrowRight, CheckCircle2, XCircle } from 'lucide-react';
import type { ChatMessage } from '../../lib/types';
import ToolCallCard from './ToolCallCard';
import { useT } from '../../lib/i18n';

// 도구 호출 접혀있는 뷰
function ToolCallsCollapsed({ toolCalls, ts }: { toolCalls: { name: string; input: Record<string, unknown>; ts?: string }[]; ts: string }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Wrench size={11} />
        <span>{t('chat.toolUsed', { count: toolCalls.length })}</span>
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
export function ChoicesList({ choices, onChoice }: { choices: ChoiceItem[]; onChoice: (c: string) => void }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const t = useT();

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
          onClick={() => onChoice(c.text)}
          className={`text-left px-3 py-2 rounded border text-xs transition-colors relative ${
            c.recommended
              ? 'border-amber-500/60 bg-amber-900/20 hover:border-amber-400 hover:bg-amber-900/30 text-amber-50 shadow-[0_0_12px_rgba(251,191,36,0.2)]'
              : 'border-zinc-700 bg-zinc-800/40 hover:border-emerald-600 hover:bg-emerald-900/20 text-zinc-200'
          }`}
        >
          <span className={`font-mono mr-2 ${c.recommended ? 'text-amber-300' : 'text-emerald-400'}`}>
            {c.recommended ? '⭐' : `${i + 1}.`}
          </span>
          <span className="markdown-body inline-block" style={{ display: 'inline' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}
              components={{ p: ({children}) => <span>{children}</span> }}>
              {c.text}
            </ReactMarkdown>
          </span>
          {c.recommended && (
            <span className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-amber-500 text-zinc-900 text-[10px] font-bold">
              {t('chat.choices.recommended')}
            </span>
          )}
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
            placeholder={t('chat.choices.customPlaceholder')}
            autoFocus
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-2 text-xs outline-none focus:border-sky-500"
          />
          <button
            onClick={submitCustom}
            disabled={!custom.trim()}
            className="px-3 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 text-white text-xs"
          >{t('chat.choices.send')}</button>
        </div>
      ) : (
        <button
          onClick={() => setCustomOpen(true)}
          className="text-left px-3 py-2 rounded border border-dashed border-zinc-700 bg-zinc-900/20 hover:border-sky-600 hover:bg-sky-900/20 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
        >
          <span className="text-sky-400 font-mono mr-2">✎</span>
          {t('chat.choices.custom')}
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

export interface ChoiceItem { text: string; recommended: boolean }

export function extractChoices(text: string): { body: string; choices: ChoiceItem[] } {
  const tagMatch = text.match(/<choices>([\s\S]*?)<\/choices>/i);
  if (tagMatch) {
    const inner = tagMatch[1];
    const choices: ChoiceItem[] = inner
      .split('\n')
      .map(l => l.replace(/^\s*[-*\d.]+\s*/, '').trim())
      .filter(Boolean)
      .map(raw => {
        // 추천 마커 파싱: ⭐, [추천], [recommended], (추천) 등
        const patterns = [/\s*\[추천\]\s*/, /\s*\[recommended\]\s*/i, /\s*\(추천\)\s*/, /\s*⭐\s*/, /\s*★\s*/];
        let recommended = false;
        let text = raw;
        for (const p of patterns) {
          if (p.test(text)) {
            recommended = true;
            text = text.replace(p, ' ').trim();
          }
        }
        return { text, recommended };
      });
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
  const t = useT();
  const isUser = message.role === 'user';
  const isQueued = isUser && (message as ChatMessage & { queued?: boolean }).queued;
  // 위임 메시지는 특수 카드로 렌더 (사이드바에서는 위임 세션 숨김 → 여기서 인라인 표시)
  const delegationMatch = !isUser && parseDelegationMessage(message.content);
  if (delegationMatch) return <DelegationCard data={delegationMatch} />;
  const { body, choices } = useMemo(() => isUser ? { body: message.content, choices: [] } : extractChoices(message.content), [message.content, isUser]);
  // 버블 색상 — CSS 변수(useAppearance 훅이 주입) 기반
  const userBubbleStyle = isUser && !isQueued ? { background: 'var(--user-bubble, #3f3f46)' } : undefined;
  const assistantBubbleStyle = !isUser ? { background: 'var(--assistant-bubble, #18181b)' } : undefined;
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        style={userBubbleStyle ?? assistantBubbleStyle}
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm break-words relative ${
          isUser
            ? isQueued
              ? 'bg-sky-900/40 border border-sky-700/50 text-zinc-100'
              : 'text-zinc-100'
            : 'border border-zinc-800 text-zinc-200'
        }`}
      >
        {isQueued && (
          <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-sky-600 text-white text-[10px] font-semibold animate-pulse">
            {t('chat.queued')}
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

/** 위임 메시지 파싱 — 4가지 패턴:
 *  - 'request': 에이전트가 내보낸 `{"delegate":{...}}` JSON (서버가 파싱하기 전 원본 응답)
 *  - 'start':   서버가 append 하는 "🔄 **위임 시작**"
 *  - 'done':    "✅ **위임 완료**"
 *  - 'fail':    "⚠️ 위임 실패"
 */
interface DelegationData {
  kind: 'request' | 'start' | 'done' | 'fail';
  targetAgent: string;
  task?: string;
  session?: string;
  summary?: string;
  loop?: boolean;
  /** request 케이스에서 JSON 의 message 필드 */
  note?: string;
}

/** 에이전트 응답에서 delegate JSON 블록(코드블록 안 + 일반 텍스트) 을 추출 */
function extractDelegateJsonFromText(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  // ```json ... ``` 코드블록
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  candidates.push(text);
  for (const src of candidates) {
    let idx = src.indexOf('"delegate"');
    while (idx !== -1) {
      const start = src.lastIndexOf('{', idx);
      if (start === -1) break;
      // 중괄호 균형 맞는 닫기 찾기
      let depth = 0, end = -1, inStr = false, prev = '';
      for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (inStr) { if (c === '"' && prev !== '\\') inStr = false; }
        else {
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        prev = c;
      }
      if (end !== -1) {
        try {
          const obj = JSON.parse(src.slice(start, end + 1)) as Record<string, unknown>;
          const del = obj?.delegate as Record<string, unknown> | undefined;
          if (del?.agent && del?.task) return obj;
        } catch { /* skip */ }
      }
      idx = src.indexOf('"delegate"', idx + 1);
    }
  }
  return null;
}

function parseDelegationMessage(content: string): DelegationData | null {
  if (!content) return null;
  // 시작: "🔄 **위임 시작** — {agent}에게 작업을 전달했습니다.\n\n**작업**: {task}\n**세션**: {sid}"
  const startMatch = content.match(/^🔄\s*\*\*위임 시작\*\*\s*—\s*([^\n]+?)에게/);
  if (startMatch) {
    const taskMatch = content.match(/\*\*작업\*\*:\s*([^\n]+)/);
    const sessMatch = content.match(/\*\*세션\*\*:\s*([^\n]+)/);
    const loop = /Ralph Loop/.test(content);
    return {
      kind: 'start',
      targetAgent: startMatch[1].trim(),
      task: taskMatch?.[1]?.trim(),
      session: sessMatch?.[1]?.trim(),
      loop
    };
  }
  // 완료: "✅ **위임 완료** — {agent}\n\n**작업**: {task}\n\n**결과 요약**:\n{summary}"
  const doneMatch = content.match(/^✅\s*\*\*위임 완료\*\*\s*—\s*([^\n]+)/);
  if (doneMatch) {
    const taskMatch = content.match(/\*\*작업\*\*:\s*([^\n]+)/);
    const summaryMatch = content.match(/\*\*결과 요약\*\*:\s*([\s\S]*)$/);
    return {
      kind: 'done',
      targetAgent: doneMatch[1].trim(),
      task: taskMatch?.[1]?.trim(),
      summary: summaryMatch?.[1]?.trim()
    };
  }
  // 실패: "⚠️ 위임 실패 — 에이전트 "{id}"를 찾을 수 없습니다."
  const failMatch = content.match(/^⚠️\s*위임 실패\s*—\s*에이전트\s*"([^"]+)"/);
  if (failMatch) {
    return { kind: 'fail', targetAgent: failMatch[1] };
  }
  // 요청: 에이전트가 내보낸 {"delegate":{...}} JSON 원본 응답
  // — 서버의 "🔄 위임 시작" 메시지와 중복되지만 먼저 찍히는 raw JSON 을 정리하기 위해 카드로 치환
  const obj = extractDelegateJsonFromText(content);
  if (obj) {
    const del = obj.delegate as Record<string, unknown>;
    return {
      kind: 'request',
      targetAgent: String(del.agent),
      task: typeof del.task === 'string' ? del.task : undefined,
      loop: del.loop === true,
      note: typeof obj.message === 'string' ? obj.message : undefined
    };
  }
  return null;
}

/** 위임 카드 — MessageBubble 대체 렌더 */
function DelegationCard({ data }: { data: DelegationData }) {
  const [open, setOpen] = useState(data.kind === 'fail');
  const palette = data.kind === 'done'
    ? { border: 'border-emerald-800/60', bg: 'bg-emerald-950/30', text: 'text-emerald-200', icon: <CheckCircle2 size={14} className="text-emerald-400" />, label: '위임 완료' }
    : data.kind === 'fail'
      ? { border: 'border-red-800/60', bg: 'bg-red-950/30', text: 'text-red-200', icon: <XCircle size={14} className="text-red-400" />, label: '위임 실패' }
      : data.kind === 'request'
        ? { border: 'border-zinc-700', bg: 'bg-zinc-900/60', text: 'text-zinc-300', icon: <ArrowRight size={14} className="text-zinc-400" />, label: data.loop ? '위임 요청 (Loop)' : '위임 요청' }
        : { border: 'border-sky-800/60', bg: 'bg-sky-950/30', text: 'text-sky-200', icon: <ArrowRight size={14} className="text-sky-400 animate-pulse" />, label: data.loop ? '위임 (Ralph Loop)' : '위임 중' };
  // 접힘 라벨: note 우선 → task
  const preview = data.note || data.task || '';
  return (
    <div className="flex justify-start">
      <div className={`max-w-[85%] rounded-lg border ${palette.border} ${palette.bg} px-3 py-2 text-xs ${palette.text} space-y-1.5 w-full`}>
        <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 text-left">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {palette.icon}
          <span className="font-semibold">[{palette.label}]</span>
          <span className="font-mono opacity-80">{data.targetAgent}</span>
          {preview && !open && (
            <span className="opacity-60 truncate flex-1 text-[11px]">— {preview.slice(0, 80)}</span>
          )}
        </button>
        {open && (
          <div className="pl-5 space-y-1 text-[11px]">
            {data.note && <div className="italic opacity-80">"{data.note}"</div>}
            {data.task && <div><span className="opacity-60">작업:</span> {data.task}</div>}
            {data.session && <div><span className="opacity-60">세션:</span> <span className="font-mono opacity-80">{data.session}</span></div>}
            {data.summary && (
              <div className="mt-1 pt-1 border-t border-current/10 opacity-90 whitespace-pre-wrap break-words">
                {data.summary}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
