import type { Agent } from './types';

const byOrder = (a: Agent, b: Agent) => {
  const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
  const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return (a.id ?? '').localeCompare(b.id ?? '');
};

/**
 * 한 에이전트가 협업 가능한(=알고 있는) 다른 에이전트 id 집합을 계산한다.
 *
 * 규칙:
 *  - 같은 프로젝트 내 다른 에이전트 (동급/수평 협업)
 *  - 자기의 하부(parentId 체인으로 내려오는) 에이전트들
 *  - 상위 에이전트는 보이지 않음 (단방향: 아래 + 옆만)
 *  - 다른 프로젝트의 에이전트는 보이지 않음 (tier:main 은 예외 — 프로젝트 없으므로 같은 프로젝트 규칙 무효, 대신 전부가 하부이긴 함)
 *
 * 반환: Set<agentId>  (자기 자신은 포함하지 않음)
 */
export function visibleFrom(agent: Agent, all: Agent[]): Set<string> {
  const visible = new Set<string>();

  // 1) 같은 프로젝트 내 다른 에이전트
  if (agent.projectId) {
    for (const other of all) {
      if (other.id === agent.id) continue;
      if (other.projectId === agent.projectId) visible.add(other.id);
    }
  }

  // 2) 자기 자손 (parentId 체인 타고 내려오는 애들)
  const children = new Map<string, Agent[]>();
  for (const a of all) {
    const p = a.parentId ?? '__root__';
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(a);
  }
  const stack: string[] = [agent.id];
  while (stack.length) {
    const cur = stack.pop()!;
    const kids = children.get(cur) ?? [];
    for (const k of kids) {
      if (k.id === agent.id) continue;
      if (!visible.has(k.id)) {
        visible.add(k.id);
        stack.push(k.id);
      }
    }
  }

  return visible;
}

export interface Hierarchy {
  main: Agent[]; // usually 1 (hivemind)
  projects: Array<{ project: { id: string; name?: string; color?: string } | null; lead: Agent | null; addons: Agent[] }>;
  unassigned: Agent[];
}

/**
 * 계층 구조를 UI 렌더링 편한 형태로 변환.
 * - tier='main' → main
 * - tier='project' → projects[].lead
 * - tier='addon' → projects[].addons
 * - tier 없음 or 이도저도 아님 → unassigned
 */
export function buildHierarchy(
  agents: Agent[],
  projects: { id: string; name: string; color?: string }[]
): Hierarchy {
  const main: Agent[] = [];
  const projectBuckets = new Map<
    string,
    { project: { id: string; name?: string; color?: string } | null; lead: Agent | null; addons: Agent[] }
  >();
  for (const p of projects) {
    projectBuckets.set(p.id, { project: p, lead: null, addons: [] });
  }
  const unassigned: Agent[] = [];

  for (const agent of agents) {
    if (agent.tier === 'main') {
      main.push(agent);
    } else if (agent.tier === 'project' && agent.projectId) {
      if (!projectBuckets.has(agent.projectId)) {
        projectBuckets.set(agent.projectId, { project: { id: agent.projectId }, lead: null, addons: [] });
      }
      const b = projectBuckets.get(agent.projectId)!;
      if (!b.lead) b.lead = agent;
      else b.addons.push(agent); // more than one "project"-tier agent in same project → treat extras as addons
    } else if (agent.tier === 'addon' && agent.projectId) {
      if (!projectBuckets.has(agent.projectId)) {
        projectBuckets.set(agent.projectId, { project: { id: agent.projectId }, lead: null, addons: [] });
      }
      projectBuckets.get(agent.projectId)!.addons.push(agent);
    } else {
      unassigned.push(agent);
    }
  }

  // Sort main + addons by order
  main.sort(byOrder);
  for (const bucket of projectBuckets.values()) {
    bucket.addons.sort(byOrder);
  }

  return {
    main,
    projects: Array.from(projectBuckets.values()).filter((b) => b.lead || b.addons.length > 0),
    unassigned
  };
}
