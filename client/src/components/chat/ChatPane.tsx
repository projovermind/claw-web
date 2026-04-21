import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { Zap, Eye, RotateCw, Square, AlertTriangle, Search, X, Inbox, GripVertical, Settings, ArrowDown } from 'lucide-react';
import { api } from '../../lib/api';
import type { Session, ChatMessage, Agent, BackendsState } from '../../lib/types';
import { useChatStore } from '../../store/chat-store';
import { useProgressToastStore } from '../../store/progress-toast-store';
import { useT } from '../../lib/i18n';
import MessageList from './MessageList';
import StreamingMessage from './StreamingMessage';
import { SessionTitleEditor } from './SessionTitleEditor';

interface Props {
  paneId: string;
  workspaceId: string;
  agentId: string | null;
  sessionId: string | null;
  isActive: boolean;
  isCompact: boolean;          // 2+ split view → compact header
  /** 폰트 스케일 (count 에 따라 1.0 / 0.92 / 0.85 / 0.78) */
  scale: number;
  /** Current pane count — controls how tight the header is. */
  onActivate: () => void;
  onSendMessage: (message: string) => void; // for choices
}

/** 패널 자체를 다른 pane 으로 이동(swap)시키는 드래그 ID. */
export const paneDragId = (workspaceId: string, paneId: string) =>
  `pane-drag:${workspaceId}:${paneId}`;

/** 드롭 타겟 ID 포맷: `pane:<workspaceId>:<paneId>` */
export const paneDropId = (workspaceId: string, paneId: string) =>
  `pane:${workspaceId}:${paneId}`;

