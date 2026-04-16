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
  setCurrentAgent: (id: string | null) => void;
  setCurrentSession: (id: string | null) => void;
  startRun: (sessionId: string) => void;
  appendChunk: (sessionId: string, text: string) => void;
  addToolCall: (sessionId: string, tool: { name: string; input: Record<string, unknown> }) => void;
  finishRun: (sessionId: string, error?: string | null) => void;
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
  setCurrentAgent: (currentAgentId) => set({ currentAgentId }),
  setCurrentSession: (currentSessionId) => set({ currentSessionId }),
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
      // TodoWrite tool — extract todos into widget
      if (tool.name === 'TodoWrite') {
        const todos = (tool.input as { todos?: TodoItem[] })?.todos;
        if (Array.isArray(todos)) r.todos = todos;
      }
      return { runtime: { ...s.runtime, [sessionId]: r } };
    }),
  /**
   * Called when chat.done arrives AFTER the session query has been refetched.
   * Clears streaming + toolCalls + todos so the StreamingMessage component
   * vanishes cleanly and the persisted assistant message (now in the session
   * query cache) is the only thing visible. Prevents the "response shown
   * twice" bug where both the live-streaming bubble and the newly-fetched
   * persisted bubble render simultaneously.
   */
  finishRun: (sessionId, error = null) =>
    set((s) => ({
      runtime: {
        ...s.runtime,
        [sessionId]: { ...emptyRuntime(), error }
      }
    }))
    }),
    {
      name: 'claw-chat',
      partialize: (state) => ({
        currentAgentId: state.currentAgentId,
        currentSessionId: state.currentSessionId
      })
    }
  )
);
