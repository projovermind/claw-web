import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Pencil, Trash2, Copy, MoreVertical } from 'lucide-react';
import type { Agent } from '../../../lib/types';

export function SortableAddonCard({
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    activeIndex,
    index
  } = useSortable({ id: agent.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };
  const stopDrag = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();

  const showTopLine = isOver && activeIndex > index;
  const showBottomLine = isOver && activeIndex < index && activeIndex !== -1;

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {showTopLine && (
        <div className="absolute -top-1 left-0 right-0 h-0.5 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.6)] z-10" />
      )}
      {showBottomLine && (
        <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.6)] z-10" />
      )}
      <div
        onContextMenu={(e) => onContextMenu?.(e, agent)}
        className={`rounded border ${
          accent === 'amber'
            ? 'border-amber-900/50 bg-amber-900/10 hover:border-amber-800'
            : 'border-zinc-800 bg-zinc-900/80 hover:border-zinc-700'
        } p-2.5 select-none transition-all group relative ${isDragging ? 'opacity-30 scale-95' : ''}`}
      >
        {/* Drag handle overlay — desktop only (hidden on mobile to prevent scroll conflicts) */}
        <div {...listeners} {...attributes} className="cursor-grab hidden lg:block absolute inset-0 z-0" />

        <div className="flex items-center gap-2 pr-16 relative z-[1]">
          <span className="text-lg">{agent.avatar ?? '🤖'}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate">{agent.name}</div>
            <div className="text-[11px] text-zinc-500 font-mono">{agent.id}</div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400 flex-wrap relative z-[1]">
          <span className="px-1.5 py-0.5 rounded bg-zinc-800">{agent.model ?? '—'}</span>
          {agent.lightweightMode && (
            <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">⚡ LW</span>
          )}
        </div>

        {/* Top-right: ⋮ menu (always visible on mobile) */}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 z-[2]">
          {onContextMenu && (
            <button
              onPointerDown={stopDrag}
              onClick={(e) => {
                e.stopPropagation();
                onContextMenu(e, agent);
              }}
              className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 lg:opacity-0 lg:group-hover:opacity-100"
              title="이동"
            >
              <MoreVertical size={14} />
            </button>
          )}
        </div>

        {/* Bottom-right: edit/clone/delete (always visible on mobile) */}
        {(onEdit || onDelete || onClone) && (
          <div className="absolute bottom-1.5 right-1.5 flex gap-0.5 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity z-[2]">
            {onClone && (
              <button
                onPointerDown={stopDrag}
                onClick={(e) => { e.stopPropagation(); onClone(agent); }}
                className="p-1 rounded hover:bg-sky-900/50 text-zinc-400 hover:text-sky-300"
              >
                <Copy size={12} />
              </button>
            )}
            {onEdit && (
              <button
                onPointerDown={stopDrag}
                onClick={(e) => { e.stopPropagation(); onEdit(agent); }}
                className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white"
              >
                <Pencil size={12} />
              </button>
            )}
            {onDelete && (
              <button
                onPointerDown={stopDrag}
                onClick={(e) => { e.stopPropagation(); onDelete(agent); }}
                className="p-1 rounded hover:bg-red-900/50 text-zinc-400 hover:text-red-300"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
