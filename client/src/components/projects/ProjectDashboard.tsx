import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Project, Agent, GoalCard, CustomWidget, ProjectDashboard as DashboardData } from '../../lib/types';
import { NotesEditor } from './NotesEditor';
import { ProjectMemory } from './ProjectMemory';
import { GoalBoard } from './GoalBoard';
import { AgentTimeline } from './AgentTimeline';
import { AgentTokenStats } from './AgentTokenStats';
import { CustomWidgets } from './CustomWidgets';

const EMPTY_DASHBOARD: DashboardData = { notes: '', goals: [], widgets: [] };

export function ProjectDashboard({
  project,
  agents
}: {
  project: Project;
  agents: Agent[];
}) {
  const qc = useQueryClient();
  const dashboard = project.dashboard ?? EMPTY_DASHBOARD;

  const save = useMutation({
    mutationFn: (patch: Partial<DashboardData>) =>
      api.patchProject(project.id, {
        dashboard: { ...dashboard, ...patch }
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] })
  });

  return (
    <div className="space-y-4">
      {/* 프로젝트 헤더 */}
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: project.color ?? '#666' }} />
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">{project.name}</h3>
          <div className="text-[11px] text-zinc-500 font-mono">{project.path}</div>
        </div>
      </div>

      {/* 프로젝트 메모리 (에이전트 운영 컨텍스트) */}
      <ProjectMemory
        memory={dashboard.memory ?? ''}
        onSave={(memory) => save.mutate({ memory })}
      />

      {/* 메모 */}
      <NotesEditor
        notes={dashboard.notes}
        onSave={(notes) => save.mutate({ notes })}
      />

      {/* 칸반 목표 */}
      <GoalBoard
        goals={dashboard.goals}
        onUpdate={(goals: GoalCard[]) => save.mutate({ goals })}
      />

      {/* 에이전트 토큰 사용량 */}
      <AgentTokenStats agents={agents} />

      {/* 에이전트 타임라인 */}
      <AgentTimeline agents={agents} projectId={project.id} />

      {/* 커스텀 위젯 */}
      <CustomWidgets
        widgets={dashboard.widgets}
        onUpdate={(widgets: CustomWidget[]) => save.mutate({ widgets })}
      />
    </div>
  );
}
