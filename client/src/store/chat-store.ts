import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

interface ChatState {
  currentAgentId: string | null;
  currentSessionId: string | null;
  runtime: Record<string, SessionRuntime>;
  /** 세션별 안 읽은 메시지 플래그 + 마지막 업데이트 시각 (정렬용) */
  unread: Record<string, { at: number }>;
  setCurrentAgent: (id: string | null) => void;
  setCurrentSession: (id: string | null) => void;
  startRun: (sessionId: string) => void;
  appendChunk: (sessionId: string, text: string) => void;
  addToolCall: (sessionId: string, tool: { name: string; input: Record<string, unknown> }) => void;
  finishRun: (sessionId: string, error?: string | null) => void;
  markUnread: (sessionId: string) => void;
  markRead: (sessionId: string) => void;
  /** 유효한 세션 ID Set 을 받아 그 밖의 모든 unread 제거 (orphan cleanup) */
  purgeUnread: (validIds: Set<string>) => void;
  /** 모든 unread 제거 (채팅 페이지 진입 시 사용) */
  clearAllUnread: () => void;
}

const emptyRuntime = (): SessionRuntime => ({
  streaming: '',
  toolCalls: [],
  todos: [],
  running: false,
  error: null
});

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      currentAgentId: null,
      currentSessionId: null,
      runtime: {},
      unread: {},
      setCurrentAgent: (currentAgentId) => set({ currentAgentId }),
      setCurrentSession: (currentSessionId) =>
        set((s) => {
          if (!currentSessionId) return { currentSessionId };
          // 세션 열면 자동으로 read 처리
          const next = { ...s.unread };
          delete next[currentSessionId];
          return { currentSessionId, unread: next };
        }),
      startRun: (sessionId) =>
        set((s) => ({
          runtime: { ...s.runtime, [sessionId]: { ...emptyRuntime(), running: true } }
        })),
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
          // 채팅 완료 시 현재 열려있는 세션이 아니면 unread 표시
          const isActive = s.currentSessionId === sessionId;
          const nextUnread = { ...s.unread };
          if (!isActive && !error) {
            nextUnread[sessionId] = { at: Date.now() };
          }
          return {
            runtime: {
              ...s.runtime,
              [sessionId]: { ...emptyRuntime(), error }
            },
            unread: nextUnread
          };
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
      partialize: (state) => ({
        currentAgentId: state.currentAgentId,
        currentSessionId: state.currentSessionId,
        unread: state.unread
      })
    }
  )
);
