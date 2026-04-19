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
  const anyDropActive = leadDrop.isOver || addonDrop.isOver;

  return (
    <div className={`rounded-lg border overflow-hidden transition-all ${
      anyDropActive
        ? 'border-emerald-500/60 bg-zinc-950/60 shadow-[0_0_24px_rgba(52,211,153,0.2)]'
        : 'border-zinc-800 bg-zinc-950/40'
    }`}>
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
            className={`rounded border-2 border-dashed p-2 min-h-[56px] transition-all ${
              leadDrop.isOver
                ? 'border-emerald-400 bg-emerald-500/15 ring-4 ring-emerald-400/40 shadow-[0_0_20px_rgba(52,211,153,0.35)] scale-[1.01]'
                : 'border-zinc-700 bg-zinc-900/30'
            }`}
          >
            <div className={`text-[11px] uppercase tracking-wider mb-1 transition-colors ${leadDrop.isOver ? 'text-emerald-300 font-semibold' : 'text-zinc-500'}`}>{t('hier.lead')}{leadDrop.isOver ? ' ← 여기에 놓기' : ''}</div>
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
            className={`rounded border-2 border-dashed p-2 min-h-[56px] transition-all ${
              addonDrop.isOver
                ? 'border-sky-400 bg-sky-500/15 ring-4 ring-sky-400/40 shadow-[0_0_20px_rgba(56,189,248,0.35)] scale-[1.01]'
                : 'border-zinc-800 bg-zinc-900/20'
            }`}
          >
            <div className={`text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1 transition-colors ${addonDrop.isOver ? 'text-sky-300 font-semibold' : 'text-zinc-500'}`}>
              <Puzzle size={10} /> {t('hier.addons')}{addonDrop.isOver ? ' ← 여기에 놓기' : ''}
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
