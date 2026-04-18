import { create } from 'zustand';

export interface DelegationEntry {
  id: string;
  originSessionId: string;
  targetSessionId: string;
  targetAgentId: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
}

interface DelegationState {
  delegations: DelegationEntry[];
  add: (entry: Omit<DelegationEntry, 'status' | 'startedAt'>) => void;
  complete: (id: string) => void;
  fail: (id: string) => void;
  clearStale: () => void;
}

export const useDelegationStore = create<DelegationState>((set) => ({
  delegations: [],
  add: (entry) =>
    set((s) => ({
      delegations: [
        ...s.delegations,
        { ...entry, status: 'running', startedAt: Date.now() }
      ]
    })),
  complete: (id) =>
    set((s) => ({
      delegations: s.delegations.map((d) =>
        d.id === id ? { ...d, status: 'completed' } : d
      )
    })),
  fail: (id) =>
    set((s) => ({
      delegations: s.delegations.map((d) =>
        d.id === id ? { ...d, status: 'failed' } : d
      )
    })),
  // WS 재연결 시 미완료(running) 항목 제거 — 서버 재시작으로 완료 이벤트를 못 받은 경우 정리
  clearStale: () =>
    set((s) => ({
      delegations: s.delegations.filter((d) => d.status !== 'running')
    }))
}));
