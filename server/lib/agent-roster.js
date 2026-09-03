/**
 * 위임 대상 명단(로스터) 생성. ID 만 나열하면 플래너가 존재하지 않는 ID 를
 * 지어내므로, 각 에이전트의 systemPrompt 에 적힌 역할 줄을 함께 노출한다.
 */

const ROLE_LINE = /^>\s*\*\*역할\*\*\s*:\s*(.+)$/m;

/** '- id — 역할' 한 줄. 역할이 없으면 name, 그것도 없으면 ID 만. */
export function describeAgent(id, agentConfig) {
  const role = ROLE_LINE.exec(agentConfig?.systemPrompt || '')?.[1]?.trim();
  if (role) return `- ${id} — ${role}`;
  const name = agentConfig?.name;
  if (name && name !== id) return `- ${id} — ${name}`;
  return `- ${id}`;
}

/** 같은 프로젝트에 속한 위임 가능 에이전트 ID 목록. */
export function listProjectAgentIds({ agents, metadataStore, projectId, excludeAgentId }) {
  if (!projectId) return [];
  return Object.keys(agents || {}).filter(
    (id) => id !== excludeAgentId && metadataStore?.getAgent(id)?.projectId === projectId
  );
}

export function buildRoster(ids, agents, emptyText = '') {
  if (!ids?.length) return emptyText;
  return ids.map((id) => describeAgent(id, agents?.[id])).join('\n');
}
