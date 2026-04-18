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
import { useT } from '../lib/i18n';
import MessageList from '../components/chat/MessageList';
import StreamingMessage from '../components/chat/StreamingMessage';
import ChatInput from '../components/chat/ChatInput';
import TodoWidget from '../components/chat/TodoWidget';
import { ChatSidebar } from '../components/chat/ChatSidebar';
import { SessionTitleEditor } from '../components/chat/SessionTitleEditor';
import { FrameworkActions } from '../components/chat/FrameworkActions';

export default function ChatPage() {
  const t = useT();
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

  // 채팅 페이지 진입 시 모든 unread 클리어 (채팅 탭 파란 점 잔존 버그 방지)
  const clearAllUnread = useChatStore((s) => s.clearAllUnread);
  useEffect(() => {
    clearAllUnread();
  }, [clearAllUnread]);

  // 현재 세션 열려있으면 자동으로 읽음 처리 (새로고침/탭 복귀/visibility)
  const markRead = useChatStore((s) => s.markRead);
  useEffect(() => {
    if (currentSessionId) markRead(currentSessionId);
  }, [currentSessionId, markRead, sessionQ.data?.messages?.length]);

  // 탭 visibility 변경 시 현재 세션 읽음 처리
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && currentSessionId) markRead(currentSessionId);
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [currentSessionId, markRead]);

  const createSession = useMutation({
    mutationFn: () => api.createSession(currentAgentId!),
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      setCurrentSession(session.id);
    }
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_res, deletedId) => {
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      qc.invalidateQueries({ queryKey: ['sessions-all'] });
      // 삭제된 세션이 unread 에 남아 유령점이 되는 문제 방지
      markRead(deletedId);
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
        ? `${message}\n\n${t('chat.attachmentHeader')}\n${paths.map((p) => `- ${p}`).join('\n')}\n\n${t('chat.attachmentFooter')}`
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

  // 전체 세션 — 프로젝트 선택 시 마지막 세션 찾기용 (같은 key 쿼리는 캐시 공유)
  const projectSelectAllSessionsQ = useQuery<{ sessions: Session[] }>({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    staleTime: 5_000
  });

  // Project selection — 해당 프로젝트 에이전트 중 가장 최근 업데이트된 세션 자동 선택
  const selectProject = (project: Project) => {
    const projectAgentIds = new Set(
      (agentsQ.data ?? []).filter((a) => a.projectId === project.id).map((a) => a.id)
    );
    const projectSessions = (projectSelectAllSessionsQ.data?.sessions ?? [])
      .filter((s) => projectAgentIds.has(s.agentId))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

    const lastSession = projectSessions[0];
    if (lastSession) {
      // 마지막 세션이 있으면 그 세션의 agent + session 모두 설정
      setCurrentAgent(lastSession.agentId);
      setCurrentSession(lastSession.id);
      return;
    }
    // 세션이 없으면 lead(project tier) → addon 순으로 에이전트만 선택
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
            {t('chat.sessionSelectHint')}
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
                <div className="font-semibold text-zinc-500">{t('chat.loading')}</div>
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
                  <Zap size={10} /> {t('chat.running')}
                </div>
              )}
            </div>

            {/* Search bar */}
            {searchOpen && (
              <div className="px-4 lg:px-6 py-2 border-b border-zinc-800 flex items-center gap-2 bg-zinc-900/40">
                <Search size={14} className="text-zinc-500 shrink-0" />
                <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('chat.searchPlaceholder')} className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none" />
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
                  <><AlertTriangle size={12} className="shrink-0" /><span className="flex-1 truncate">{t('chat.escalation')}: {currentSession.loop.escalateReason}</span></>
                ) : (
                  <><RotateCw size={12} className="animate-spin shrink-0" /><span className="flex-1 truncate">Loop {currentSession.loop.currentIteration}/{currentSession.loop.maxIterations}</span></>
                )}
                <button onClick={async () => { if (confirm(t('chat.loopStopConfirm'))) { await api.stopLoop(currentSessionId!); qc.invalidateQueries({ queryKey: ['session', currentSessionId] }); } }}
                  className="shrink-0 px-2 py-1 rounded bg-red-900/50 text-red-200 text-[11px]"><Square size={10} /></button>
              </div>
            )}

            {/* Messages */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 lg:px-6">
              {currentSession && (
                <MessageList
                  key={currentSession.id}
                  messages={currentSession.messages ?? []}
                  searchQuery={searchQuery || undefined}
                  onChoice={(c) => sendMessage.mutate({ message: c, paths: [] })}
                />
              )}
              <StreamingMessage
                text={streaming}
                toolCalls={toolCalls}
                running={running}
                error={error}
                onChoice={(c) => sendMessage.mutate({ message: c, paths: [] })}
              />
            </div>

            {/* Framework action buttons */}
            <FrameworkActions
              disabled={!currentSessionId || running}
              onSend={(msg) => sendMessage.mutate({ message: msg, paths: [] })}
            />

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
                    if (currentSessionId && confirm(t('chat.clearConfirm'))) {
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
                      const title = prompt(t('chat.renamePrompt'), currentSession?.title ?? '');
                      if (title) renameSession.mutate({ id: currentSessionId, title });
                    }
                    break;
                  case 'export':
                    if (currentSessionId) {
                      try { await api.downloadSessionExport(currentSessionId, 'md'); }
                      catch (e) { alert(`${t('chat.exportFailed')}: ${(e as Error).message}`); }
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
                    alert(t('chat.helpMessage'));
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
  const t = useT();
  const [projOpen, setProjOpen] = useState(false);
  const [sessOpen, setSessOpen] = useState(false);
  const projRef = useRef<HTMLDivElement>(null);
  const sessRef = useRef<HTMLDivElement>(null);
  const unread = useChatStore((s) => s.unread);

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

  // 전역 모든 세션 (프로젝트/에이전트 점 계산용)
  const allSessionsQ = useQuery<{ sessions: Session[] }>({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 5000
  });
  // 에이전트별 상태 집계 (현재 열린 세션 + 위임 세션 제외)
  const agentStatus = useMemo(() => {
    const all = allSessionsQ.data?.sessions ?? [];
    const byAgent: Record<string, { unread: boolean; running: boolean }> = {};
    for (const s of all) {
      if (s.title?.startsWith('[위임]')) continue;
      if (!byAgent[s.agentId]) byAgent[s.agentId] = { unread: false, running: false };
      if (unread[s.id] && s.id !== currentSessionId) byAgent[s.agentId].unread = true;
      if (s.isRunning) byAgent[s.agentId].running = true;
    }
    return byAgent;
  }, [allSessionsQ.data, unread, currentSessionId]);
  // 프로젝트별 상태 집계
  const projectStatus = useMemo(() => {
    const byProject: Record<string, { unread: boolean; running: boolean }> = {};
    for (const a of agents) {
      if (!a.projectId) continue;
      const s = agentStatus[a.id];
      if (!s) continue;
      if (!byProject[a.projectId]) byProject[a.projectId] = { unread: false, running: false };
      if (s.unread) byProject[a.projectId].unread = true;
      if (s.running) byProject[a.projectId].running = true;
    }
    return byProject;
  }, [agentStatus, agents]);
  // 세션별 unread (현재 열린 세션 제외)
  const sessionUnread = (sid: string) => !!unread[sid] && sid !== currentSessionId;
  // 상태 점 컴포넌트
  const StatusDot = ({ unread, running }: { unread: boolean; running: boolean }) => {
    if (!unread && !running) return null;
    const color = unread ? 'bg-sky-400' : 'bg-amber-400';
    return <span className={`w-1.5 h-1.5 rounded-full ${color} animate-pulse shrink-0`} />;
  };

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
            <span className="text-zinc-500">{t('chat.mobileProject')}</span>
          )}
          <ChevronDown size={12} className="text-zinc-500 shrink-0 ml-auto" />
        </button>
        {projOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto z-50">
            {/* Global agents first */}
            {globalAgents.length > 0 && (
              <>
                <div className="px-3 py-1 text-[11px] text-zinc-500">{t('chat.mobileGlobal')}</div>
                {globalAgents.slice(0, 5).map((a) => {
                  const st = agentStatus[a.id] ?? { unread: false, running: false };
                  return (
                    <button key={a.id}
                      onClick={() => { onSelectAgent(a.id); onSelectSession(null); setProjOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${
                        currentAgent?.id === a.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                      }`}>
                      <span>{a.avatar ?? '🤖'}</span>
                      <span className="truncate flex-1">{a.name}</span>
                      <StatusDot unread={st.unread} running={st.running} />
                    </button>
                  );
                })}
                <div className="border-t border-zinc-800" />
              </>
            )}
            {/* Projects */}
            {projects.map((p) => {
              const pst = projectStatus[p.id] ?? { unread: false, running: false };
              return (
                <button key={p.id}
                  onClick={() => { onSelectProject(p); setProjOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${currentProject?.id === p.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}>
                  <div className="w-2 h-2 rounded-full" style={{ background: p.color ?? '#666' }} />
                  <span className="truncate flex-1">{p.name}</span>
                  <StatusDot unread={pst.unread} running={pst.running} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Session selector */}
      <div ref={sessRef} className="relative flex-1 min-w-0">
        <button
          onClick={() => { setSessOpen((v) => !v); setProjOpen(false); }}
          className="w-full flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs"
        >
          <span className="truncate">{currentSession?.title ?? t('chat.mobileSessionSelect')}</span>
          <ChevronDown size={12} className="text-zinc-500 shrink-0 ml-auto" />
        </button>
        {sessOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto z-50">
            <button
              onClick={() => { onNewSession(); setSessOpen(false); }}
              disabled={!canCreate}
              className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-emerald-300 hover:bg-zinc-800/50 disabled:opacity-40 border-b border-zinc-800">
              <Plus size={12} /> {t('chat.mobileNewSession')}
            </button>
            {sessions.map((s) => (
              <button key={s.id}
                onClick={() => { onSelectSession(s.id); setSessOpen(false); }}
                className={`w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 ${currentSessionId === s.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}>
                {s.pinned && <Pin size={10} className="text-amber-400 shrink-0" />}
                <span className="truncate flex-1">{s.title}</span>
                <StatusDot unread={sessionUnread(s.id)} running={!!s.isRunning} />
              </button>
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-zinc-600 text-center italic">{t('chat.mobileNoSessions')}</div>
            )}
          </div>
        )}
      </div>

      {/* Pin current session */}
      {currentSessionId && (
        <button
          onClick={onTogglePin}
          className={`p-1.5 rounded shrink-0 ${isPinned ? 'text-amber-400 bg-amber-900/30' : 'text-zinc-500 hover:text-amber-400'}`}
          title={isPinned ? t('chat.unpin') : t('chat.pin')}
        >
          <Pin size={14} />
        </button>
      )}
    </div>
  );
}
