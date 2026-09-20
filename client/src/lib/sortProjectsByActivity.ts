import type { Agent, Project, SessionMeta } from './types';

/**
 * 프로젝트를 "최근 대화순"으로 정렬한다.
 * lastActivity = max(project.lastActivityAt, 해당 프로젝트 소속 에이전트(agent.projectId)의 세션들 중 max(updatedAt)).
 * - project.lastActivityAt: 서버가 전체 세션 기준으로 계산해 내려주는 값 (allSessions 페이지네이션 한계를 커버).
 * - 세션 스캔: 서버 값이 아직 없거나 오래된 경우를 보완하는 실시간 갱신용 폴백.
 * 둘 다 없는 프로젝트는 활동한 프로젝트들 뒤로 밀리되, 그들끼리는 원래 순서를 유지한다.
 */
export function sortProjectsByActivity(
  projects: Project[],
  agents: Agent[],
  allSessions: SessionMeta[]
): Project[] {
  const projectIdByAgentId = new Map<string, string>();
  for (const a of agents) {
    if (a.projectId) projectIdByAgentId.set(a.id, a.projectId);
  }

  const lastActivityByProject = new Map<string, number>();
  for (const p of projects) {
    const ts = Date.parse(p.lastActivityAt ?? '');
    if (!Number.isNaN(ts)) lastActivityByProject.set(p.id, ts);
  }
  for (const s of allSessions) {
    const projectId = projectIdByAgentId.get(s.agentId);
    if (!projectId) continue;
    const ts = Date.parse(s.updatedAt ?? '');
    if (Number.isNaN(ts)) continue;
    const prev = lastActivityByProject.get(projectId);
    if (prev === undefined || ts > prev) lastActivityByProject.set(projectId, ts);
  }

  return projects
    .map((p, index) => ({ project: p, index, lastActivity: lastActivityByProject.get(p.id) }))
    .sort((a, b) => {
      if (a.lastActivity === undefined && b.lastActivity === undefined) return a.index - b.index;
      if (a.lastActivity === undefined) return 1;
      if (b.lastActivity === undefined) return -1;
      return b.lastActivity - a.lastActivity;
    })
    .map((entry) => entry.project);
}
