import { useEffect, useState, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap, Eye, RotateCw, Square, AlertTriangle, Search, X,
  Plus, Pin, ChevronDown
} from 'lucide-react';
import { api } from '../lib/api';
import type { Session, ChatMessage, Agent, Project } from '../lib/types';
import { useChatStore } from '../store/chat-store';
import MessageList from '../components/chat/MessageList';
import StreamingMessage from '../components/chat/StreamingMessage';
import ChatInput from '../components/chat/ChatInput';
import TodoWidget from '../components/chat/TodoWidget';
import { ChatSidebar } from '../components/chat/ChatSidebar';
import { SessionTitleEditor } from '../components/chat/SessionTitleEditor';

export default function ChatPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const setCurrentAgent = useChatStore((s) => s.setCurrentAgent);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const runtime = useChatStore((s) => (currentSessionId ? s.runtime[currentSessionId] : undefined));

  useEffect(() => {
    const agentParam = searchParams.get('agent');
    const sessionParam = searchParams.get('session');
    if (agentParam) setCurrentAgent(agentParam);
    if (sessionParam) setCurrentSession(sessionParam);
    if (agentParam || sessionParam) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const backendsQ = useQuery({ queryKey: ['backends'], queryFn: api.backends });
  const sessionsQ = useQuery({
    queryKey: ['sessions', currentAgentId],
    queryFn: () => (currentAgentId ? api.sessions(currentAgentId) : Promise.resolve([])),
    enabled: !!currentAgentId
  });
  const sessionQ = useQuery({
    queryKey: ['session', currentSessionId],
    queryFn: () => api.session(currentSessionId!),
    enabled: !!currentSessionId
  });

  useEffect(() => {
    if (!currentAgentId && agentsQ.data && agentsQ.data.length > 0) {
      setCurrentAgent(agentsQ.data[0].id);
    }
  }, [agentsQ.data, currentAgentId, setCurrentAgent]);

  const createSession = useMutation({
    mutationFn: () => api.createSession(currentAgentId!),
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      setCurrentSession(session.id);
    }
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      if (sessionQ.data?.id === currentSessionId) setCurrentSession(null);
    }
  });

  const sendMessage = useMutation({
    mutationFn: ({ message, paths }: { message: string; paths: string[] }) =>
      api.sendMessage(currentSessionId!, message, paths),
    onMutate: async ({ message, paths }) => {
      if (!currentSessionId) return { prev: undefined };
      await qc.cancelQueries({ queryKey: ['session', currentSessionId] });
      const prev = qc.getQueryData<Session>(['session', currentSessionId]);
      const content = paths.length > 0
        ? `${message}\n\n[첨부 파일]\n${paths.map((p) => `- ${p}`).join('\n')}\n\n위 경로의 파일들을 Read 도구로 확인해주세요.`
        : message;
      const optimistic: ChatMessage = { role: 'user', content, ts: new Date().toISOString() };
      qc.setQueryData<Session>(['session', currentSessionId], (old) =>
        old ? { ...old, messages: [...(old.messages ?? []), optimistic] } : old
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev && currentSessionId) qc.setQueryData(['session', currentSessionId], ctx.prev);
    }
  });

  const abortChat = () => {
    if (currentSessionId) api.abortChat(currentSessionId).catch(() => {});
  };

  const renameSession = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameSession(id, title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', currentSessionId] });
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
    }
  });

  const pinSession = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api.pinSession(id, pinned),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      qc.invalidateQueries({ queryKey: ['session', currentSessionId] });
    }
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const running = runtime?.running ?? false;
  const streaming = runtime?.streaming ?? '';
  const toolCalls = runtime?.toolCalls ?? [];
  const todos = runtime?.todos ?? [];
  const error = runtime?.error ?? null;

  // Auto-scroll: fires on new messages, streaming text, and running state change.
  // Uses requestAnimationFrame so the DOM has painted the new content first.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      // Always scroll if user hasn't scrolled up more than 200px
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (isNearBottom || running) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [streaming, running, sessionQ.data?.messages?.length]);

  // Current agent/project context
  const currentAgent = (agentsQ.data ?? []).find((a) => a.id === currentAgentId);
  const currentProject = currentAgent?.projectId
    ? (projectsQ.data ?? []).find((p) => p.id === currentAgent.projectId)
    : null;
  const currentSession = sessionQ.data;

  // Sorted sessions: pinned first, then recent
  const sortedSessions = useMemo(() => {
    return (sessionsQ.data ?? []).slice().sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    });
  }, [sessionsQ.data]);

  // Project selection → auto-connect to lead
  const selectProject = (project: Project) => {
    const lead = (agentsQ.data ?? []).find(
      (a) => a.projectId === project.id && a.tier === 'project'
    );
    const target = lead ?? (agentsQ.data ?? []).find((a) => a.projectId === project.id);
    if (target) setCurrentAgent(target.id);
    setCurrentSession(null);
  };

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Desktop sidebar — hidden on mobile, flex on lg so it stretches full height */}
      <ChatSidebar
        agents={agentsQ.data ?? []}
        projects={projectsQ.data ?? []}
        sessions={sessionsQ.data ?? []}
        currentAgentId={currentAgentId}
        currentSessionId={currentSessionId}
        setCurrentAgent={setCurrentAgent}
        setCurrentSession={setCurrentSession}
        createSession={createSession}
        deleteSession={deleteSession}
      />

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ─── Mobile compact header (visible only on <lg) ─── */}
        <MobileHeader
          projects={projectsQ.data ?? []}
          agents={agentsQ.data ?? []}
          sessions={sortedSessions}
          currentProject={currentProject}
          currentAgent={currentAgent}
          currentSessionId={currentSessionId}
          currentSession={currentSession}
          onSelectProject={selectProject}
          onSelectSession={setCurrentSession}
          onSelectAgent={setCurrentAgent}
          onNewSession={() => createSession.mutate()}
          onTogglePin={() => {
            if (currentSessionId && currentSession) {
              pinSession.mutate({ id: currentSessionId, pinned: !currentSession.pinned });
            }
          }}
          isPinned={!!currentSession?.pinned}
          canCreate={!!currentAgentId}
        />

        {/* ─── Chat content ─── */}
        {!currentSessionId ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm px-4 text-center">
            프로젝트를 선택하고 세션을 시작하세요
          </div>
        ) : (
          <>
            {/* Desktop header (hidden on mobile) */}
            <div className="hidden lg:flex px-6 py-2 border-b border-zinc-800 items-center gap-2 min-w-0">
              {currentSession ? (
                <SessionTitleEditor
                  key={currentSession.id}
                  sessionId={currentSession.id}
                  title={currentSession.title}
                  onRename={(title) => renameSession.mutate({ id: currentSession.id, title })}
                  busy={renameSession.isPending}
                />
              ) : (
                <div className="font-semibold text-zinc-500">Loading...</div>
              )}
              {/* Right-aligned controls — all same height (h-7) */}
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {currentAgent?.model && (() => {
                  // 실제 호출되는 모델명 해석: backendId의 models 맵에서 변환
                  const bid = currentAgent.backendId;
                  const backendModels = bid ? (backendsQ.data as { backends: Record<string, { models: Record<string, string> }> })?.backends?.[bid]?.models : null;
                  const resolvedModel = backendModels?.[currentAgent.model] ?? currentAgent.model;
                  return (
                    <div className="h-7 px-2 rounded bg-zinc-800/50 text-[11px] text-zinc-400 font-mono flex items-center gap-1">
                      {bid && bid !== 'claude' && (
                        <span className="text-emerald-400">{bid}</span>
                      )}
                      <span>{resolvedModel}</span>
                    </div>
                  );
                })()}
                {currentSession?.messages && (() => {
                  const totalIn = currentSession.messages.reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0);
                  const totalOut = currentSession.messages.reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0);
                  if (totalIn + totalOut === 0) return null;
                  return (
                    <div className="h-7 px-2 rounded bg-zinc-800/50 text-[11px] text-zinc-500 font-mono flex items-center">
                      ↑{(totalIn / 1000).toFixed(1)}k ↓{(totalOut / 1000).toFixed(1)}k
                    </div>
                  );
                })()}
                {currentAgent && (() => {
                  const isPlan = !!(currentAgent as { planMode?: boolean }).planMode;
                  return (
                    <button
                      onClick={() => {
                        api.patchAgent(currentAgent.id, { planMode: !isPlan } as Partial<Agent>);
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
                {/* Thinking effort selector */}
                {currentAgent && (
                  <select
                    value={(currentAgent as { thinkingEffort?: string }).thinkingEffort ?? 'auto'}
                    onChange={(e) => {
                      api.patchAgent(currentAgent.id, { thinkingEffort: e.target.value } as Partial<Agent>);
                      qc.invalidateQueries({ queryKey: ['agents'] });
                    }}
                    className="h-7 px-1.5 rounded bg-zinc-800 text-[11px] text-zinc-400 border-none focus:outline-none cursor-pointer"
                    title="Thinking Effort"
                  >
                    <option value="auto">🧠 auto</option>
                    <option value="low">🧠 low</option>
                    <option value="medium">🧠 med</option>
                    <option value="high">🧠 high</option>
                    <option value="max">🧠 max</option>
                  </select>
                )}
                <button
                  onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearchQuery(''); }}
                  className={`h-7 px-2.5 rounded text-[11px] flex items-center gap-1 ${
                    searchOpen ? 'bg-sky-900/40 text-sky-300 border border-sky-800' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Search size={12} />
                </button>
              </div>
              {running && (
                <div className="flex items-center gap-1 text-[11px] text-amber-300 shrink-0">
                  <Zap size={10} /> running
                </div>
              )}
            </div>

            {/* Search bar */}
            {searchOpen && (
              <div className="px-4 lg:px-6 py-2 border-b border-zinc-800 flex items-center gap-2 bg-zinc-900/40">
                <Search size={14} className="text-zinc-500 shrink-0" />
                <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="메시지 검색..." className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none" />
                {searchQuery && <button onClick={() => setSearchQuery('')} className="text-zinc-500"><X size={14} /></button>}
              </div>
            )}

            {/* Loop banner */}
            {currentSession?.loop?.enabled && (
              <div className={`px-4 lg:px-6 py-2 border-b flex items-center gap-2 text-xs ${
                currentSession.loop.paused
                  ? 'bg-amber-900/20 border-amber-900/40 text-amber-200'
                  : 'bg-emerald-900/20 border-emerald-900/40 text-emerald-200'
              }`}>
                {currentSession.loop.paused ? (
                  <><AlertTriangle size={12} className="shrink-0" /><span className="flex-1 truncate">에스컬레이션: {currentSession.loop.escalateReason}</span></>
                ) : (
                  <><RotateCw size={12} className="animate-spin shrink-0" /><span className="flex-1 truncate">Loop {currentSession.loop.currentIteration}/{currentSession.loop.maxIterations}</span></>
                )}
                <button onClick={async () => { if (confirm('루프 중단?')) { await api.stopLoop(currentSessionId!); qc.invalidateQueries({ queryKey: ['session', currentSessionId] }); } }}
                  className="shrink-0 px-2 py-1 rounded bg-red-900/50 text-red-200 text-[11px]"><Square size={10} /></button>
              </div>
            )}

            {/* Messages */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 lg:px-6">
              {currentSession && (
                <MessageList messages={currentSession.messages ?? []} searchQuery={searchQuery || undefined} />
              )}
              <StreamingMessage text={streaming} toolCalls={toolCalls} running={running} error={error} />
            </div>

            {/* Input */}
            <ChatInput
              disabled={!currentSessionId}
              running={running}
              sessionId={currentSessionId}
              workingDir={currentAgent?.workingDir ?? null}
              onSend={(msg, paths) => sendMessage.mutate({ message: msg, paths })}
              onAbort={abortChat}
              onSystemCommand={async (cmd, arg) => {
                switch (cmd) {
                  case 'clear':
                    if (currentSessionId && confirm('현재 세션을 삭제하고 새로 시작할까?')) {
                      await api.deleteSession(currentSessionId);
                      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
                      createSession.mutate();
                    }
                    break;
                  case 'new':
                    createSession.mutate();
                    break;
                  case 'rename':
                    if (currentSessionId && arg) {
                      renameSession.mutate({ id: currentSessionId, title: arg });
                    } else if (currentSessionId) {
                      const title = prompt('새 세션 제목:', currentSession?.title ?? '');
                      if (title) renameSession.mutate({ id: currentSessionId, title });
                    }
                    break;
                  case 'export':
                    if (currentSessionId) {
                      try { await api.downloadSessionExport(currentSessionId, 'md'); }
                      catch (e) { alert(`Export 실패: ${(e as Error).message}`); }
                    }
                    break;
                  case 'pin':
                    if (currentSessionId && currentSession) {
                      pinSession.mutate({ id: currentSessionId, pinned: !currentSession.pinned });
                    }
                    break;
                  case 'search':
                    setSearchOpen((v) => !v);
                    break;
                  case 'help':
                    alert('사용 가능한 명령어:\n\n/commit — 커밋\n/review — 코드 리뷰\n/test — 테스트\n/plan — 계획\n/fix — 버그 수정\n/loop — Ralph Loop\n/run — Background task\n/clear — 세션 초기화\n/new — 새 세션\n/rename — 이름 변경\n/export — 내보내기\n/pin — 고정\n/search — 검색\n/help — 도움말');
                    break;
                }
              }}
            />
          </>
        )}
      </div>

      {/* Todo sidebar (desktop only) */}
      {todos.length > 0 && (
        <aside className="hidden lg:block w-72 shrink-0 border-l border-zinc-800 bg-zinc-950/60 p-4 overflow-y-auto">
          <TodoWidget todos={todos} />
        </aside>
      )}
    </div>
  );
}

/** ─── Mobile-only compact header ─── */
function MobileHeader({
  projects, agents, sessions, currentProject, currentAgent,
  currentSessionId, currentSession, onSelectProject, onSelectSession,
  onSelectAgent, onNewSession, onTogglePin, isPinned, canCreate
}: {
  projects: Project[];
  agents: Agent[];
  sessions: Session[];
  currentProject: Project | null | undefined;
  currentAgent: Agent | undefined;
  currentSessionId: string | null;
  currentSession: Session | null | undefined;
  onSelectProject: (p: Project) => void;
  onSelectSession: (id: string | null) => void;
  onSelectAgent: (agentId: string) => void;
  onNewSession: () => void;
  onTogglePin: () => void;
  isPinned: boolean;
  canCreate: boolean;
}) {
  const [projOpen, setProjOpen] = useState(false);
  const [sessOpen, setSessOpen] = useState(false);
  const projRef = useRef<HTMLDivElement>(null);
  const sessRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (projOpen && !projRef.current?.contains(e.target as Node)) setProjOpen(false);
      if (sessOpen && !sessRef.current?.contains(e.target as Node)) setSessOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [projOpen, sessOpen]);

  // Global agents for the project picker
  const globalAgents = agents.filter((a) => a.tier === 'main' || (!a.projectId && !a.tier));

  return (
    <div className="lg:hidden flex items-center gap-1.5 px-2 py-2 border-b border-zinc-800 bg-zinc-950/90 relative z-20">
      {/* Project selector */}
      <div ref={projRef} className="relative flex-1 min-w-0">
        <button
          onClick={() => { setProjOpen((v) => !v); setSessOpen(false); }}
          className="w-full flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs"
        >
          {currentProject ? (
            <>
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: currentProject.color ?? '#666' }} />
              <span className="truncate font-semibold">{currentProject.name}</span>
            </>
          ) : currentAgent ? (
            <>
              <span className="shrink-0">{currentAgent.avatar ?? '🤖'}</span>
              <span className="truncate font-semibold">{currentAgent.name}</span>
            </>
          ) : (
            <span className="text-zinc-500">프로젝트</span>
          )}
          <ChevronDown size={12} className="text-zinc-500 shrink-0 ml-auto" />
        </button>
        {projOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto z-50">
            {projects.map((p) => (
              <button key={p.id}
                onClick={() => { onSelectProject(p); setProjOpen(false); }}
                className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${currentProject?.id === p.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}>
                <div className="w-2 h-2 rounded-full" style={{ background: p.color ?? '#666' }} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
            {globalAgents.length > 0 && (
              <>
                <div className="border-t border-zinc-800 px-3 py-1 text-[11px] text-zinc-500">글로벌</div>
                {globalAgents.slice(0, 5).map((a) => (
                  <button key={a.id}
                    onClick={() => { onSelectAgent(a.id); onSelectSession(null); setProjOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${
                      currentAgent?.id === a.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                    }`}>
                    <span>{a.avatar ?? '🤖'}</span><span className="truncate">{a.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Session selector */}
      <div ref={sessRef} className="relative flex-1 min-w-0">
        <button
          onClick={() => { setSessOpen((v) => !v); setProjOpen(false); }}
          className="w-full flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs"
        >
          <span className="truncate">{currentSession?.title ?? '세션 선택'}</span>
          <ChevronDown size={12} className="text-zinc-500 shrink-0 ml-auto" />
        </button>
        {sessOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto z-50">
            <button
              onClick={() => { onNewSession(); setSessOpen(false); }}
              disabled={!canCreate}
              className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-emerald-300 hover:bg-zinc-800/50 disabled:opacity-40 border-b border-zinc-800">
              <Plus size={12} /> 새 세션
            </button>
            {sessions.map((s) => (
              <button key={s.id}
                onClick={() => { onSelectSession(s.id); setSessOpen(false); }}
                className={`w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 ${currentSessionId === s.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}>
                {s.pinned && <Pin size={10} className="text-amber-400 shrink-0" />}
                <span className="truncate flex-1">{s.title}</span>
              </button>
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-zinc-600 text-center italic">세션 없음</div>
            )}
          </div>
        )}
      </div>

      {/* Pin current session */}
      {currentSessionId && (
        <button
          onClick={onTogglePin}
          className={`p-1.5 rounded shrink-0 ${isPinned ? 'text-amber-400 bg-amber-900/30' : 'text-zinc-500 hover:text-amber-400'}`}
          title={isPinned ? '고정 해제' : '고정'}
        >
          <Pin size={14} />
        </button>
      )}
    </div>
  );
}
