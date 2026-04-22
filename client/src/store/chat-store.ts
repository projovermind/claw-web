import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  ts: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface SessionRuntime {
  streaming: string;
  toolCalls: ToolCall[];
  todos: TodoItem[];
  running: boolean;
  error: string | null;
}

export type PaneCount = 1 | 2 | 3 | 4 | 5 | 6;

export interface Pane {
  id: string;
  agentId: string | null;
  sessionId: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  count: PaneCount;
  panes: Pane[];
  activePaneId: string;
  /** 레이아웃 버튼 재클릭 시 증가 — autoSaveId 에 포함시켜 persist 된 사이즈를 초기화. */
  layoutResetKey?: number;
}

interface ChatState {
  /** Workspaces (top tabs). Each holds its own split layout + panes. */
  workspaces: Workspace[];
  activeWorkspaceId: string;

  /**
   * Legacy fields — kept in sync with the active pane of the active workspace
   * so existing consumers (DashboardPage, ChatSidebar, FilePalette, Sidebar)
   * keep working without refactor.
   */
  currentAgentId: string | null;
  currentSessionId: string | null;

  runtime: Record<string, SessionRuntime>;
  unread: Record<string, { at: number; isError?: boolean }>;
  delegatingSessionIds: Set<string>;

  // Legacy setters — update active pane AND legacy fields
  setCurrentAgent: (id: string | null) => void;
  setCurrentSession: (id: string | null) => void;

  // Workspace actions
  addWorkspace: () => string;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWorkspaceCount: (wsId: string, count: PaneCount) => void;
  /** 레이아웃 크기(퍼센트) 초기화 — 같은 count 버튼 재클릭 시 호출. */
  resetWorkspaceLayout: (wsId: string) => void;
  setActivePane: (paneId: string) => void;
  /** Set (agentId, sessionId) of a specific pane. Pass null to clear. */
  setPaneSession: (paneId: string, agentId: string | null, sessionId: string | null) => void;
  /** 두 pane 의 (agentId, sessionId) 교환. */
  swapPanes: (paneIdA: string, paneIdB: string) => void;

  // Runtime (unchanged)
  startRun: (sessionId: string) => void;
  appendChunk: (sessionId: string, text: string) => void;
  addToolCall: (sessionId: string, tool: { name: string; input: Record<string, unknown> }) => void;
  finishRun: (sessionId: string, error?: string | null) => void;
  markUnread: (sessionId: string) => void;
  markRead: (sessionId: string) => void;
  startDelegating: (sessionId: string) => void;
  finishDelegating: (sessionId: string) => void;
  purgeUnread: (validIds: Set<string>) => void;
  clearAllUnread: () => void;
}

const emptyRuntime = (): SessionRuntime => ({
  streaming: '',
  toolCalls: [],
  todos: [],
  running: false,
  error: null
});

function createPane(agentId: string | null = null, sessionId: string | null = null): Pane {
  return { id: nanoid(8), agentId, sessionId };
}

function createWorkspace(name: string, initAgentId: string | null = null, initSessionId: string | null = null): Workspace {
  const pane = createPane(initAgentId, initSessionId);
  return {
    id: nanoid(8),
    name,
    count: 1,
    panes: [pane],
    activePaneId: pane.id
  };
}

/**
 * Grow panes to at least `target`. NEVER trims — extra panes are preserved
 * offscreen so that shrinking (e.g. 4 → 1) and expanding back (1 → 4)
 * restores the previous session/agent in each slot.
 * 실제 렌더는 `count` 개수만큼만 표시되므로 남은 pane 은 숨겨진 상태로 유지됨.
 */
function resizePanes(panes: Pane[], target: PaneCount): Pane[] {
  const next = [...panes];
  while (next.length < target) next.push(createPane());
  return next;
}

/** Find the active workspace and its active pane. */
function getActive(state: Pick<ChatState, 'workspaces' | 'activeWorkspaceId'>) {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0];
  if (!ws) return { ws: null as Workspace | null, pane: null as Pane | null };
  const pane = ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0] ?? null;
  return { ws, pane };
}

/** react-resizable-panels 가 자동 저장한 사이즈 정보 제거 (레이아웃 reset 용). */
function clearPanelGroupStorage(wsId: string, count: PaneCount) {
  if (typeof window === 'undefined') return;
  try {
    const prefixes = [`claw-split-${wsId}-${count}`];
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (prefixes.some((p) => key.includes(p))) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore storage errors
  }
}

