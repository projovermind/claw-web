import { useEffect, useState, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, DragStartEvent, DragOverlay,
  PointerSensor, useSensor, useSensors
} from '@dnd-kit/core';
import { Plus, Pin, ChevronDown, ListTodo, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { api } from '../lib/api';
import type { Session, SessionMeta, ChatMessage, Agent, Project } from '../lib/types';
import { isSessionRunning } from '../lib/visibility';
import { useChatStore, selectActiveWorkspace } from '../store/chat-store';
import { useProgressToastStore } from '../store/progress-toast-store';
import { useT } from '../lib/i18n';
import ChatInput from '../components/chat/ChatInput';
import ContextUsageBadge from '../components/chat/ContextUsageBadge';
import { modelContextWindow } from '../lib/context-window';
import TodoWidget from '../components/chat/TodoWidget';
import { ChatSidebar } from '../components/chat/ChatSidebar';
import { FrameworkActions } from '../components/chat/FrameworkActions';
import DelegationStatusBar from '../components/layout/DelegationStatusBar';
import SplitToolbar from '../components/chat/SplitToolbar';
import WorkspaceGrid from '../components/chat/WorkspaceGrid';
import ChatPane from '../components/chat/ChatPane';

export default function ChatPage() {
  const t = useT();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const setCurrentAgent = useChatStore((s) => s.setCurrentAgent);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const runtime = useChatStore((s) => (currentSessionId ? s.runtime[currentSessionId] : undefined));

  // Workspace state
  const activeWs = useChatStore(selectActiveWorkspace);
  const setActivePane = useChatStore((s) => s.setActivePane);
  const setPaneSession = useChatStore((s) => s.setPaneSession);
  const swapPanes = useChatStore((s) => s.swapPanes);

  const { startTask, completeTask, failTask } = useProgressToastStore();

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
  const sessionsQ = useQuery({
    queryKey: ['sessions', currentAgentId],
    queryFn: () => (currentAgentId ? api.sessions(currentAgentId) : Promise.resolve([])),
    enabled: !!currentAgentId
  });
  // For MobileHeader + mutations that need current session title
  const sessionQ = useQuery({
    queryKey: ['session', currentSessionId],
    queryFn: () => api.session(currentSessionId!),
    enabled: !!currentSessionId,
    refetchInterval: runtime?.running ? 5000 : false
  });

  // Fallback 으로 "첫 에이전트" 를 자동 선택하는 것은 **최초 마운트 1회** 에만 수행.
  // 이후 currentAgentId 가 null 이 되더라도(예: 워크스페이스 전환 후 active pane 이
  // 빈 pane / 레이아웃 count 변경 후 빈 슬롯이 active) 사용자가 의도적으로 비운
  // 상태일 수 있으므로, 사이드바 컨텍스트를 "메인(=agents[0]) 에이전트"로 되돌리지
  // 않음. 그렇지 않으면 "레이아웃 빈공간을 선택 시 사이드바가 메인 에이전트 세션
  // 리스트로 점프" 하는 버그가 재발함.
  //
  // 또한 persist 된 어떤 pane 이라도 이미 agent/session 을 갖고 있다면 자동
  // 선택을 스킵한다. setCurrentAgent 는 active pane 의 agentId 를 덮어쓰므로,
  // 새로고침 직후 활성 pane 이 "빈 pane" 이라는 이유로 fallback 이 실행되면
  // 유저가 지정해둔 레이아웃(어떤 pane 에 어떤 세션) 이 부분적으로 망가져
  // "새로고침하면 레이아웃이 초기화됨" 으로 체감됨.
  const didInitAgentRef = useRef(false);
  useEffect(() => {
    if (didInitAgentRef.current) return;
    if (!agentsQ.data || agentsQ.data.length === 0) return;
    const state = useChatStore.getState();
    const hasAssignedPane = state.workspaces.some((w) =>
      w.panes.some((p) => p.agentId || p.sessionId)
    );
    if (!currentAgentId && !hasAssignedPane) {
      setCurrentAgent(agentsQ.data[0].id);
    }
    didInitAgentRef.current = true;
  }, [agentsQ.data, currentAgentId, setCurrentAgent]);

  const createSession = useMutation({
    mutationFn: () => api.createSession(currentAgentId!),
    onMutate: () => { startTask({ id: 'create-session', title: '세션 생성 중...' }); },
    onSuccess: async (session) => {
      await qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      setCurrentSession(session.id);
      requestAnimationFrame(() => completeTask('create-session', '세션 생성 완료'));
    },
    onError: (err) => failTask('create-session', (err as Error).message)
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onMutate: async (id) => {
      const taskId = `delete-session-${id}`;
      startTask({ id: taskId, title: '세션 삭제 중...' });
      await qc.cancelQueries({ queryKey: ['sessions', currentAgentId] });
      const prev = qc.getQueryData(['sessions', currentAgentId]);
      qc.setQueryData(['sessions', currentAgentId], (old: unknown) =>
        Array.isArray(old) ? old.filter((s: { id: string }) => s.id !== id) : old
      );
      return { taskId, prev };
    },
    onSuccess: async (_res, deletedId, ctx) => {
      await qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      await qc.invalidateQueries({ queryKey: ['sessions-all'] });
      // 삭제된 세션이 어떤 pane 에 있었다면 비우기
      const state = useChatStore.getState();
      for (const ws of state.workspaces) {
        for (const p of ws.panes) {
          if (p.sessionId === deletedId) setPaneSession(p.id, null, null);
        }
      }
      requestAnimationFrame(() => completeTask(ctx!.taskId, '삭제 완료'));
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['sessions', currentAgentId], ctx.prev);
      if (ctx?.taskId) failTask(ctx.taskId, (_err as Error).message);
    }
  });

  const sendMessage = useMutation({
    mutationFn: ({ sessionId, message, paths }: { sessionId: string; message: string; paths: string[] }) =>
      api.sendMessage(sessionId, message, paths),
    onMutate: async ({ sessionId, message, paths }) => {
      await qc.cancelQueries({ queryKey: ['session', sessionId] });
      const prev = qc.getQueryData<Session>(['session', sessionId]);
      const content = paths.length > 0
        ? `${message}\n\n${t('chat.attachmentHeader')}\n${paths.map((p) => `- ${p}`).join('\n')}\n\n${t('chat.attachmentFooter')}`
        : message;
      const optimistic: ChatMessage = { role: 'user', content, ts: new Date().toISOString() };
      qc.setQueryData<Session>(['session', sessionId], (old) =>
        old ? { ...old, messages: [...(old.messages ?? []), optimistic] } : old
      );
      return { prev, sessionId };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev && ctx.sessionId) qc.setQueryData(['session', ctx.sessionId], ctx.prev);
    }
  });

  const abortChat = () => {
    if (currentSessionId) api.abortChat(currentSessionId).catch(() => {});
  };

  const renameSession = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameSession(id, title),
    onMutate: () => { startTask({ id: 'rename-session', title: '세션 이름 변경 중...' }); },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['session', currentSessionId] });
      await qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      requestAnimationFrame(() => completeTask('rename-session', '이름 변경 완료'));
    },
    onError: (err) => failTask('rename-session', (err as Error).message)
  });

  const pinSession = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api.pinSession(id, pinned),
    onMutate: ({ pinned }) => {
      startTask({ id: 'pin-session', title: pinned ? '세션 고정 중...' : '고정 해제 중...' });
      return { pinned };
    },
    onSuccess: async (_res, vars) => {
      await qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      await qc.invalidateQueries({ queryKey: ['session', currentSessionId] });
      requestAnimationFrame(() => completeTask('pin-session', vars.pinned ? '고정 완료' : '해제 완료'));
    },
    onError: (err) => failTask('pin-session', (err as Error).message)
  });

  const running = runtime?.running ?? false;
  const todos = runtime?.todos ?? [];

  // 오른쪽 진행 사이드바 토글 (localStorage 영속)
  const [todoCollapsed, setTodoCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('chatTodoCollapsed') === '1';
  });
  const toggleTodoCollapsed = () => {
    setTodoCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem('chatTodoCollapsed', next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  };

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

  // Composer context-window gauge — derived from the last assistant turn's
  // (input + cache_read) tokens, NOT a cumulative session sum. Once Claude CLI
  // compacts the session, this naturally drops on the next response.
  const contextUsageBadge = useMemo(() => {
    const msgs = sessionQ.data?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant' || !m.usage) continue;
      const used = (m.usage.inputTokens ?? 0) + (m.usage.cacheReadTokens ?? 0);
      if (used <= 0) return null;
      const max = modelContextWindow(m.model ?? currentAgent?.model);
      return <ContextUsageBadge used={used} max={max} />;
    }
    return null;
  }, [sessionQ.data?.messages, currentAgent?.model]);

  const projectSelectAllSessionsQ = useQuery<{ sessions: SessionMeta[] }>({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    staleTime: 5_000
  });

  const selectProject = (project: Project) => {
    const lead = (agentsQ.data ?? []).find(
      (a) => a.projectId === project.id && a.tier === 'project'
    );
    const projectAgentIds = new Set(
      (agentsQ.data ?? []).filter((a) => a.projectId === project.id).map((a) => a.id)
    );
    const projectSessions = (projectSelectAllSessionsQ.data?.sessions ?? [])
      .filter((s) => projectAgentIds.has(s.agentId) && !s.isDelegation)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

    const leadSession = lead ? projectSessions.find((s) => s.agentId === lead.id) : undefined;
    const lastSession = leadSession ?? projectSessions[0];

    if (lastSession) {
      setCurrentAgent(lastSession.agentId);
      setCurrentSession(lastSession.id);
      return;
    }
    const target = lead ?? (agentsQ.data ?? []).find((a) => a.projectId === project.id);
    if (target) setCurrentAgent(target.id);
    setCurrentSession(null);
  };

  // DnD sensors — 5px movement threshold so clicks still work
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  /** 드래그 중인 아이템 메타 — DragOverlay 프리뷰 렌더용 */
  interface DragItem {
    kind: 'session' | 'pane-drag';
    sessionId?: string;
    agentId?: string;
    paneId?: string;
  }
  const [activeDrag, setActiveDrag] = useState<DragItem | null>(null);

  const handleDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as DragItem | undefined;
    if (data && (data.kind === 'session' || data.kind === 'pane-drag')) {
      setActiveDrag(data);
    }
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = e;
    if (!over) return;
    const activeData = active.data.current as
      | { kind?: string; sessionId?: string | null; agentId?: string | null; paneId?: string }
      | undefined;
    const overData = over.data.current as
      | { kind?: string; paneId?: string; workspaceId?: string }
      | undefined;
    if (overData?.kind !== 'pane' || !overData.paneId) return;

    // 1) 사이드바 세션 → pane 에 장착
    if (activeData?.kind === 'session') {
      if (!activeData.sessionId || !activeData.agentId) return;
      setPaneSession(overData.paneId, activeData.agentId, activeData.sessionId);
      setActivePane(overData.paneId);
      return;
    }

    // 2) pane → pane (위치 swap)
    if (activeData?.kind === 'pane-drag' && activeData.paneId) {
      if (activeData.paneId === overData.paneId) return;
      swapPanes(activeData.paneId, overData.paneId);
      setActivePane(overData.paneId);
    }
  };

  /** DragOverlay 에 표시할 프리뷰 빌드
   *  - `whitespace-nowrap` 은 한글이 세로로 쌓이는 걸 막는다(포털 렌더라 부모
   *    narrow 컨텍스트 상속 가능성 존재).
   *  - `w-max` 로 내용에 딱 맞게 확장되게 하고 `max-w` 로만 상한 지정. */
  const dragPreview = useMemo(() => {
    if (!activeDrag) return null;
    if (activeDrag.kind === 'session') {
      const allSessions = projectSelectAllSessionsQ.data?.sessions ?? [];
      const s = allSessions.find((x) => x.id === activeDrag.sessionId);
      const agent = (agentsQ.data ?? []).find((a) => a.id === activeDrag.agentId);
      const title = s?.title || '세션';
      const agentName = agent?.name || agent?.id || '';
      return (
        <div className="pointer-events-none inline-flex items-center gap-2 rounded-lg border border-sky-500/70 bg-zinc-900/95 backdrop-blur px-3.5 py-2 text-sm text-zinc-100 shadow-2xl shadow-black/60 ring-1 ring-sky-400/40 w-max max-w-[360px] whitespace-nowrap">
          <span className="text-sky-300 shrink-0">{agent?.avatar ?? '💬'}</span>
          <span className="font-medium truncate">{title}</span>
          {agentName && (
            <span className="text-zinc-500 text-[11px] shrink-0 border-l border-zinc-700 pl-2">
              {agentName}
            </span>
          )}
        </div>
      );
    }
    // pane-drag
    return (
      <div className="pointer-events-none inline-flex items-center gap-2 rounded-lg border border-sky-500/70 bg-zinc-900/95 backdrop-blur px-3.5 py-2 text-sm text-zinc-100 shadow-2xl shadow-black/60 ring-1 ring-sky-400/40 w-max whitespace-nowrap">
          <span className="text-sky-300 shrink-0">⇄</span>
          <span className="font-medium">패널 이동 중</span>
      </div>
    );
  }, [activeDrag, projectSelectAllSessionsQ.data, agentsQ.data]);

  /** pane count 에 따른 폰트 스케일 */
  const paneScale = (() => {
    const n = activeWs?.count ?? 1;
    if (n <= 1) return 1.0;
    if (n === 2) return 0.9;
    if (n === 3) return 0.8;
    if (n === 4) return 0.75;
    return 0.7; // 5, 6
  })();

  return (
    <div className="flex-1 min-h-0 flex">
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

      <div className="flex-1 flex flex-col min-w-0">
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

        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <SplitToolbar />

          {/* Workspace grid */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            <DelegationStatusBar />
            <div className="flex-1 min-h-0">
              {activeWs && (
                <WorkspaceGrid
                  key={`${activeWs.id}-${activeWs.count}-${activeWs.layoutResetKey ?? 0}`}
                  workspaceId={activeWs.id}
                  count={activeWs.count}
                  resetKey={activeWs.layoutResetKey ?? 0}
                  renderPane={(i) => {
                    const pane = activeWs.panes[i];
                    if (!pane) return null;
                    return (
                      <ChatPane
                        paneId={pane.id}
                        workspaceId={activeWs.id}
                        agentId={pane.agentId}
                        sessionId={pane.sessionId}
                        isActive={activeWs.activePaneId === pane.id}
                        isCompact={activeWs.count > 1}
                        scale={paneScale}
                        onActivate={() => setActivePane(pane.id)}
                        onSendMessage={(msg) => {
                          if (pane.sessionId) {
                            sendMessage.mutate({ sessionId: pane.sessionId, message: msg, paths: [] });
                          }
                        }}
                      />
                    );
                  }}
                />
              )}
            </div>
          </div>

          {/* Framework actions — target active pane */}
          <FrameworkActions
            disabled={!currentSessionId || running}
            onSend={(msg) => {
              if (currentSessionId) sendMessage.mutate({ sessionId: currentSessionId, message: msg, paths: [] });
            }}
          />

          {/* Shared input — targets active pane's session */}
          <ChatInput
            disabled={!currentSessionId}
            running={running}
            sessionId={currentSessionId}
            workingDir={currentAgent?.workingDir ?? null}
            bottomRightSlot={contextUsageBadge}
            onSend={(msg, paths) => {
              if (currentSessionId) sendMessage.mutate({ sessionId: currentSessionId, message: msg, paths });
            }}
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
                case 'help':
                  alert(t('chat.helpMessage'));
                  break;
              }
            }}
          />

          {/* 드래그 프리뷰 — DragOverlay 는 포털로 body 에 렌더되므로
              어느 pane / sidebar 위에서도 커서를 깔끔하게 따라다님. */}
          <DragOverlay dropAnimation={{ duration: 150 }}>
            {dragPreview}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Todo sidebar (desktop only) — 접혀있을 때는 얇은 레일만 표시해서 토글 가능
          Todo 가 비어있어도 레일은 항상 노출되도록 해서 사용자가 언제든지
          패널을 펼칠 수 있게 함 (그렇지 않으면 "숨기기/보이기 버튼이 안 보인다"는
          피드백이 반복됨). */}
      {(
        todoCollapsed ? (
          <aside className="hidden lg:flex w-8 shrink-0 border-l border-zinc-800 bg-zinc-950/60 flex-col items-center py-3 gap-2">
            <button
              type="button"
              onClick={toggleTodoCollapsed}
              className="p-1.5 rounded hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-200"
              title="진행 패널 펼치기"
            >
              <PanelRightOpen className="w-4 h-4" />
            </button>
            <div className="flex flex-col items-center gap-1 text-zinc-500">
              <ListTodo className="w-4 h-4" />
              <span className="text-[10px] tabular-nums">
                {todos.filter((x) => x.status === 'completed').length}/{todos.length}
              </span>
            </div>
          </aside>
        ) : (
          <aside className="hidden lg:flex w-72 shrink-0 border-l border-zinc-800 bg-zinc-950/60 flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60">
              <span className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <ListTodo className="w-3.5 h-3.5" /> 진행
              </span>
              <button
                type="button"
                onClick={toggleTodoCollapsed}
                className="p-1 rounded hover:bg-zinc-800/80 text-zinc-500 hover:text-zinc-300"
                title="진행 패널 숨기기"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {todos.length > 0 ? (
                <TodoWidget todos={todos} />
              ) : (
                <div className="text-[11px] text-zinc-600 leading-relaxed">
                  진행 중인 Todo 가 없습니다.<br />
                  에이전트가 TodoWrite 도구로 계획을 세우면 여기에 표시됩니다.
                </div>
              )}
            </div>
          </aside>
        )
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
  sessions: SessionMeta[];
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
  const runtimeAll = useChatStore((s) => s.runtime);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (projOpen && !projRef.current?.contains(e.target as Node)) setProjOpen(false);
      if (sessOpen && !sessRef.current?.contains(e.target as Node)) setSessOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [projOpen, sessOpen]);

  const globalAgents = agents.filter((a) => a.tier === 'main' || (!a.projectId && !a.tier));

  const allSessionsQ = useQuery<{ sessions: SessionMeta[] }>({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 5000
  });
  const agentStatus = useMemo(() => {
    const all = allSessionsQ.data?.sessions ?? [];
    const byAgent: Record<string, { unread: boolean; running: boolean }> = {};
    for (const s of all) {
      if (s.title?.startsWith('[위임]')) continue;
      if (!byAgent[s.agentId]) byAgent[s.agentId] = { unread: false, running: false };
      if (unread[s.id] && s.id !== currentSessionId) byAgent[s.agentId].unread = true;
      if (isSessionRunning(s, runtimeAll)) byAgent[s.agentId].running = true;
    }
    return byAgent;
  }, [allSessionsQ.data, unread, currentSessionId, runtimeAll]);
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
  const sessionUnread = (sid: string) => !!unread[sid] && sid !== currentSessionId;
  const isHiddenDelegation = (s: SessionMeta) => s.title?.startsWith('[위임]');
  const runningSessions = useMemo(() => {
    const all = allSessionsQ.data?.sessions ?? [];
    return all.filter((s: SessionMeta) => isSessionRunning(s, runtimeAll) && !isHiddenDelegation(s));
  }, [allSessionsQ.data, runtimeAll]);
  const unreadSessions = useMemo(() => {
    const all = allSessionsQ.data?.sessions ?? [];
    return all.filter((s: SessionMeta) =>
      unread[s.id] && s.id !== currentSessionId && !isHiddenDelegation(s)
    );
  }, [allSessionsQ.data, unread, currentSessionId]);
  const StatusDot = ({ unread, running }: { unread: boolean; running: boolean }) => {
    if (!unread && !running) return null;
    const color = unread ? 'bg-sky-400' : 'bg-amber-400';
    return <span className={`w-1.5 h-1.5 rounded-full ${color} animate-pulse shrink-0`} />;
  };

  return (
    <div className="lg:hidden flex items-center gap-1.5 px-2 py-2 border-b border-zinc-800 bg-zinc-950/90 relative z-20">
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
          {currentProject
            ? <StatusDot unread={projectStatus[currentProject.id]?.unread ?? false} running={projectStatus[currentProject.id]?.running ?? false} />
            : currentAgent
            ? <StatusDot unread={agentStatus[currentAgent.id]?.unread ?? false} running={agentStatus[currentAgent.id]?.running ?? false} />
            : null}
        </button>
        {projOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto z-50">
            {runningSessions.length > 0 && (
              <>
                <div className="px-3 py-1 text-[11px] text-amber-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {t('dashboard.stat.running')} ({runningSessions.length})
                </div>
                {runningSessions.map((s) => {
                  const agent = agents.find((a) => a.id === s.agentId);
                  return (
                    <button key={s.id}
                      onClick={() => { onSelectAgent(s.agentId); onSelectSession(s.id); setProjOpen(false); }}
                      className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-zinc-800/50">
                      <span>{agent?.avatar ?? '🤖'}</span>
                      <span className="truncate flex-1">{s.title}</span>
                      <span className="text-[10px] text-amber-400 shrink-0 animate-pulse">● running</span>
                    </button>
                  );
                })}
                <div className="border-t border-zinc-800" />
              </>
            )}
            {unreadSessions.length > 0 && (
              <>
                <div className="px-3 py-1 text-[11px] text-sky-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                  읽지 않음 ({unreadSessions.length})
                </div>
                {unreadSessions.map((s) => {
                  const agent = agents.find((a) => a.id === s.agentId);
                  return (
                    <button key={s.id}
                      onClick={() => { onSelectAgent(s.agentId); onSelectSession(s.id); setProjOpen(false); }}
                      className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-zinc-800/50">
                      <span>{agent?.avatar ?? '🤖'}</span>
                      <span className="truncate flex-1">{s.title}</span>
                      <span className="text-[10px] text-sky-400 shrink-0">● unread</span>
                    </button>
                  );
                })}
                <div className="border-t border-zinc-800" />
              </>
            )}
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

      <div ref={sessRef} className="relative flex-1 min-w-0">
        <button
          onClick={() => { setSessOpen((v) => !v); setProjOpen(false); }}
          className="w-full flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs"
        >
          <span className="truncate flex-1">{currentSession?.title ?? t('chat.mobileSessionSelect')}</span>
          <ChevronDown size={12} className="text-zinc-500 shrink-0" />
          <StatusDot
            unread={sessions.some(s => sessionUnread(s.id))}
            running={sessions.some(s => isSessionRunning(s, runtimeAll) && s.id !== currentSessionId)}
          />
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
                <StatusDot unread={sessionUnread(s.id)} running={isSessionRunning(s, runtimeAll)} />
              </button>
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-zinc-600 text-center italic">{t('chat.mobileNoSessions')}</div>
            )}
          </div>
        )}
      </div>

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
