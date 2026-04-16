import { useDraggable } from '@dnd-kit/core';
import { Pencil, Trash2, Copy, MoreVertical } from 'lucide-react';
import type { Agent } from '../../../lib/types';

export function DragCard({
  agent,
  accent,
  onEdit,
  onDelete,
  onClone,
  onContextMenu
}: {
  agent: Agent;
  accent?: 'amber';
  onEdit?: (a: Agent) => void;
  onDelete?: (a: Agent) => void;
  onClone?: (a: Agent) => void;
  onContextMenu?: (e: React.MouseEvent, a: Agent) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: agent.id });
  const cls =
    accent === 'amber'
      ? 'border-amber-900/50 bg-amber-900/10 hover:border-amber-800'
      : 'border-zinc-800 bg-zinc-900/80 hover:border-zinc-700';

  const stopDrag = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={setNodeRef}
      onContextMenu={(e) => onContextMenu?.(e, agent)}
      className={`rounded border ${cls} p-2.5 select-none transition-all group relative ${
        isDragging ? 'opacity-30 scale-95' : ''
      }`}
    >
      {/* Draggable handle = entire card (desktop only via pointer sensor) */}
      <div {...listeners} {...attributes} className="cursor-grab">
        <div className="flex items-center gap-2 pr-16">
          <span className="text-lg">{agent.avatar ?? '🤖'}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate">{agent.name}</div>
            <div className="text-[11px] text-zinc-500 font-mono">{agent.id}</div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-zinc-800">{agent.model ?? '—'}</span>
          {agent.lightweightMode && (
            <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">⚡ LW</span>
          )}
        </div>
      </div>

      {/* Action row — always visible on mobile, hover on desktop */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {/* ⋮ menu button — always visible, opens context menu for move/reorder */}
        {onContextMenu && (
          <button
            onPointerDown={stopDrag}
            onClick={(e) => {
              e.stopPropagation();
              onContextMenu(e, agent);
            }}
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 lg:opacity-0 lg:group-hover:opacity-100"
            title="이동 / 관리"
          >
            <MoreVertical size={14} />
          </button>
        )}
      </div>

      {/* Edit/Delete/Clone — bottom row, always visible on mobile */}
      {(onEdit || onDelete || onClone) && (
        <div className="absolute bottom-1.5 right-1.5 flex gap-0.5 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
          {onClone && (
            <button
              onPointerDown={stopDrag}
              onClick={(e) => { e.stopPropagation(); onClone(agent); }}
              className="p-1 rounded hover:bg-sky-900/50 text-zinc-400 hover:text-sky-300"
              title="Clone"
            >
              <Copy size={12} />
            </button>
          )}
          {onEdit && (
            <button
              onPointerDown={stopDrag}
              onClick={(e) => { e.stopPropagation(); onEdit(agent); }}
              className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white"
              title="Edit"
            >
              <Pencil size={12} />
            </button>
          )}
          {onDelete && (
            <button
              onPointerDown={stopDrag}
              onClick={(e) => { e.stopPropagation(); onDelete(agent); }}
              className="p-1 rounded hover:bg-red-900/50 text-zinc-400 hover:text-red-300"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
