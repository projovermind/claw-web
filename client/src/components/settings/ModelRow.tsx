import { useState } from 'react';
import { Trash2 } from 'lucide-react';

export function ModelRow({
  alias,
  modelId,
  onUpdate,
  onRemove
}: {
  alias: string;
  modelId: string;
  onUpdate: (newVal: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(modelId);

  const commit = () => {
    setEditing(false);
    if (value.trim() && value !== modelId) onUpdate(value.trim());
  };

  return (
    <div className="flex items-center gap-1 text-[11px] font-mono group">
      <span className="text-zinc-500 w-20 truncate" title={alias}>{alias}</span>
      <span className="text-zinc-600">&rarr;</span>
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setValue(modelId);
              setEditing(false);
            }
          }}
          className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="flex-1 text-left text-zinc-300 truncate hover:text-white hover:bg-zinc-800/50 px-1 py-0.5 rounded"
        >
          {modelId}
        </button>
      )}
      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-zinc-600 hover:text-red-300 transition-opacity"
        title="삭제"
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}
