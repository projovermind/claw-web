import { useState } from 'react';
import { Trash2 } from 'lucide-react';

export function ModelRow({
  alias,
  modelId,
  onUpdate,
  onRename,
  onRemove
}: {
  alias: string;
  modelId: string;
  onUpdate: (newVal: string) => void;
  onRename?: (newAlias: string) => void;
  onRemove: () => void;
}) {
  const [editingAlias, setEditingAlias] = useState(false);
  const [editingModel, setEditingModel] = useState(false);
  const [aliasValue, setAliasValue] = useState(alias);
  const [modelValue, setModelValue] = useState(modelId);

  const commitAlias = () => {
    setEditingAlias(false);
    const trimmed = aliasValue.trim();
    if (trimmed && trimmed !== alias) onRename?.(trimmed);
    else setAliasValue(alias);
  };

  const commitModel = () => {
    setEditingModel(false);
    const trimmed = modelValue.trim();
    if (trimmed && trimmed !== modelId) onUpdate(trimmed);
    else setModelValue(modelId);
  };

  return (
    <div className="flex items-center gap-1 text-[11px] font-mono group">
      {editingAlias ? (
        <input
          autoFocus
          value={aliasValue}
          onChange={(e) => setAliasValue(e.target.value)}
          onBlur={commitAlias}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAlias();
            if (e.key === 'Escape') { setAliasValue(alias); setEditingAlias(false); }
          }}
          className="w-20 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300"
        />
      ) : (
        <button
          onClick={() => onRename && setEditingAlias(true)}
          className={`w-20 truncate text-left px-1 py-0.5 rounded ${onRename ? 'text-zinc-400 hover:text-white hover:bg-zinc-800/50 cursor-pointer' : 'text-zinc-500 cursor-default'}`}
          title={alias}
        >
          {alias}
        </button>
      )}
      <span className="text-zinc-600">&rarr;</span>
      {editingModel ? (
        <input
          autoFocus
          value={modelValue}
          onChange={(e) => setModelValue(e.target.value)}
          onBlur={commitModel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitModel();
            if (e.key === 'Escape') { setModelValue(modelId); setEditingModel(false); }
          }}
          className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300"
        />
      ) : (
        <button
          onClick={() => setEditingModel(true)}
          className="flex-1 text-left text-zinc-300 truncate hover:text-white hover:bg-zinc-800/50 px-1 py-0.5 rounded"
        >
          {modelId}
        </button>
      )}
      <button
        onClick={onRemove}
        className="p-0.5 rounded hover:bg-red-900/40 text-zinc-700 hover:text-red-300 transition-colors"
        title="삭제"
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}
