import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { api } from '../lib/api';
import type { Project, Agent } from '../lib/types';
import { Plus, GripVertical, FolderOpen } from 'lucide-react';
import PathPicker from '../components/common/PathPicker';
import { EditProjectModal } from '../components/projects/EditProjectModal';
import { SortableProjectCard } from '../components/projects/SortableProjectCard';
import { ProjectDashboard } from '../components/projects/ProjectDashboard';

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
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const [draft, setDraft] = useState<Project>(emptyDraft());
  const [editing, setEditing] = useState<Project | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectedProject = (data ?? []).find(p => p.id === selectedProjectId) ?? null;

  const create = useMutation({
    mutationFn: (p: Project) => api.createProject(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setDraft(emptyDraft());
    }
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Project> }) =>
      api.patchProject(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      setEditing(null);
    }
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    }
  });

  const reorder = useMutation({
    mutationFn: async (orders: { id: string; order: number }[]) => {
      await Promise.all(orders.map((o) => api.patchProject(o.id, { order: o.order })));
    },
    onMutate: async (orders) => {
      await qc.cancelQueries({ queryKey: ['projects'] });
      const prev = qc.getQueryData<Project[]>(['projects']);
      const map = new Map(orders.map((o) => [o.id, o.order]));
      qc.setQueryData<Project[]>(['projects'], (old) =>
        (old ?? [])
          .map((p) => (map.has(p.id) ? { ...p, order: map.get(p.id)! } : p))
          .slice()
          .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['projects'], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['projects'] })
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
        ? `"${p.name}" 프로젝트를 삭제할까요?\n\n⚠️ 이 프로젝트에 ${count}개 에이전트가 배치돼 있어. 삭제하면 그 에이전트들은 자동으로 "미배치"로 돌아가. (파일 시스템 폴더는 건드리지 않아 — projects.json 항목만 제거됨)`
        : `"${p.name}" 프로젝트를 삭제할까요?\n\n파일 시스템 폴더는 건드리지 않아 — projects.json 항목만 제거됨.`;
    if (confirm(msg)) remove.mutate(p.id);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <h2 className="text-2xl font-semibold">Projects</h2>
      <p className="text-xs text-zinc-500 max-w-4xl leading-relaxed">
        프로젝트는 대시보드 계층 트리에서 에이전트가 배치되는 버킷이야. 여기 등록된 path가 해당 프로젝트에 배치된
        에이전트의 <code className="text-zinc-400">workingDir</code>로 자동 동기화됨. 📁{' '}
        <strong>경로 수정해도 실제 폴더는 건드리지 않아</strong> — projects.json 참조값만 바뀌고, 배치된
        에이전트 workingDir이 cascade 업데이트돼.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* LEFT column: create (top) + list (bottom) */}
        <div className="space-y-5 min-w-0">
          {/* Create panel */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
            <div className="text-base font-semibold text-zinc-200">+ 프로젝트 추가</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <LabeledField
                label="ID"
                help="이후 변경 불가. 소문자/숫자/하이픈만."
              >
                <input
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  placeholder="overmind, algorithm..."
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </LabeledField>
              <LabeledField label="이름" help="대시보드에 표시되는 이름.">
                <input
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                  placeholder="Project Overmind"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </LabeledField>
            </div>
            <LabeledField
              label="경로 (Path)"
              help="절대 경로. Claude CLI의 cwd로 쓰이고 CLAUDE.md가 자동 로드됨."
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
                  title="폴더 선택"
                >
                  <FolderOpen size={14} /> 찾기
                </button>
              </div>
            </LabeledField>
            <div className="flex items-center gap-4">
              <LabeledField label="색상" help="카드 헤더 엑센트.">
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
                <Plus size={14} /> 프로젝트 생성
              </button>
            </div>
          </div>

          {/* Sortable list */}
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <GripVertical size={12} /> 드래그로 순서 변경 · {(data ?? []).length}개
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
            <ProjectDashboard project={selectedProject} agents={agents ?? []} />
          ) : (
            <div className="space-y-4">
              <div className="text-base font-semibold text-zinc-200">프로젝트 대시보드</div>
              <div className="grid grid-cols-3 gap-3">
                <StatMini label="프로젝트" value={(data ?? []).length} />
                <StatMini
                  label="배치된 에이전트"
                  value={(agents ?? []).filter((a: Agent) => a.projectId).length}
                />
                <StatMini
                  label="미배치"
                  value={(agents ?? []).filter((a: Agent) => !a.projectId).length}
                />
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center">
                <FolderOpen size={24} className="mx-auto text-zinc-600 mb-2" />
                <div className="text-sm text-zinc-500">프로젝트를 클릭하면 대시보드가 열립니다</div>
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
