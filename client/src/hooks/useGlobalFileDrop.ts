import { useEffect } from 'react';
import { useUploadsStore } from '../store/uploads-store';
import { api } from '../lib/api';

/**
 * Global drag-and-drop + clipboard-paste file upload hook.
 *
 * Attaches window-level listeners:
 *  - dragenter/over/leave/drop — handle file drops anywhere in the app.
 *    File goes through api.uploadFile (token-aware) and adds to the staged
 *    list in the uploads store.
 *  - paste — handles Ctrl/Cmd-V with image data (screenshots from macOS
 *    clipboard, copied images from browsers, etc.). Works when the paste
 *    event bubbles up to window (i.e. focus is on the chat textarea but
 *    we let it bubble — we only preventDefault for file payloads).
 *
 * The uploads-store tracks `uploading` count + `lastError` so ChatInput can
 * show a spinner / error banner.
 */
export function useGlobalFileDrop() {
  const setDragActive = useUploadsStore((s) => s.setDragActive);
  const add = useUploadsStore((s) => s.add);
  const beginUpload = useUploadsStore((s) => s.beginUpload);
  const endUpload = useUploadsStore((s) => s.endUpload);
  const setError = useUploadsStore((s) => s.setError);

  useEffect(() => {
    const handleFile = async (file: File) => {
      beginUpload();
      try {
        const up = await api.uploadFile(file);
        add(up);
      } catch (err) {
        const msg = (err as Error).message || '업로드 실패';
        setError(`${file.name || 'file'}: ${msg}`);
        // eslint-disable-next-line no-console
        console.error('upload failed', err);
      } finally {
        endUpload();
      }
    };

    // --- Drag & drop ---
    const hasFiles = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true;
      }
      return false;
    };

    let dragDepth = 0;

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      setDragActive(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow drop
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragActive(false);
    };

    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const file of files) {
        await handleFile(file);
      }
    };

    // --- Clipboard paste ---
    // A paste event has items; items with kind === 'file' (typically
    // screenshots) get converted to File objects and uploaded. Text pastes
    // pass through untouched (we don't preventDefault unless there's a file).
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return; // not a file paste, let textarea get the text
      e.preventDefault();
      for (const file of files) {
        // Screenshots from Cmd-Shift-4 come through with generic names like
        // "image.png"; give them timestamped names so the staged list is
        // scannable.
        let named = file;
        if (/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) || !file.name) {
          const ext = (file.type.split('/')[1] || 'png').replace(/^jpeg$/, 'jpg');
          const ts = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .slice(0, 19);
          named = new File([file], `paste-${ts}.${ext}`, { type: file.type });
        }
        await handleFile(named);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [setDragActive, add, beginUpload, endUpload, setError]);
}
