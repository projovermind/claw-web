import { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Wrench, ChevronDown, ChevronRight, ArrowRight, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ChatMessage, Session } from '../../lib/types';
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
  const [selected, setSelected] = useState<string | null>(null);
  const t = useT();

  const handleChoice = (text: string) => {
    setSelected(text);
    setCustomOpen(false);
    onChoice(text);
  };

  const submitCustom = () => {
    const v = custom.trim();
    if (!v) return;
    handleChoice(v);
    setCustom('');
  };

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {choices.map((c, i) => {
        const isSelected = selected === c.text;
        const isDisabled = selected !== null && !isSelected;
        return (
          <button
            key={i}
            onClick={() => !selected && handleChoice(c.text)}
            disabled={isDisabled}
            className={`text-left px-3 py-2 rounded border text-xs transition-colors relative ${
              isSelected
                ? c.recommended
                  ? 'border-amber-400 bg-amber-900/40 text-amber-50 shadow-[0_0_16px_rgba(251,191,36,0.3)] ring-1 ring-amber-500/50'
                  : 'border-emerald-500 bg-emerald-900/30 text-zinc-100 ring-1 ring-emerald-500/50'
                : isDisabled
                  ? 'border-zinc-800 bg-zinc-900/20 text-zinc-600 cursor-not-allowed opacity-40'
                  : c.recommended
                    ? 'border-amber-500/60 bg-amber-900/20 hover:border-amber-400 hover:bg-amber-900/30 text-amber-50 shadow-[0_0_12px_rgba(251,191,36,0.2)] cursor-pointer'
                    : 'border-zinc-700 bg-zinc-800/40 hover:border-emerald-600 hover:bg-emerald-900/20 text-zinc-200 cursor-pointer'
            }`}
          >
            <span className={`font-mono mr-2 ${isSelected ? (c.recommended ? 'text-amber-300' : 'text-emerald-400') : isDisabled ? 'text-zinc-600' : c.recommended ? 'text-amber-300' : 'text-emerald-400'}`}>
              {isSelected ? '✓' : c.recommended ? '⭐' : `${i + 1}.`}
            </span>
            <span className="markdown-body inline-block" style={{ display: 'inline' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}
                components={{ p: ({children}) => <span>{children}</span> }}>
                {c.text}
              </ReactMarkdown>
            </span>
            {c.recommended && !isSelected && (
              <span className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-amber-500 text-zinc-900 text-[10px] font-bold">
                {t('chat.choices.recommended')}
              </span>
            )}
            {isSelected && (
              <span className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-emerald-500 text-zinc-900 text-[10px] font-bold">
                선택됨
              </span>
            )}
          </button>
        );
      })}
      {selected === null && (customOpen ? (
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
      ))}
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
  const containerRef = useRef<HTMLDivElement>(null);
  // 위임 카드에 대상 세션의 라이브 running 상태 반영용
  const { data: allSessionsData } = useQuery<{ sessions: Session[] }>({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 5000
  });
  const runningSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of allSessionsData?.sessions ?? []) if (s.isRunning) set.add(s.id);
    return set;
  }, [allSessionsData]);
  // 첫 렌더(세션 진입) 시 instant 스크롤 → 위에서 아래로 훑는 애니메이션 방지.
  // 이후 메시지 추가는 smooth. parent 의 key={sessionId} 로 세션 전환 시 remount 가정.
  const isFirstRender = useRef(true);
  const [ready, setReady] = useState(false);

  // 레이아웃 반영 직전에 스크롤 위치 세팅 → fade-in 하면 바닥부터 보임
  useLayoutEffect(() => {
    if (!isFirstRender.current) return;
    // messages 가 아직 없으면 skip (다음 effect 에서 처리)
    if (messages.length === 0) return;
    endRef.current?.scrollIntoView({ behavior: 'auto' });
    // 스크롤 위치 잡힌 후 다음 tick 에 보이도록
    requestAnimationFrame(() => setReady(true));
    isFirstRender.current = false;
  }, [messages.length]);

  useEffect(() => {
    if (isFirstRender.current) return; // 위 layoutEffect 가 처리
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // 빈 세션은 바로 ready (fade-in 대기할 필요 없음)
  useEffect(() => {
    if (messages.length === 0) setReady(true);
  }, [messages.length]);

  const filtered = useMemo(() => {
    if (!searchQuery) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  // 마지막 assistant 메시지에만 선택지 버튼 활성화
  const lastAssistantIdx = filtered.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i !== -1).pop() ?? -1;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col gap-4 py-4 transition-opacity duration-150 ${ready ? 'opacity-100' : 'opacity-0'}`}
    >
      {filtered.map((m, i) => {
        // 이전 메시지가 [위임 결과 보고] / [위임 에스컬레이션] user 트리거면
        // 이 assistant 응답이 "위임 작업 완료" 또는 "에스컬레이션 대응" 단계
        const prev = i > 0 ? filtered[i - 1] : null;
        const prevContent = (prev?.content || '').trim();
        const isReportResponse = m.role === 'assistant' && prev?.role === 'user'
          && /^\[위임 결과 보고\]/.test(prevContent);
        const isEscalateResponse = m.role === 'assistant' && prev?.role === 'user'
          && /^\[위임 에스컬레이션\]/.test(prevContent);
        return (
        <MessageBubble
          key={i}
          message={m}
          searchQuery={searchQuery}
          onChoice={i === lastAssistantIdx ? onChoice : undefined}
          delegationStage={isReportResponse ? 'final' : isEscalateResponse ? 'escalate-resolution' : undefined}
          runningSessionIds={runningSessionIds}
        />
        );
      })}
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

function MessageBubble({ message, searchQuery, onChoice, delegationStage, runningSessionIds }: {
  message: ChatMessage;
  searchQuery?: string;
  onChoice?: (c: string) => void;
  /** 이전 메시지 컨텍스트 기반 위임 단계 배지 */
  delegationStage?: 'final' | 'escalate-resolution';
  /** 현재 러닝 중인 세션 ID 집합 (위임 카드의 라이브 작업 중 표시) */
  runningSessionIds?: Set<string>;
}) {
  const t = useT();
  const isUser = message.role === 'user';
  const isQueued = isUser && (message as ChatMessage & { queued?: boolean }).queued;
  // 위임 메시지는 특수 카드로 렌더 (사이드바에서는 위임 세션 숨김 → 여기서 인라인 표시)
  const delegationMatch = !isUser && parseDelegationMessage(message.content);
  if (delegationMatch) {
    const targetRunning = delegationMatch.session ? runningSessionIds?.has(delegationMatch.session) : false;
    return <DelegationCard data={delegationMatch} targetRunning={!!targetRunning} />;
  }
  // 시스템 트리거 user 메시지 ([위임 결과 보고] / [위임 에스컬레이션])
  // — 사용자가 쓴 게 아니라 서버가 planner 재진입시키려고 주입한 메시지
  if (isUser && /^\[(?:위임 결과 보고|위임 에스컬레이션)\]/.test(message.content)) {
    return <SystemTriggerCard content={message.content} />;
  }
  const { body, choices } = useMemo(() => isUser ? { body: message.content, choices: [] } : extractChoices(message.content), [message.content, isUser]);
  // 에러 메시지 감지: ⚠️ 로 시작하는 assistant 메시지
  const isError = !isUser && /^⚠️/.test(message.content.trim());
  // 버블 색상 — CSS 변수(useAppearance 훅이 주입) 기반
  const userBubbleStyle = isUser && !isQueued ? { background: 'var(--user-bubble, #3f3f46)' } : undefined;
  const assistantBubbleStyle = !isUser && !isError ? { background: 'var(--assistant-bubble, #18181b)' } : undefined;
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        style={userBubbleStyle ?? assistantBubbleStyle}
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm break-words relative ${
          isUser
            ? isQueued
              ? 'bg-sky-900/40 border border-sky-700/50 text-zinc-100'
              : 'text-zinc-100'
            : isError
              ? 'border border-red-800/60 bg-red-950/30 text-red-200'
              : 'border border-zinc-800 text-zinc-200'
        }`}
      >
        {isQueued && (
          <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-sky-600 text-white text-[10px] font-semibold animate-pulse">
            {t('chat.queued')}
          </div>
        )}
        {delegationStage === 'final' && (
          <div className="mb-2 pb-1.5 border-b border-emerald-700/40 flex items-center gap-1.5 text-[10px] text-emerald-300 uppercase tracking-wider">
            <CheckCircle2 size={11} /> 위임 작업 완료 — 종합 보고
          </div>
        )}
        {delegationStage === 'escalate-resolution' && (
          <div className="mb-2 pb-1.5 border-b border-amber-700/40 flex items-center gap-1.5 text-[10px] text-amber-300 uppercase tracking-wider">
            <XCircle size={11} /> 에스컬레이션 대응
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

/** 서버가 planner 재진입을 트리거하려고 주입한 user 메시지 카드
 *  ([위임 결과 보고] / [위임 에스컬레이션]) — 일반 user 버블로 렌더하면
 *  마치 사용자가 직접 쓴 듯 보이므로 별도 스타일. */
function SystemTriggerCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const isEscalate = /^\[위임 에스컬레이션\]/.test(content);
  const label = isEscalate ? '시스템: 위임 에스컬레이션 → 기획자 재진입' : '시스템: 위임 결과 보고 → 기획자 재진입';
  const color = isEscalate
    ? { border: 'border-amber-700/60', bg: 'bg-amber-950/20', text: 'text-amber-300' }
    : { border: 'border-zinc-700', bg: 'bg-zinc-900/40', text: 'text-zinc-400' };
  return (
    <div className="flex justify-center">
      <div className={`max-w-[85%] rounded-lg border border-dashed ${color.border} ${color.bg} px-3 py-2 text-[11px] ${color.text} w-full`}>
        <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 text-left">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span className="opacity-80">{label}</span>
        </button>
        {open && (
          <pre className="mt-1.5 pt-1.5 border-t border-current/10 whitespace-pre-wrap break-words text-[10px] opacity-70 font-sans">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

/** 위임 메시지 파싱 — 패턴:
 *  - 'request':  에이전트가 내보낸 `{"delegate":{...}}` JSON (서버가 파싱하기 전 원본 응답)
 *  - 'start':    서버가 append 하는 "🔄 **위임 시작**"
 *  - 'done':     "✅ **위임 완료**"
 *  - 'fail':     "⚠️ 위임 실패"
 *  - 'escalate': "🚨 **Loop 에스컬레이션**" (Ralph Loop 중단 시)
 */
interface DelegationData {
  kind: 'request' | 'start' | 'done' | 'fail' | 'escalate';
  targetAgent: string;
  task?: string;
  session?: string;
  summary?: string;
  loop?: boolean;
  /** request 케이스에서 JSON 의 message 필드 */
  note?: string;
  /** escalate 케이스의 이유 */
  reason?: string;
  /** escalate 케이스의 iteration 표시 */
  iteration?: string;
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
  // 에스컬레이션: "🚨 **Loop 에스컬레이션** ({iter}/{max})\n\n**이유**: {reason}\n\n후속 지시..."
  const escalateMatch = content.match(/^🚨\s*\*\*Loop 에스컬레이션\*\*(?:\s*\(([^)]+)\))?/);
  if (escalateMatch) {
    const reasonMatch = content.match(/\*\*이유\*\*:\s*([\s\S]*?)(?:\n\n|$)/);
    return {
      kind: 'escalate',
      targetAgent: '',
      iteration: escalateMatch[1]?.trim(),
      reason: reasonMatch?.[1]?.trim()
    };
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
function DelegationCard({ data, targetRunning = false }: { data: DelegationData; targetRunning?: boolean }) {
  const [open, setOpen] = useState(data.kind === 'fail' || data.kind === 'escalate');
  const palette = data.kind === 'done'
    ? { border: 'border-emerald-800/60', bg: 'bg-emerald-950/30', text: 'text-emerald-200', icon: <CheckCircle2 size={14} className="text-emerald-400" />, label: '위임 작업 완료' }
    : data.kind === 'fail'
      ? { border: 'border-red-800/60', bg: 'bg-red-950/30', text: 'text-red-200', icon: <XCircle size={14} className="text-red-400" />, label: '위임 실패' }
      : data.kind === 'escalate'
        ? { border: 'border-amber-700/60', bg: 'bg-amber-950/30', text: 'text-amber-200', icon: <XCircle size={14} className="text-amber-400 animate-pulse" />, label: `Loop 에스컬레이션${data.iteration ? ` ${data.iteration}` : ''}` }
        : data.kind === 'request'
          ? { border: 'border-zinc-700', bg: 'bg-zinc-900/60', text: 'text-zinc-300', icon: <ArrowRight size={14} className="text-zinc-400" />, label: data.loop ? '위임 요청 (Loop)' : '위임 요청' }
          : targetRunning
            ? { border: 'border-amber-600/60', bg: 'bg-amber-950/20', text: 'text-amber-200', icon: <Loader2 size={14} className="text-amber-400 animate-spin" />, label: data.loop ? '작업 중 (Ralph Loop)' : '작업 중' }
            : { border: 'border-amber-700/50', bg: 'bg-amber-950/20', text: 'text-amber-200', icon: <ArrowRight size={14} className="text-amber-400" />, label: data.loop ? '위임 중 (Ralph Loop)' : '위임 중' };
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
            {data.reason && <div><span className="opacity-60">이유:</span> {data.reason}</div>}
            {data.task && <div><span className="opacity-60">작업:</span> {data.task}</div>}
            {data.session && <div><span className="opacity-60">세션:</span> <span className="font-mono opacity-80">{data.session}</span></div>}
            {data.summary && (
              <div className="mt-1 pt-1 border-t border-current/10 opacity-90 whitespace-pre-wrap break-words">
                {data.summary}
              </div>
            )}
            {data.kind === 'escalate' && (
              <div className="mt-1 pt-1 border-t border-current/10 opacity-80 italic">
                후속 지시를 보내면 Loop 가 재개됩니다.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
