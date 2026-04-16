import { create } from 'zustand';

type ConnectionState = 'connecting' | 'open' | 'closed';

interface WsState {
  state: ConnectionState;
  setState: (s: ConnectionState) => void;
}

export const useWsStore = create<WsState>((set) => ({
  state: 'connecting',
  setState: (state) => set({ state })
}));
