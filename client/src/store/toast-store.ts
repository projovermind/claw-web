import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  ts: number;
}

interface ToastState {
  toasts: Toast[];
  add: (type: Toast['type'], message: string) => void;
  dismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (type, message) => {
    const id = `toast_${++nextId}_${Date.now()}`;
    const toast: Toast = { id, type, message, ts: Date.now() };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // Auto-remove after 5 seconds
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
