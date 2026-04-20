import { useState, useMemo } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { api } from '../../../lib/api';
import type { Agent, Project } from '../../../lib/types';
import { buildHierarchy, isUnassignedAgent } from '../../../lib/visibility';
import { useT } from '../../../lib/i18n';
import { useProgressToastStore } from '../../../store/progress-toast-store';
import { decodeDrop, targetToPatch } from './types';
import { SectionLabel } from './SectionLabel';
import { Palette } from './Palette';
import { MainSlot } from './MainSlot';
import { ProjectBlock } from './ProjectBlock';
import { AgentContextMenu, type ContextMenuState } from './ContextMenu';

// ── Main component ───────────────────────────────────
interface HierarchyProps {
  onEdit?: (agent: Agent) => void;
  onDelete?: (agent: Agent) => void;
  onClone?: (agent: Agent) => void;
  splitLayout?: boolean; // true -> palette left, tree right (2-col)
}

export default function AgentHierarchy({
  onEdit,
  onDelete,
  onClone,
  splitLayout = false
}: HierarchyProps = {}) {
  const t = useT();
  const qc = useQueryClient();
  const { startTask, completeTask } = useProgressToastStore();
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [draggingAgent, setDraggingAgent] = useState<Agent | null>(null);

  const toggleCollapse = (projectId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const openContextMenu = (e: React.MouseEvent, agent: Agent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, agent });
  };

  const mutate = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Agent> }) => {
      startTask({ id: `move_${id}`, title: t('hier.moving') });
      return api.patchAgent(id, patch);
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['agents'] });
      const prev = qc.getQueryData<Agent[]>(['agents']);
      qc.setQueryData<Agent[]>(['agents'], (old) =>
        (old ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a))
      );
      return { prev };
    },
    onError: (_e, vars, ctx) => {
      ctx?.prev && qc.setQueryData(['agents'], ctx.prev);
      completeTask(`move_${vars.id}`);
    },
    onSuccess: async (_d, vars) => {
      await qc.invalidateQueries({ queryKey: ['agents'] });
      requestAnimationFrame(() => completeTask(`move_${vars.id}`));
    }
  });

  // Bulk reorder (used for addon reorder within a project)
  const reorder = useMutation({
    mutationFn: async (orders: { id: string; order: number }[]) => {
      startTask({ id: 'reorder', title: t('hier.reordering') });
      await Promise.all(orders.map((o) => api.patchAgent(o.id, { order: o.order })));
    },
    onMutate: async (orders) => {
      await qc.cancelQueries({ queryKey: ['agents'] });
      const prev = qc.getQueryData<Agent[]>(['agents']);
      const orderMap = new Map(orders.map((o) => [o.id, o.order]));
      qc.setQueryData<Agent[]>(['agents'], (old) =>
        (old ?? []).map((a) => (orderMap.has(a.id) ? { ...a, order: orderMap.get(a.id)! } : a))
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev && qc.setQueryData(['agents'], ctx.prev);
      completeTask('reorder');
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['agents'] });
      requestAnimationFrame(() => completeTask('reorder'));
    }
  });

  // Pointer for desktop/mouse, Touch for mobile. Touch uses a long-press
  // activation (250ms + 5px tolerance) so normal scroll gestures don't
  // accidentally trigger a drag on mobile.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  const agents: Agent[] = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const projects: Project[] = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);
  const hierarchy = useMemo(() => buildHierarchy(agents, projects), [agents, projects]);

  // Palette = unassigned agents only (visibility.ts 헬퍼 사용)
  const unassigned = useMemo(
    () => agents.filter(isUnassignedAgent),
    [agents]
  );

  const paletteVisible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? unassigned.filter(
          (a) =>
            a.id.toLowerCase().includes(q) ||
            (a.name ?? '').toLowerCase().includes(q) ||
            (a.model ?? '').toLowerCase().includes(q)
        )
      : unassigned;
    return filtered.slice().sort((a, b) =>
      (a.name ?? a.id).localeCompare(b.name ?? b.id)
    );
  }, [unassigned, search]);

  if (agentsQ.isLoading || projectsQ.isLoading)
    return <div className="text-zinc-500">Loading hierarchy...</div>;

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    const a = agents.find(ag => ag.id === id);
    if (a) setDraggingAgent(a);
  }

  function onDragEnd(e: DragEndEvent) {
    setDraggingAgent(null);
    const agentId = String(e.active.id);
    const overId = e.over?.id;
    if (!overId) return;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    const overStr = String(overId);

    // Ignore self-drop
    if (overStr === agentId) return;

    // Case 1: dropped on another agent card
    const overAgent = agents.find((a) => a.id === overStr);
    if (overAgent) {
      // Reorder within Main tier
      if (agent.tier === 'main' && overAgent.tier === 'main') {
        const mainList = hierarchy.main;
        const oldIndex = mainList.findIndex((a) => a.id === agentId);
        const newIndex = mainList.findIndex((a) => a.id === overAgent.id);
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
        const reordered = arrayMove(mainList, oldIndex, newIndex);
        const orders = reordered.map((a, i) => ({ id: a.id, order: i * 10 }));
        reorder.mutate(orders);
        return;
      }
      // Reorder within same project addons
      if (
        agent.tier === 'addon' &&
        overAgent.tier === 'addon' &&
        agent.projectId &&
        agent.projectId === overAgent.projectId
      ) {
        const projectAddons =
          hierarchy.projects.find((b) => b.project?.id === agent.projectId)?.addons ?? [];
        const oldIndex = projectAddons.findIndex((a) => a.id === agentId);
        const newIndex = projectAddons.findIndex((a) => a.id === overAgent.id);
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
        const reordered = arrayMove(projectAddons, oldIndex, newIndex);
        const orders = reordered.map((a, i) => ({ id: a.id, order: i * 10 }));
        reorder.mutate(orders);
        return;
      }
      // Dropping on a placed agent card of a different project -> move to that project as addon
      if (overAgent.projectId && overAgent.projectId !== agent.projectId) {
        const bucket = hierarchy.projects.find((b) => b.project?.id === overAgent.projectId);
        const leadId = bucket?.lead?.id ?? hierarchy.main[0]?.id ?? null;
        mutate.mutate({
          id: agentId,
          patch: { tier: 'addon', projectId: overAgent.projectId, parentId: leadId }
        });
        return;
      }
      // Dropping on the main agent -> put as top-level project under it (or addon if none)
      return;
    }

    // Case 2: dropped on a named drop zone (main / project-lead / project-addon / palette)
    const target = decodeDrop(overStr);
    if (!target) return;

    // 버그 방지: 같은 프로젝트 LEAD 를 ADDON 존으로 떨어뜨려 의도치 않게 강등되는 것 차단
    // 강등은 명시적으로 ⬇ 버튼으로만 허용
    if (
      target.kind === 'project-addon' &&
      agent.tier === 'project' &&
      agent.projectId === target.projectId
    ) {
      return;
    }

    const patch = targetToPatch(target, hierarchy, agentId);

    // Special: if target is the same project's addon container AND we're already an addon
    // there -> append to end (gets highest order)
    if (
      target.kind === 'project-addon' &&
      agent.tier === 'addon' &&
      agent.projectId === target.projectId
    ) {
      const projectAddons =
        hierarchy.projects.find((b) => b.project?.id === target.projectId)?.addons ?? [];
      const others = projectAddons.filter((a) => a.id !== agentId);
      const reordered = [...others, agent];
      const orders = reordered.map((a, i) => ({ id: a.id, order: i * 10 }));
      reorder.mutate(orders);
      return;
    }

    // Same special case for Main tier: dropped on Main container while already in Main -> append to end
    if (target.kind === 'main' && agent.tier === 'main') {
      const mainList = hierarchy.main;
      const others = mainList.filter((a) => a.id !== agentId);
      const reordered = [...others, agent];
      const orders = reordered.map((a, i) => ({ id: a.id, order: i * 10 }));
      reorder.mutate(orders);
      return;
    }

    if (
      patch.tier === agent.tier &&
      patch.projectId === agent.projectId &&
      patch.parentId === agent.parentId
    ) {
      return;
    }
    mutate.mutate({ id: agentId, patch });
  }

  // ── 카드 액션 핸들러 (드래그 없이 클릭으로 이동) ─────────
  const mainId = hierarchy.main[0]?.id ?? null;
  const onRemoveFromProject = (a: Agent) => {
    mutate.mutate({ id: a.id, patch: { tier: null, projectId: null, parentId: null } });
  };
  const onPromoteToLead = (a: Agent) => {
    if (!a.projectId) return;
    mutate.mutate({
      id: a.id,
      patch: { tier: 'project', projectId: a.projectId, parentId: mainId }
    });
  };
  const onDemoteToAddon = (a: Agent) => {
    if (!a.projectId) return;
    mutate.mutate({
      id: a.id,
      patch: { tier: 'addon', projectId: a.projectId, parentId: mainId }
    });
  };

  return (
    <DndContext
      sensors={sensors}
      // Custom collision: prefer pointer-under-cursor (picks specific sortable card over container),
      // fall back to rectIntersection for empty-container drops
      collisionDetection={(args) => {
        const pointer = pointerWithin(args);
        if (pointer.length > 0) return pointer;
        return rectIntersection(args);
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        className={
          splitLayout
            ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 pb-4 items-start'
            : 'flex flex-col gap-4 pb-4'
        }
      >
        {/* LEFT: Main + Projects (natural scroll) */}
        <div className="flex flex-col gap-4 min-w-0">
          <MainSlot
            agents={hierarchy.main}
            onEdit={onEdit}
            onDelete={onDelete}
            onClone={onClone}
            onContextMenu={openContextMenu}
            onRemoveFromProject={onRemoveFromProject}
          />
          <div className="flex flex-col gap-3">
            <SectionLabel icon={<Boxes size={14} />} label={t('hier.projects')} />
            {projects.map((p) => {
              const bucket = hierarchy.projects.find((b) => b.project?.id === p.id);
              return (
                <ProjectBlock
                  key={p.id}
                  project={p}
                  lead={bucket?.lead ?? null}
                  addons={bucket?.addons ?? []}
                  collapsed={collapsed.has(p.id)}
                  onToggleCollapse={() => toggleCollapse(p.id)}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onClone={onClone}
                  onContextMenu={openContextMenu}
                  onRemoveFromProject={onRemoveFromProject}
                  onPromoteToLead={onPromoteToLead}
                  onDemoteToAddon={onDemoteToAddon}
                />
              );
            })}
          </div>
        </div>

        {/* RIGHT: Palette (unassigned pool) -- sticky, follows scroll */}
        <div className={splitLayout ? 'lg:sticky lg:top-4 self-start min-w-0' : ''}>
          <Palette
            agents={paletteVisible}
            search={search}
            onSearchChange={setSearch}
            onEdit={onEdit}
            onDelete={onDelete}
            onClone={onClone}
            onContextMenu={openContextMenu}
          />
        </div>
      </div>
      {ctxMenu && (
        <AgentContextMenu
          state={ctxMenu}
          projects={projects}
          hierarchy={hierarchy}
          onClose={() => setCtxMenu(null)}
          onMove={(patch) => {
            mutate.mutate({ id: ctxMenu.agent.id, patch });
            setCtxMenu(null);
          }}
        />
      )}
      {/* Drag overlay: 드래그 중인 카드를 커서 따라 움직이는 프리뷰 */}
      <DragOverlay dropAnimation={{ duration: 200 }}>
        {draggingAgent && (
          <div className="rounded border-2 border-emerald-400/60 bg-zinc-900 shadow-2xl shadow-emerald-900/40 p-2.5 select-none rotate-2 opacity-95 pointer-events-none">
            <div className="flex items-center gap-2">
              <span className="text-lg">{draggingAgent.avatar ?? '🤖'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{draggingAgent.name}</div>
                <div className="text-[11px] text-zinc-400 font-mono">{draggingAgent.id}</div>
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
              <span className="px-1.5 py-0.5 rounded bg-zinc-800">{draggingAgent.model ?? '—'}</span>
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
