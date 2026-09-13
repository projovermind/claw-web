import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronUp, Loader2, Send, Square } from 'lucide-react';
import { api } from '../../lib/api';
import type { ChatMessage, Session } from '../../lib/types';
import { useChatStore } from '../../store/chat-store';
import MessageList from '../chat/MessageList';
import StreamingMessage from '../chat/StreamingMessage';

const PLACEHOLDER = '예) 매년 3월 2일 개학이라고 일정 추가해줘';

/**
 * 캘린더 전용 cw_calendar 채팅 패널.
 * 세션/스트리밍/메시지 렌더링은 전부 기존 채팅 인프라(chat-store + MessageList + StreamingMessage)를
 * 그대로 쓴다 — WS 수신은 App 의 useWebSocket 이 전역으로 처리하므로 여기서 붙일 것이 없다.
 */
export default function CalendarChatPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 패널을 처음 펼칠 때만 세션을 확보한다 — 캘린더만 보는 사용자에게 세션을 만들지 않기 위함.
  const sessionIdQ = useQuery({
    queryKey: ['calendar-chat-session'],
    queryFn: api.calendarChatSession,
    enabled: open,
    staleTime: Infinity
  });
  const sessionId = sessionIdQ.data?.sessionId ?? null;

  const runtime = useChatStore((s) => (sessionId ? s.runtime[sessionId] : undefined));
  const running = runtime?.running ?? false;

  const sessionQ = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId!),
    enabled: open && !!sessionId,
    refetchInterval: running ? 5000 : false
  });

  // 낙관적 반영만 하고 이후 갱신은 WS(chat.started/chat.done → ['session', id] refetch)에 맡긴다.
  const send = useMutation({
    mutationFn: (message: string) => api.sendMessage(sessionId!, message),
    onMutate: (message) => {
      const prev = qc.getQueryData<Session>(['session', sessionId]);
      const optimistic: ChatMessage = { role: 'user', content: message, ts: new Date().toISOString() };
      qc.setQueryData<Session>(['session', sessionId], (old) =>
        old ? { ...old, messages: [...(old.messages ?? []), optimistic] } : old
      );
      return { prev };
    },
    onError: (_err, _msg, ctx) => {
      if (ctx?.prev) qc.setQueryData(['session', sessionId], ctx.prev);
    }
  });

  // 다른 탭/새로고침으로 들어와 이미 돌고 있는 세션이면 runtime 을 복원한다 (ChatPane 과 동일).
  useEffect(() => {
    if (!sessionId || !sessionQ.data?.isRunning) return;
    if (!runtime) useChatStore.getState().startRun(sessionId);
  }, [sessionId, sessionQ.data?.isRunning, runtime]);

  // 새 메시지/스트리밍이 오면 맨 아래로. 패널이 작아 스크롤 위치 보존까지는 필요 없다.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, runtime?.streaming, sessionQ.data?.messages?.length]);

  const submit = (text: string) => {
    const message = text.trim();
    if (!message || !sessionId || running) return;
    setDraft('');
    send.mutate(message);
  };

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden bg-zinc-900/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <Bot size={15} className="text-violet-400" />
        <span className="text-sm font-medium">캘린더 에이전트</span>
        <span className="text-xs text-zinc-600 truncate">말로 일정 추가/수정하기</span>
        {running && <Loader2 size={13} className="animate-spin text-amber-300" />}
        <span className="ml-auto text-zinc-500">
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800">
          {sessionIdQ.isError ? (
            <p className="px-4 py-6 text-sm text-red-400">
              캘린더 세션을 열지 못했습니다: {(sessionIdQ.error as Error).message}
            </p>
          ) : !sessionId ? (
            <div className="px-4 py-6 flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              세션 준비 중…
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="max-h-[360px] min-h-[160px] overflow-y-auto px-4 py-3 space-y-3">
                {(sessionQ.data?.messages ?? []).length === 0 && !running && (
                  <p className="text-sm text-zinc-600">{PLACEHOLDER}</p>
                )}
                <MessageList
                  messages={sessionQ.data?.messages ?? []}
                  sessionId={sessionId}
                  onChoice={submit}
                />
                <StreamingMessage
                  text={runtime?.streaming ?? ''}
                  toolCalls={runtime?.toolCalls ?? []}
                  running={running}
                  error={runtime?.error ?? null}
                  onChoice={submit}
                />
              </div>

              <div className="flex items-end gap-2 border-t border-zinc-800 p-3">
                <textarea
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submit(draft);
                    }
                  }}
                  placeholder={running ? '작업 중…' : PLACEHOLDER}
                  className="flex-1 resize-none bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm max-h-28"
                />
                {running ? (
                  <button
                    onClick={() => api.abortChat(sessionId).catch(() => {})}
                    title="중단"
                    className="p-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                  >
                    <Square size={15} />
                  </button>
                ) : (
                  <button
                    disabled={!draft.trim() || send.isPending}
                    onClick={() => submit(draft)}
                    className="p-2 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40"
                  >
                    <Send size={15} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
