import { create } from 'zustand';

/** 토스트 안에 한 개 노출되는 액션 버튼 (되돌리기 등). 누르면 토스트는 닫힌다. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  ts: number;
  action?: ToastAction;
}

export interface ToastOptions {
  action?: ToastAction;
  /** 자동 닫힘까지의 ms. 기본 5000. */
  durationMs?: number;
}

interface ToastState {
  toasts: Toast[];
  add: (type: Toast['type'], message: string, opts?: ToastOptions) => void;
  dismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (type, message, opts) => {
    const id = `toast_${++nextId}_${Date.now()}`;
    const toast: Toast = { id, type, message, ts: Date.now(), action: opts?.action };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // Auto-remove after 5 seconds (액션이 있으면 누를 시간을 더 준다)
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, opts?.durationMs ?? (opts?.action ? 12000 : 5000));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
