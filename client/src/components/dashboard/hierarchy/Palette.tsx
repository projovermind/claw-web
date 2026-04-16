import { useDroppable } from '@dnd-kit/core';
import { Search, X, Users } from 'lucide-react';
import type { Agent } from '../../../lib/types';
import { useT } from '../../../lib/i18n';
import { DROP_PALETTE } from './types';
import { SectionLabel } from './SectionLabel';
import { DragCard } from './DragCard';

export function Palette({
  agents,
  search,
  onSearchChange,
  onEdit,
  onDelete,
  onClone,
  onContextMenu
}: {
  agents: Agent[];
  search: string;
  onSearchChange: (v: string) => void;
  onEdit?: (a: Agent) => void;
  onDelete?: (a: Agent) => void;
  onClone?: (a: Agent) => void;
  onContextMenu?: (e: React.MouseEvent, a: Agent) => void;
}) {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: DROP_PALETTE });
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel icon={<Users size={14} />} label={`${t('hier.unassigned')} (${agents.length})`} />
      <div
        ref={setNodeRef}
        className={`rounded-lg border ${isOver ? 'border-zinc-500 ring-2 ring-zinc-600' : 'border-zinc-800'} bg-zinc-950/60`}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <Search size={14} className="text-zinc-500" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('hier.search')}
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-zinc-600"
            style={{ fontSize: '14px' }}
          />
          {search && (
            <button onClick={() => onSearchChange('')} className="text-zinc-500 hover:text-white">
              <X size={14} />
            </button>
          )}
        </div>
        {/* Max height ~ 10 cards (each card is ~52px tall including gap). */}
        <div className="max-h-[560px] overflow-y-auto p-2 flex flex-col gap-2">
          {agents.length === 0 ? (
            <div className="text-[11px] text-zinc-600 italic px-2 py-4 text-center">
              {search ? t('hier.empty.search') : t('hier.empty.unassigned')}
            </div>
          ) : (
            agents.map((a) => (
              <DragCard
                key={a.id}
                agent={a}
                onEdit={onEdit}
                onDelete={onDelete}
                onClone={onClone}
                onContextMenu={onContextMenu}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