export default function ChatPane({
  paneId,
  workspaceId,
  agentId,
  sessionId,
  isActive,
  isCompact,
  scale,
  onActivate,
  onSendMessage
}: Props) {
  const t = useT();
  const qc = useQueryClient();
  const { startTask, completeTask, failTask } = useProgressToastStore();
  const setPaneSession = useChatStore((s) => s.setPaneSession);
  const runtime = useChatStore((s) => (sessionId ? s.runtime[sessionId] : undefined));
  const startRun = useChatStore((s) => s.startRun);
  const finishRun = useChatStore((s) => s.finishRun);
  const markRead = useChatStore((s) => s.markRead);

  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const backendsQ = useQuery({ queryKey: ['backends'], queryFn: api.backends });
  const sessionQ = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId!),
    enabled: !!sessionId,
    refetchInterval: runtime?.running ? 5000 : false
  });

  const running = runtime?.running ?? false;
  const streaming = runtime?.streaming ?? '';
  const toolCalls = runtime?.toolCalls ?? [];
  const error = runtime?.error ?? null;

  const currentAgent = (agentsQ.data ?? []).find((a) => a.id === agentId);
  const currentSession = sessionQ.data;

  // 스크롤 관리 (pane마다 독립)
  //  - 사용자가 위로 스크롤한 상태에서는 새 메시지/스트리밍이 와도 자동 스크롤 금지
  //  - 하단 근처일 때만 자동으로 맨 아래로 따라감
  //  - atBottom === false 이면 "맨 아래로" 플로팅 버튼 노출
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  // Track scroll position to decide if user is near the bottom
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      atBottomRef.current = near;
      setAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // 초기값 세팅
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [sessionId]);

  // 메시지/스트리밍 변경 시 — 사용자가 하단 근처일 때만 맨 아래로
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    if (!atBottomRef.current) return; // 사용자가 스크롤 중 → 방해하지 않음
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [streaming, running, sessionQ.data?.messages?.length]);

  // 세션 변경 시에는 무조건 맨 아래로 (새 세션 진입)
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
    });
  }, [sessionId]);

  const scrollToBottom = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // 서버 isRunning 이면 runtime 복원
  useEffect(() => {
    if (!sessionId || !sessionQ.data?.isRunning) return;
    if (!runtime) startRun(sessionId);
  }, [sessionId, sessionQ.data?.isRunning, runtime, startRun]);

  // WS done 유실 시 폴링 fallback
  useEffect(() => {
    if (!running || !sessionId || !sessionQ.data) return;
    if (sessionQ.data.isRunning) return;
    const timer = setTimeout(() => {
      const state = useChatStore.getState();
      const stillRunning = state.runtime[sessionId]?.running;
      const serverDone = !sessionQ.data?.isRunning;
      if (stillRunning && serverDone) finishRun(sessionId, null);
    }, 2000);
    return () => clearTimeout(timer);
  }, [running, sessionId, sessionQ.data, sessionQ.data?.isRunning, finishRun]);

  // 현재 pane 이 열려있으면 읽음 처리
  useEffect(() => {
    if (sessionId) markRead(sessionId);
  }, [sessionId, markRead, sessionQ.data?.messages?.length]);

  // Search (per pane)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Compact-mode settings popup
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!settingsRef.current) return;
      if (!settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  // Rename / loop controls
  const renameSession = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameSession(id, title),
    onMutate: () => { startTask({ id: `rename-${paneId}`, title: '세션 이름 변경 중...' }); },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['session', sessionId] });
      await qc.invalidateQueries({ queryKey: ['sessions', agentId] });
      completeTask(`rename-${paneId}`, '이름 변경 완료');
    },
    onError: (err) => failTask(`rename-${paneId}`, (err as Error).message)
  });

  // Drop target
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: paneDropId(workspaceId, paneId),
    data: { kind: 'pane', paneId, workspaceId }
  });

  // Drag source — pane 자체를 다른 pane 으로 이동(swap)시키기 위한 핸들
  const {
    attributes: dragAttrs,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging
  } = useDraggable({
    id: paneDragId(workspaceId, paneId),
    data: { kind: 'pane-drag', paneId, workspaceId, sessionId, agentId }
  });

  const paneClasses = [
    'h-full min-h-0 flex flex-col relative border transition-colors',
    isActive ? 'border-sky-600/50' : 'border-zinc-800/60 hover:border-zinc-700',
    isOver ? 'ring-2 ring-sky-500/60 bg-sky-950/10' : '',
    isDragging ? 'opacity-50' : ''
  ].join(' ');

  return (
    <div
      ref={setDropRef}
      className={paneClasses}
      onMouseDown={onActivate}
      data-pane-id={paneId}
      style={{ fontSize: `${scale}em` }}
    >
      {/* Empty state — drop zone */}
      {!sessionId && (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 text-xs px-4 text-center gap-2 select-none">
          <Inbox size={24} className="text-zinc-700" />
          <div className="text-zinc-400">세션이 비어 있습니다</div>
          <div className="text-zinc-600 text-[11px]">
            왼쪽 사이드바에서 세션을 드래그해서 이 영역에 놓으세요
          </div>
          <button
            onClick={() => setPaneSession(paneId, null, null)}
            className="hidden"
          />
        </div>
      )}

      {sessionId && (
        <>
          {/* Header */}
          <div className={`flex items-center gap-1.5 border-b border-zinc-800 min-w-0 ${
            isCompact ? 'px-2 py-1' : 'px-4 lg:px-6 py-2'
          }`}>
            {/* Drag handle — split view 에서만 보임 */}
            {isCompact && (
              <button
                ref={setDragRef}
                {...dragAttrs}
                {...dragListeners}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing"
                style={{ touchAction: 'none', userSelect: 'none' }}
                title="드래그하여 이 pane 을 다른 위치로 이동"
              >
                <GripVertical size={11} />
              </button>
            )}
            {currentSession ? (
              <SessionTitleEditor
                key={currentSession.id}
                sessionId={currentSession.id}
                title={currentSession.title}
                onRename={(title) => renameSession.mutate({ id: currentSession.id, title })}
                busy={renameSession.isPending}
              />
            ) : (
              <div className={`font-semibold text-zinc-500 ${isCompact ? 'text-xs' : ''}`}>
                {t('chat.loading')}
              </div>
            )}
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {!isCompact && (
                <PaneControls
                  agent={currentAgent}
                  backends={backendsQ.data as BackendsState | undefined}
                  session={currentSession}
                  searchOpen={searchOpen}
                  onToggleSearch={() => {
                    setSearchOpen((v) => !v);
                    if (searchOpen) setSearchQuery('');
                  }}
                />
              )}
              {running && (
                <div className="flex items-center gap-1 text-[11px] text-amber-300 shrink-0">
                  <Zap size={10} /> {isCompact ? '' : t('chat.running')}
                </div>
              )}
              {/* Compact mode: settings popup trigger */}
              {isCompact && (
                <div ref={settingsRef} className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setSettingsOpen((v) => !v); }}
                    className={`p-0.5 rounded hover:bg-zinc-800 ${
                      settingsOpen ? 'text-sky-300' : 'text-zinc-600 hover:text-zinc-300'
                    }`}
                    title="세션 설정 (Plan / 사고 수준 / 검색)"
                  >
                    <Settings size={12} />
                  </button>
                  {settingsOpen && (
                    <div
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-full right-0 mt-1 z-30 p-2 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl flex items-center gap-1 whitespace-nowrap"
                      style={{ fontSize: '13px' }}
                    >
                      <PaneControls
                        agent={currentAgent}
                        backends={backendsQ.data as BackendsState | undefined}
                        session={currentSession}
                        searchOpen={searchOpen}
                        onToggleSearch={() => {
                          setSearchOpen((v) => !v);
                          if (searchOpen) setSearchQuery('');
                          setSettingsOpen(false);
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
              {/* Clear pane (remove session from this pane, keep session) */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPaneSession(paneId, null, null);
                }}
                className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
                title="이 패널에서 세션 비우기"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          {/* Search bar */}
          {searchOpen && (
            <div className={`${isCompact ? 'px-2 py-1.5' : 'px-4 lg:px-6 py-2'} border-b border-zinc-800 flex items-center gap-2 bg-zinc-900/40`}>
              <Search size={14} className="text-zinc-500 shrink-0" />
              <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('chat.searchPlaceholder')}
                className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none" />
              {searchQuery && <button onClick={() => setSearchQuery('')} className="text-zinc-500"><X size={14} /></button>}
            </div>
          )}

          {/* Loop banner */}
          {currentSession?.loop?.enabled && (
            <div className={`px-3 py-1.5 border-b flex items-center gap-2 text-xs ${
              currentSession.loop.paused
                ? 'bg-amber-900/20 border-amber-900/40 text-amber-200'
                : 'bg-emerald-900/20 border-emerald-900/40 text-emerald-200'
            }`}>
              {currentSession.loop.paused ? (
                <><AlertTriangle size={12} className="shrink-0" /><span className="flex-1 truncate">{t('chat.escalation')}: {currentSession.loop.escalateReason}</span></>
              ) : (
                <><RotateCw size={12} className="animate-spin shrink-0" /><span className="flex-1 truncate">Loop {currentSession.loop.currentIteration}/{currentSession.loop.maxIterations}</span></>
              )}
              <button onClick={async () => {
                if (!sessionId) return;
                if (confirm(t('chat.loopStopConfirm'))) {
                  await api.stopLoop(sessionId);
                  qc.invalidateQueries({ queryKey: ['session', sessionId] });
                }
              }} className="shrink-0 px-2 py-1 rounded bg-red-900/50 text-red-200 text-[11px]">
                <Square size={10} />
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 min-h-0 relative">
            <div ref={chatScrollRef} className={`absolute inset-0 overflow-y-auto ${isCompact ? 'px-2 pb-6' : 'px-3 lg:px-6 pb-8'}`}>
              <div className="min-h-full flex flex-col justify-end">
                {currentSession && (
                  <MessageList
                    key={currentSession.id}
                    messages={currentSession.messages ?? []}
                    searchQuery={searchQuery || undefined}
                    onChoice={onSendMessage}
                  />
                )}
                <StreamingMessage
                  text={streaming}
                  toolCalls={toolCalls}
                  running={running}
                  error={error}
                  onChoice={onSendMessage}
                />
              </div>
            </div>
            {/* Scroll-to-bottom floating button — 사용자가 위로 스크롤했을 때만 노출 */}
            {!atBottom && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 right-3 z-20 w-9 h-9 rounded-full bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 shadow-lg flex items-center justify-center backdrop-blur transition-colors"
                title="맨 아래로"
              >
                <ArrowDown size={16} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 세션 헤더 오른쪽 컨트롤 (모델 뱃지, 토큰, plan, thinking, search) */
function PaneControls({
  agent,
  backends,
  session,
  searchOpen,
  onToggleSearch
}: {
  agent: Agent | undefined;
  backends: BackendsState | undefined;
  session: Session | null | undefined;
  searchOpen: boolean;
  onToggleSearch: () => void;
}) {
  const qc = useQueryClient();
  const t = useT();

  const shortModelKey = useMemo(() => {
    if (!agent?.model) return null;
    const bid = (agent as { backendId?: string }).backendId;
    const allBackends = backends?.backends ?? {};
    const pool = bid ? (allBackends[bid] ? [allBackends[bid]] : []) : Object.values(allBackends);
    for (const b of pool) {
      const found = Object.entries(b?.models ?? {}).find(([, v]) => v === agent.model);
      if (found) return { short: found[0], bid };
    }
    return { short: agent.model, bid };
  }, [agent, backends]);

  const totals = useMemo(() => {
    if (!session?.messages) return null;
    const totalIn = session.messages.reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0);
    const totalOut = session.messages.reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0);
    if (totalIn + totalOut === 0) return null;
    return { in: totalIn, out: totalOut };
  }, [session]);

  return (
    <>
      {shortModelKey && (
        <div className="h-7 px-2 rounded bg-zinc-800/50 text-[11px] text-zinc-400 font-mono flex items-center gap-1">
          {shortModelKey.bid && shortModelKey.bid !== 'claude' && (
            <span className="text-emerald-400">{shortModelKey.bid}</span>
          )}
          <span>{shortModelKey.short}</span>
        </div>
      )}
      {totals && (
        <div className="h-7 px-2 rounded bg-zinc-800/50 text-[11px] text-zinc-500 font-mono flex items-center">
          ↑{(totals.in / 1000).toFixed(1)}k ↓{(totals.out / 1000).toFixed(1)}k
        </div>
      )}
      {agent && (() => {
        const isPlan = !!(agent as { planMode?: boolean }).planMode;
        return (
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.patchAgent(agent.id, { planMode: !isPlan } as Partial<Agent>);
              qc.invalidateQueries({ queryKey: ['agents'] });
            }}
            className={`h-7 px-2.5 rounded text-[11px] flex items-center gap-1 ${
              isPlan ? 'bg-sky-900/40 text-sky-300 border border-sky-800' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <Eye size={12} /> Plan
          </button>
        );
      })()}
      {agent && (
        <select
          value={(agent as { thinkingEffort?: string }).thinkingEffort ?? 'auto'}
          onChange={(e) => {
            e.stopPropagation();
            api.patchAgent(agent.id, { thinkingEffort: e.target.value } as Partial<Agent>);
            qc.invalidateQueries({ queryKey: ['agents'] });
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-7 px-1.5 rounded bg-zinc-800 text-[11px] text-zinc-400 border-none focus:outline-none cursor-pointer"
          title={t('chat.thinkingEffort')}
        >
          <option value="auto">🧠 auto</option>
          <option value="low">🧠 low</option>
          <option value="medium">🧠 med</option>
          <option value="high">🧠 high</option>
          <option value="max">🧠 max</option>
        </select>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleSearch(); }}
        className={`h-7 px-2.5 rounded text-[11px] flex items-center gap-1 ${
          searchOpen ? 'bg-sky-900/40 text-sky-300 border border-sky-800' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
        }`}
      >
        <Search size={12} />
      </button>
    </>
  );
}

/** 사용되지 않는 import 제거용 noop: ChatMessage type 은 외부 참조시 필요할 수 있어 유지 */
export type { ChatMessage };
