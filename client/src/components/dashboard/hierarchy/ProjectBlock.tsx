import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight, Puzzle } from 'lucide-react';
import type { Agent, Project } from '../../../lib/types';
import { useT } from '../../../lib/i18n';
import { encProjectLead, encProjectAddon } from './types';
import { DragCard } from './DragCard';
import { SortableAddonCard } from './SortableCard';

export function ProjectBlock({
  project,
  lead,
  addons,
  collapsed,
  onToggleCollapse,
  onEdit,
  onDelete,
  onClone,
  onContextMenu,
  onRemoveFromProject,
  onPromoteToLead,
  onDemoteToAddon
}: {
  project: Project;
  lead: Agent | null;
  addons: Agent[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onEdit?: (a: Agent) => void;
  onDelete?: (a: Agent) => void;
  onClone?: (a: Agent) => void;
  onContextMenu?: (e: React.MouseEvent, a: Agent) => void;
  onRemoveFromProject?: (a: Agent) => void;
  onPromoteToLead?: (a: Agent) => void;
  onDemoteToAddon?: (a: Agent) => void;
}) {
  const t = useT();
  const leadDrop = useDroppable({ id: encProjectLead(project.id) });
  const addonDrop = useDroppable({ id: encProjectAddon(project.id) });
  const totalCount = (lead ? 1 : 0) + addons.length;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
      <button
        onClick={onToggleCollapse}
        className="w-full px-3 py-2 border-b border-zinc-800 flex items-center gap-2 hover:bg-zinc-900/40 transition-colors"
        style={{ background: `linear-gradient(to right, ${project.color ?? '#444'}22, transparent)` }}
      >
        {collapsed ? (
          <ChevronRight size={14} className="text-zinc-500" />
        ) : (
          <ChevronDown size={14} className="text-zinc-500" />
        )}
        <div className="w-2 h-2 rounded-full" style={{ background: project.color ?? '#666' }} />
        <div className="text-sm font-semibold">{project.name}</div>
        <div className="text-[11px] text-zinc-500 font-mono">{project.id}</div>
        <div className="ml-auto text-[11px] text-zinc-500">{totalCount}</div>
      </button>
      {!collapsed && (
        <div className="p-3 flex flex-col gap-3">
          <div
            ref={leadDrop.setNodeRef}
            className={`rounded border border-dashed border-zinc-700 bg-zinc-900/30 p-2 min-h-[56px] ${
              leadDrop.isOver ? 'ring-2 ring-zinc-500' : ''
            }`}
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{t('hier.lead')}</div>
            {lead ? (
              <DragCard
                agent={lead}
                onEdit={onEdit}
                onDelete={onDelete}
                onClone={onClone}
                onContextMenu={onContextMenu}
                onRemoveFromProject={onRemoveFromProject}
                onDemoteToAddon={onDemoteToAddon}
              />
            ) : (
              <div className="text-[11px] text-zinc-600 italic px-1">{t('hier.lead.empty')}</div>
            )}
          </div>
          <div
            ref={addonDrop.setNodeRef}
            className={`rounded border border-dashed border-zinc-800 bg-zinc-900/20 p-2 min-h-[56px] ${
              addonDrop.isOver ? 'ring-2 ring-zinc-500' : ''
            }`}
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1">
              <Puzzle size={10} /> {t('hier.addons')}
            </div>
            <div className="flex flex-col gap-2">
              {addons.length === 0 && (
                <div className="text-[11px] text-zinc-600 italic px-1">{t('hier.addons.empty')}</div>
              )}
              <SortableContext items={addons.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                {addons.map((a) => (
                  <SortableAddonCard
                    key={a.id}
                    agent={a}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onClone={onClone}
                    onContextMenu={onContextMenu}
                    onRemoveFromProject={onRemoveFromProject}
                    onPromoteToLead={onPromoteToLead}
                  />
                ))}
              </SortableContext>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
