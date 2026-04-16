import { useState } from 'react';

export function InlineEditText({
  value,
  onSave,
  className,
  placeholder
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else setDraft(value);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        className={`bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 outline-none focus:border-zinc-500 ${className ?? ''}`}
      />
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={`text-left hover:bg-zinc-800/50 rounded px-1 py-0.5 ${className ?? ''}`}
      title="Click to edit"
    >
      {value || <span className="text-zinc-600">{placeholder}</span>}
    </button>
  );
}
