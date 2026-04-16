import { create } from 'zustand';

export interface StagedUpload {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  path: string; // server-side absolute path
  createdAt: string;
}

interface UploadsState {
  staged: StagedUpload[]; // files uploaded but not yet sent
  dragActive: boolean;
  /** True while at least one upload is in flight — ChatInput shows a spinner. */
  uploading: number;
  /** Last upload error — ChatInput shows a dismissible banner. */
  lastError: string | null;
  setDragActive: (v: boolean) => void;
  add: (upload: StagedUpload) => void;
  remove: (id: string) => void;
  clear: () => void;
  beginUpload: () => void;
  endUpload: () => void;
  setError: (msg: string | null) => void;
}

export const useUploadsStore = create<UploadsState>((set) => ({
  staged: [],
  dragActive: false,
  uploading: 0,
  lastError: null,
  setDragActive: (dragActive) => set({ dragActive }),
  add: (upload) =>
    set((s) => (s.staged.some((u) => u.id === upload.id) ? s : { staged: [...s.staged, upload] })),
  remove: (id) => set((s) => ({ staged: s.staged.filter((u) => u.id !== id) })),
  clear: () => set({ staged: [], lastError: null }),
  beginUpload: () => set((s) => ({ uploading: s.uploading + 1 })),
  endUpload: () => set((s) => ({ uploading: Math.max(0, s.uploading - 1) })),
  setError: (lastError) => set({ lastError })
}));
