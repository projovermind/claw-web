import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import type { Project, Agent } from '../lib/types';
import { Plus, GripVertical, FolderOpen } from 'lucide-react';
import PathPicker from '../components/common/PathPicker';
import { EditProjectModal } from '../components/projects/EditProjectModal';
import { SortableProjectCard } from '../components/projects/SortableProjectCard';
import { ProjectDashboard } from '../components/projects/ProjectDashboard';
import { countPlaced, countUnassigned, countMain } from '../lib/visibility';
import { useProgressMutation } from '../lib/useProgressMutation';

function LabeledField({
  label,
  help,
  children
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">{label}</span>
      {children}
      {help && <span className="block text-[11px] text-zinc-600 mt-1 leading-snug">{help}</span>}
    </label>
  );
}

function StatMini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-3">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold mt-0.5">{value}</div>
    </div>
  );
}

const emptyDraft = (): Project => ({ id: '', name: '', path: '', color: '#7bcce0' });

export default function ProjectsPage() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const [draft, setDraft] = useState<Project>(emptyDraft());
  const [editing, setEditing] = useState<Project | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectedProject = (data ?? []).find(p => p.id === selectedProjectId) ?? null;

  const create = useProgressMutation<Project, Error, Project>({
    title: '프로젝트 생성 중...',
    successMessage: '생성 완료',
    invalidateKeys: [['projects']],
    mutationFn: (p: Project) => api.createProject(p),
    onSuccess: async () => {
      setDraft(emptyDraft());
    }
  });
  const update = useProgressMutation<Project, Error, { id: string; patch: Partial<Project> }>({
    title: '프로젝트 저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['projects'], ['agents']],
    mutationFn: ({ id, patch }) => api.patchProject(id, patch),
    onSuccess: async () => {
      setEditing(null);
    }
  });
  const remove = useProgressMutation<void, Error, string>({
    title: '프로젝트 삭제 중...',
    successMessage: '삭제 완료',
    invalidateKeys: [['projects'], ['agents']],
    optimistic: {
      queryKey: ['projects'],
      updater: (old: Project[], id: string) => (old ?? []).filter((p) => p.id !== id),
    },
    mutationFn: (id: string) => api.deleteProject(id)
  });

  const reorder = useProgressMutation<void, Error, { id: string; order: number }[]>({
    title: '순서 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['projects']],
    optimistic: {
      queryKey: ['projects'],
      updater: (old: Project[], vars: { id: string; order: number }[]) => {
        const orderMap = new Map(vars.map((o) => [o.id, o.order]));
        return (old ?? []).slice().sort((a, b) => (orderMap.get(a.id) ?? 9999) - (orderMap.get(b.id) ?? 9999));
      },
    },
    mutationFn: async (orders: { id: string; order: number }[]) => {
      await Promise.all(orders.map((o) => api.patchProject(o.id, { order: o.order })));
    }
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  const onDragEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId || activeId === overId) return;
    const list = data ?? [];
    const oldIndex = list.findIndex((p) => p.id === activeId);
    const newIndex = list.findIndex((p) => p.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(list, oldIndex, newIndex);
    const orders = reordered.map((p, i) => ({ id: p.id, order: i * 10 }));
    reorder.mutate(orders);
  };

  const placedCountByProject = (pid: string): number =>
    (agents ?? []).filter((a: Agent) => a.projectId === pid).length;

  const placedAgentsInProject = (pid: string): Agent[] =>
    (agents ?? [])
      .filter((a: Agent) => a.projectId === pid)
      .sort((a, b) => {
        const at = a.tier === 'project' ? 0 : 1;
        const bt = b.tier === 'project' ? 0 : 1;
        if (at !== bt) return at - bt;
        return (a.order ?? 9999) - (b.order ?? 9999);
      });

  const handleDelete = (p: Project) => {
    const count = placedCountByProject(p.id);
    const msg =
      count > 0
        ? t('projects.confirmDeleteWithAgents', { name: p.name, count })
        : t('projects.confirmDelete', { name: p.name });
    if (confirm(msg)) remove.mutate(p.id);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <h2 className="text-2xl font-semibold">{t('projects.title')}</h2>
      <p className="text-xs text-zinc-500 max-w-4xl leading-relaxed">
        {t('projects.intro')}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* LEFT column: create (top) + list (bottom) */}
        <div className="space-y-5 min-w-0">
          {/* Create panel */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
            <div className="text-base font-semibold text-zinc-200">{t('projects.add')}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <LabeledField
                label={t('projects.fieldId')}
                help={t('projects.fieldIdHelp')}
              >
                <input
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  placeholder="overmind, algorithm..."
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </LabeledField>
              <LabeledField label={t('projects.fieldName')} help={t('projects.fieldNameHelp')}>
                <input
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                  placeholder="Project Overmind"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </LabeledField>
            </div>
            <LabeledField
              label={t('projects.fieldPath')}
              help={t('projects.fieldPathHelp')}
            >
              <div className="flex gap-1.5">
                <input
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  placeholder="/Volumes/Core/Vault/..."
                  value={draft.path}
                  onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 text-sm text-zinc-300 flex items-center gap-1.5 shrink-0"
                  title={t('common.selectFolder')}
                >
                  <FolderOpen size={14} /> {t('common.find')}
                </button>
              </div>
            </LabeledField>
            <div className="flex items-center gap-4">
              <LabeledField label={t('projects.fieldColor')} help={t('projects.fieldColorHelp')}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    className="w-12 h-10 bg-transparent border border-zinc-800 rounded cursor-pointer"
                    value={draft.color}
                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                  />
                  <code className="text-xs text-zinc-500 font-mono">{draft.color}</code>
                </div>
              </LabeledField>
              <button
                disabled={!draft.id || !draft.name || !draft.path}
                onClick={() => create.mutate(draft)}
                className="flex-1 self-end rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 text-sm flex items-center justify-center gap-2"
              >
                <Plus size={14} /> {t('projects.create')}
              </button>
            </div>
          </div>

          {/* Sortable list */}
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <GripVertical size={12} /> {t('projects.dragHint')} · {(data ?? []).length}
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext
                items={(data ?? []).map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-2">
                  {(data ?? []).map((p) => (
                    <SortableProjectCard
                      key={p.id}
                      project={p}
                      placedAgents={placedAgentsInProject(p.id)}
                      selected={selectedProjectId === p.id}
                      onSelect={() => setSelectedProjectId(selectedProjectId === p.id ? null : p.id)}
                      onEdit={() => setEditing(p)}
                      onDelete={() => handleDelete(p)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>

        {/* RIGHT column: project dashboard */}
        <div className="lg:sticky lg:top-0 lg:self-start min-w-0">
          {selectedProject ? (
            <ProjectDashboard project={selectedProject} agents={(agents ?? []).filter(a => a.projectId === selectedProject.id)} />
          ) : (
            <div className="space-y-4">
              <div className="text-base font-semibold text-zinc-200">{t('projects.dashboard')}</div>
              <div className="grid grid-cols-2 gap-3">
                <StatMini label={t('projects.statProjects')} value={(data ?? []).length} />
                <StatMini label={t('projects.statMain')} value={countMain(agents ?? [])} />
                <StatMini label={t('projects.statPlaced')} value={countPlaced(agents ?? [])} />
                <StatMini label={t('projects.statUnassigned')} value={countUnassigned(agents ?? [])} />
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center">
                <FolderOpen size={24} className="mx-auto text-zinc-600 mb-2" />
                <div className="text-sm text-zinc-500">{t('projects.dashboardHint')}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <EditProjectModal
          project={editing}
          placedCount={placedCountByProject(editing.id)}
          busy={update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => update.mutate({ id: editing.id, patch })}
        />
      )}
      <PathPicker
        open={pickerOpen}
        initialPath={draft.path || undefined}
        onSelect={(p) => setDraft({ ...draft, path: p })}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
