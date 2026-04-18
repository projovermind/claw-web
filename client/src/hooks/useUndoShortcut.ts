import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToastStore } from '../store/toast-store';

export function useUndoShortcut() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.add);

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const isUndo = (isMac ? e.metaKey : e.ctrlKey) && e.key === 'z' && !e.shiftKey;
      if (!isUndo) return;

      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) return;

      e.preventDefault();

      try {
        const res = await api.undoAction();
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        addToast('success', `↩ ${res.description} 되돌렸습니다`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.includes('empty')) {
          addToast('info', '더 이상 되돌릴 수 없습니다');
        } else {
          addToast('error', `Undo 실패: ${msg}`);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [queryClient, addToast]);
}