const defaultWorkspace = createWorkspace('워크스페이스 1');

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      workspaces: [defaultWorkspace],
      activeWorkspaceId: defaultWorkspace.id,
      currentAgentId: null,
      currentSessionId: null,
      runtime: {},
      unread: {},
      delegatingSessionIds: new Set<string>(),

      setCurrentAgent: (agentId) =>
        set((s) => {
          const { ws, pane } = getActive(s);
          if (!ws || !pane) return { currentAgentId: agentId };
          const panes = ws.panes.map((p) => (p.id === pane.id ? { ...p, agentId } : p));
          const workspaces = s.workspaces.map((w) => (w.id === ws.id ? { ...w, panes } : w));
          return { workspaces, currentAgentId: agentId };
        }),

      setCurrentSession: (sessionId) =>
        set((s) => {
          const { ws, pane } = getActive(s);
          const nextUnread = { ...s.unread };
          if (sessionId) delete nextUnread[sessionId];
          if (!ws || !pane) return { currentSessionId: sessionId, unread: nextUnread };
          const panes = ws.panes.map((p) => (p.id === pane.id ? { ...p, sessionId } : p));
          const workspaces = s.workspaces.map((w) => (w.id === ws.id ? { ...w, panes } : w));
          return { workspaces, currentSessionId: sessionId, unread: nextUnread };
        }),

      addWorkspace: () => {
        const ws = createWorkspace(`워크스페이스 ${get().workspaces.length + 1}`);
        set((s) => ({
          workspaces: [...s.workspaces, ws],
          activeWorkspaceId: ws.id,
          currentAgentId: null,
          currentSessionId: null
        }));
        return ws.id;
      },

      removeWorkspace: (id) =>
        set((s) => {
          if (s.workspaces.length <= 1) return s;
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          let activeWorkspaceId = s.activeWorkspaceId;
          let currentAgentId = s.currentAgentId;
          let currentSessionId = s.currentSessionId;
          if (activeWorkspaceId === id) {
            const next = workspaces[0];
            activeWorkspaceId = next.id;
            const pane = next.panes.find((p) => p.id === next.activePaneId) ?? next.panes[0];
            // 새 active pane 이 빈 pane 이면 legacy 필드를 유지(null 로 덮지 않음).
            // 그렇지 않으면 사이드바가 "메인 에이전트" 로 점프함.
            if (pane?.agentId || pane?.sessionId) {
              currentAgentId = pane.agentId ?? null;
              currentSessionId = pane.sessionId ?? null;
            }
          }
          return { workspaces, activeWorkspaceId, currentAgentId, currentSessionId };
        }),

      setActiveWorkspace: (id) =>
        set((s) => {
          const ws = s.workspaces.find((w) => w.id === id);
          if (!ws) return s;
          const pane = ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0];
          // 전환한 ws 의 active pane 이 빈 pane 이면 legacy 필드 유지.
          // (그렇지 않으면 ChatPage fallback 이 "메인 에이전트" 로 돌리는 버그 재발)
          if (!pane?.agentId && !pane?.sessionId) {
            return { activeWorkspaceId: id };
          }
          return {
            activeWorkspaceId: id,
            currentAgentId: pane.agentId ?? null,
            currentSessionId: pane.sessionId ?? null
          };
        }),

      renameWorkspace: (id, name) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
        })),

      setWorkspaceCount: (wsId, count) =>
        set((s) => {
          const workspaces = s.workspaces.map((w) => {
            if (w.id !== wsId) return w;
            // 같은 count 버튼 재클릭 → 크기만 초기화 (pane 구성 유지)
            if (w.count === count) {
              clearPanelGroupStorage(wsId, count);
              return { ...w, layoutResetKey: (w.layoutResetKey ?? 0) + 1 };
            }
            // count 변경 → pane 수 조정 + 크기 저장소 정리
            clearPanelGroupStorage(wsId, w.count);
            const panes = resizePanes(w.panes, count);
            // 보이는 범위(0..count-1) 내에 현재 activePane 이 있는 경우 유지
            // 아니면 첫번째(=panes[0]) 로 리셋
            const activeIdx = panes.findIndex((p) => p.id === w.activePaneId);
            const activePaneId = activeIdx >= 0 && activeIdx < count ? w.activePaneId : panes[0].id;
            return { ...w, count, panes, activePaneId, layoutResetKey: (w.layoutResetKey ?? 0) + 1 };
          });
          if (s.activeWorkspaceId === wsId) {
            const ws = workspaces.find((w) => w.id === wsId)!;
            const pane = ws.panes.find((p) => p.id === ws.activePaneId)!;
            // 레이아웃 변경 후 active pane 이 빈 pane 이면 legacy 필드 유지.
            if (!pane.agentId && !pane.sessionId) {
              return { workspaces };
            }
            return { workspaces, currentAgentId: pane.agentId, currentSessionId: pane.sessionId };
          }
          return { workspaces };
        }),

      resetWorkspaceLayout: (wsId) =>
        set((s) => {
          const ws = s.workspaces.find((w) => w.id === wsId);
          if (!ws) return s;
          clearPanelGroupStorage(wsId, ws.count);
          const workspaces = s.workspaces.map((w) =>
            w.id === wsId ? { ...w, layoutResetKey: (w.layoutResetKey ?? 0) + 1 } : w
          );
          return { workspaces };
        }),

      setActivePane: (paneId) =>
        set((s) => {
          const { ws } = getActive(s);
          if (!ws) return s;
          const pane = ws.panes.find((p) => p.id === paneId);
          if (!pane) return s;
          const workspaces = s.workspaces.map((w) =>
            w.id === ws.id ? { ...w, activePaneId: paneId } : w
          );
          // 빈 pane 을 active 로 만들 땐 사이드바 컨텍스트를 유지
          // (currentAgentId/currentSessionId 를 null 로 덮어쓰지 않음)
          if (!pane.agentId && !pane.sessionId) {
            return { workspaces };
          }
          return {
            workspaces,
            currentAgentId: pane.agentId,
            currentSessionId: pane.sessionId
          };
        }),

      swapPanes: (paneIdA, paneIdB) =>
        set((s) => {
          if (paneIdA === paneIdB) return s;
          let swapped = false;
          const workspaces = s.workspaces.map((w) => {
            const a = w.panes.find((p) => p.id === paneIdA);
            const b = w.panes.find((p) => p.id === paneIdB);
            if (!a || !b) return w;
            swapped = true;
            const panes = w.panes.map((p) => {
              if (p.id === paneIdA) return { ...p, agentId: b.agentId, sessionId: b.sessionId };
              if (p.id === paneIdB) return { ...p, agentId: a.agentId, sessionId: a.sessionId };
              return p;
            });
            return { ...w, panes };
          });
          if (!swapped) return s;
          // 활성 pane 의 세션이 바뀌었을 수 있으니 legacy fields 재계산
          const { pane } = getActive({ workspaces, activeWorkspaceId: s.activeWorkspaceId });
          return {
            workspaces,
            currentAgentId: pane?.agentId ?? s.currentAgentId,
            currentSessionId: pane?.sessionId ?? s.currentSessionId
          };
        }),

      setPaneSession: (paneId, agentId, sessionId) =>
        set((s) => {
          let touchedActivePane = false;
          const workspaces = s.workspaces.map((w) => {
            if (!w.panes.some((p) => p.id === paneId)) return w;
            const panes = w.panes.map((p) => {
              if (p.id !== paneId) return p;
              if (w.id === s.activeWorkspaceId && w.activePaneId === paneId) touchedActivePane = true;
              return { ...p, agentId, sessionId };
            });
            return { ...w, panes };
          });
          const nextUnread = { ...s.unread };
          if (sessionId) delete nextUnread[sessionId];
          if (touchedActivePane) {
            // 페인을 '비우는' 경우(agentId=null & sessionId=null) 에는 사이드바의
            // 현재 에이전트/세션 컨텍스트를 그대로 둔다. 그렇지 않으면 ChatPage 의
            // useEffect 가 currentAgentId=null 을 감지해 agentsQ.data[0] 으로
            // 되돌려버려 사이드바가 "메인 에이전트 세션 리스트" 로 점프함.
            const isClearing = agentId === null && sessionId === null;
            if (isClearing) {
              return { workspaces, unread: nextUnread };
            }
            return { workspaces, currentAgentId: agentId, currentSessionId: sessionId, unread: nextUnread };
          }
          return { workspaces, unread: nextUnread };
        }),

      startRun: (sessionId) =>
        set((s) => {
          const nextUnread = { ...s.unread };
          delete nextUnread[sessionId];
          return {
            runtime: { ...s.runtime, [sessionId]: { ...emptyRuntime(), running: true } },
            unread: nextUnread
          };
        }),
      appendChunk: (sessionId, text) =>
        set((s) => {
          const r = { ...(s.runtime[sessionId] ?? emptyRuntime()) };
          r.streaming += text;
          r.running = true;
          return { runtime: { ...s.runtime, [sessionId]: r } };
        }),
      addToolCall: (sessionId, tool) =>
        set((s) => {
          const r = { ...(s.runtime[sessionId] ?? emptyRuntime()) };
          const tc: ToolCall = { ...tool, ts: new Date().toISOString() };
          r.toolCalls = [...r.toolCalls, tc];
          if (tool.name === 'TodoWrite') {
            const todos = (tool.input as { todos?: TodoItem[] })?.todos;
            if (Array.isArray(todos)) r.todos = todos;
          }
          return { runtime: { ...s.runtime, [sessionId]: r } };
        }),
      finishRun: (sessionId, error = null) =>
        set((s) => {
          // A session is "active" if it's visible in ANY pane of the ACTIVE workspace.
          const activeWs = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
          const isActive = !!activeWs?.panes.some((p) => p.sessionId === sessionId);
          const isDelegating = s.delegatingSessionIds.has(sessionId);
          const nextUnread = { ...s.unread };
          if (!isActive && !isDelegating) {
            nextUnread[sessionId] = { at: Date.now(), isError: !!error };
          }
          return {
            runtime: {
              ...s.runtime,
              [sessionId]: { ...emptyRuntime(), error }
            },
            unread: nextUnread
          };
        }),
      startDelegating: (sessionId) =>
        set((s) => {
          const next = new Set(s.delegatingSessionIds);
          next.add(sessionId);
          return { delegatingSessionIds: next };
        }),
      finishDelegating: (sessionId) =>
        set((s) => {
          const next = new Set(s.delegatingSessionIds);
          next.delete(sessionId);
          const activeWs = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
          const isActive = !!activeWs?.panes.some((p) => p.sessionId === sessionId);
          const isStillRunning = s.runtime[sessionId]?.running === true;
          const nextUnread = { ...s.unread };
          if (!isActive && !isStillRunning) {
            nextUnread[sessionId] = { at: Date.now() };
          }
          return { delegatingSessionIds: next, unread: nextUnread };
        }),
      markUnread: (sessionId) =>
        set((s) => ({ unread: { ...s.unread, [sessionId]: { at: Date.now() } } })),
      markRead: (sessionId) =>
        set((s) => {
          const next = { ...s.unread };
          delete next[sessionId];
          return { unread: next };
        }),
      purgeUnread: (validIds) =>
        set((s) => {
          const keys = Object.keys(s.unread);
          const orphans = keys.filter((k) => !validIds.has(k));
          if (orphans.length === 0) return s;
          const next = { ...s.unread };
          for (const k of orphans) delete next[k];
          return { unread: next };
        }),
      clearAllUnread: () => set({ unread: {} })
    }),
    {
      name: 'claw-chat',
      version: 2,
      partialize: (state) => ({
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        currentAgentId: state.currentAgentId,
        currentSessionId: state.currentSessionId,
        unread: state.unread
      }),
      migrate: (persisted: unknown, version: number) => {
        if (!persisted || typeof persisted !== 'object') return persisted as never;
        const p = persisted as Partial<ChatState> & { currentAgentId?: string | null; currentSessionId?: string | null };
        if (version < 2 || !p.workspaces || !Array.isArray(p.workspaces) || p.workspaces.length === 0) {
          const ws = createWorkspace('워크스페이스 1', p.currentAgentId ?? null, p.currentSessionId ?? null);
          return {
            ...p,
            workspaces: [ws],
            activeWorkspaceId: ws.id
          } as never;
        }
        return p as never;
      }
    }
  )
);

// Convenience selectors
export const selectActiveWorkspace = (s: ChatState): Workspace | undefined =>
  s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];

export const selectActivePane = (s: ChatState): Pane | undefined => {
  const ws = selectActiveWorkspace(s);
  if (!ws) return undefined;
  return ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0];
};
