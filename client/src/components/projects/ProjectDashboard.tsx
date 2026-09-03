import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Project, Agent, GoalCard, CustomWidget, ProjectDashboard as DashboardData } from '../../lib/types';
import { NotesEditor } from './NotesEditor';
import { ProjectMemory } from './ProjectMemory';
import { GoalBoard } from './GoalBoard';
import { AgentTimeline } from './AgentTimeline';
import { AgentTokenStats } from './AgentTokenStats';
import { CustomWidgets } from './CustomWidgets';
import { ClaudeMemoryPanel } from './ClaudeMemoryPanel';

const EMPTY_DASHBOARD: DashboardData = { notes: '', goals: [], widgets: [] };

type Tab = 'dashboard' | 'claude-memory';

export function ProjectDashboard({
  project,
  agents
}: {
  project: Project;
  agents: Agent[];
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('dashboard');
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

      {/* 탭 */}
      <div className="flex gap-1 border-b border-zinc-800">
        {([
          ['dashboard', '대시보드'],
          ['claude-memory', 'Claude 메모리']
        ] as [Tab, string][]).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-3 py-1.5 text-xs -mb-px border-b-2 ${
              tab === value
                ? 'border-emerald-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'claude-memory' ? (
        <ClaudeMemoryPanel projectId={project.id} />
      ) : (
      <div className="space-y-4">
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
      )}
    </div>
  );
}
