import { create } from 'zustand';

export interface ProgressTask {
  id: string;
  title: string;
  steps?: number;
  progress?: number;
  step?: string;
  status: 'active' | 'complete' | 'minimized';
}

interface ProgressToastState {
  tasks: ProgressTask[];
  startTask: (opts: { id: string; title: string; steps?: number }) => void;
  updateTask: (id: string, patch: { progress?: number; step?: string }) => void;
  completeTask: (id: string) => void;
  dismissTask: (id: string) => void;
}

export const useProgressToastStore = create<ProgressToastState>((set, get) => ({
  tasks: [],

  startTask: ({ id, title, steps }) => {
    set((s) => {
      const existing = s.tasks.find((t) => t.id === id);
      if (existing) {
        return {
          tasks: s.tasks.map((t) =>
            t.id === id ? { ...t, title, steps, progress: 0, step: undefined, status: 'active' } : t
          )
        };
      }
      return { tasks: [...s.tasks, { id, title, steps, progress: 0, status: 'active' }] };
    });
  },

  updateTask: (id, patch) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
    }));
  },

  completeTask: (id) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'complete', progress: 100 } : t))
    }));
    setTimeout(() => {
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    }, 1500);
  },

  dismissTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status === 'complete') {
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    } else {
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'minimized' } : t))
      }));
    }
  }
}));
