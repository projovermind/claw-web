import { useState, useEffect, useRef } from 'react';
import { Check, X, Pencil } from 'lucide-react';

/**
 * Inline-editable session title shown in the chat header.
 *
 * Click the title (or the pencil icon that appears on hover) to enter
 * edit mode. Enter or the check button commits; Escape or blur without
 * committing reverts. IME composition-aware so Korean input doesn't
 * trigger a commit mid-typing.
 */
export function SessionTitleEditor({
  sessionId,
  title,
  onRename,
  busy
}: {
  sessionId: string;
  title: string;
  onRename: (title: string) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset draft when the session switches
  useEffect(() => {
    setDraft(title);
    setEditing(false);
  }, [sessionId, title]);

  useEffect(() => {
    if (editing) {
      // focus + select next tick so the DOM is mounted
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) {
      setDraft(title);
      setEditing(false);
      return;
    }
    onRename(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(title);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
          disabled={busy}
          maxLength={200}
          className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 focus:border-emerald-600 outline-none rounded px-2 py-1 text-base font-semibold"
          style={{ fontSize: '16px' }}
        />
        <button
          onMouseDown={(e) => e.preventDefault() /* don't blur input */}
          onClick={commit}
          disabled={busy}
          className="p-1 rounded hover:bg-emerald-900/40 text-emerald-400 disabled:opacity-40 shrink-0"
          title="저장"
        >
          <Check size={14} />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={cancel}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 shrink-0"
          title="취소"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-2 min-w-0 flex-1 text-left hover:bg-zinc-900/60 rounded px-2 py-1 -mx-2 transition-colors"
      title="클릭해서 제목 수정"
    >
      <span className="font-semibold truncate">{title || '(no title)'}</span>
      <Pencil
        size={12}
        className="text-zinc-600 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity"
      />
      <span className="text-[11px] text-zinc-500 font-mono shrink-0">{sessionId}</span>
    </button>
  );
}
