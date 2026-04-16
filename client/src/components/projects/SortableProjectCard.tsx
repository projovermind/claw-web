import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Pencil, Trash2, GripVertical } from 'lucide-react';
import type { Project, Agent } from '../../lib/types';

export function SortableProjectCard({
  project,
  placedAgents,
  onEdit,
  onDelete
}: {
  project: Project;
  placedAgents: Agent[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };
  const count = placedAgents.length;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-md border border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 px-3 py-2.5 relative group ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          {...listeners}
          {...attributes}
          className="cursor-grab text-zinc-600 hover:text-zinc-300 p-0.5 -ml-1"
          title="드래그로 순서 변경"
        >
          <GripVertical size={14} />
        </button>
        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: project.color }} />
        <div className="font-semibold text-base truncate">{project.name}</div>
        <span className="text-[11px] text-zinc-500 font-mono">{project.id}</span>
        <span className="ml-auto text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
          🤖 {count}
        </span>
        <button
          onClick={onEdit}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-opacity"
          title="편집"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-900/50 text-zinc-500 hover:text-red-300 transition-opacity"
          title="삭제"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mt-1.5 text-xs text-zinc-500 font-mono truncate" title={project.path}>
        📁 {project.path}
      </div>
      {count > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {placedAgents.slice(0, 6).map((a) => (
            <span
              key={a.id}
              className="text-xs px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-300"
              title={`${a.name} (${a.tier})`}
            >
              {a.avatar ?? '🤖'} {a.name}
            </span>
          ))}
          {count > 6 && (
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-800/40 text-zinc-500">
              +{count - 6}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
