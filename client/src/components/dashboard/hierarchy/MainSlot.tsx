import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Crown } from 'lucide-react';
import type { Agent } from '../../../lib/types';
import { useT } from '../../../lib/i18n';
import { DROP_MAIN } from './types';
import { SectionLabel } from './SectionLabel';
import { SortableAddonCard } from './SortableCard';

export function MainSlot({
  agents,
  onEdit,
  onDelete,
  onClone,
  onContextMenu
}: {
  agents: Agent[];
  onEdit?: (a: Agent) => void;
  onDelete?: (a: Agent) => void;
  onClone?: (a: Agent) => void;
  onContextMenu?: (e: React.MouseEvent, a: Agent) => void;
}) {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: DROP_MAIN });
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel icon={<Crown size={14} className="text-amber-400" />} label={t('hier.main')} />
      <div
        ref={setNodeRef}
        className={`rounded-lg border border-amber-900/30 bg-gradient-to-r from-amber-900/10 to-zinc-900/30 p-3 min-h-[72px] ${
          isOver ? 'ring-2 ring-amber-500/50' : ''
        }`}
      >
        {agents.length === 0 ? (
          <div className="text-[11px] text-zinc-600 italic">{t('hier.main.empty')}</div>
        ) : (
          <div className="flex flex-col gap-2">
            <SortableContext items={agents.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              {agents.map((a) => (
                <SortableAddonCard
                  key={a.id}
                  agent={a}
                  accent="amber"
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onClone={onClone}
                  onContextMenu={onContextMenu}
                />
              ))}
            </SortableContext>
          </div>
        )}
      </div>
    </div>
  );
}
