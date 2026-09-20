/**
 * 위임 대상 명단(로스터) 생성. ID 만 나열하면 플래너가 존재하지 않는 ID 를
 * 지어내므로, 각 에이전트의 systemPrompt 에 적힌 역할 줄을 함께 노출한다.
 */

const ROLE_LINE = /^>\s*\*\*역할\*\*\s*:\s*(.+)$/m;

/** '- id — 역할' 한 줄. 역할이 없으면 name, 그것도 없으면 ID 만. host 가 있으면 끝에 '[원격: <host>]'. */
export function describeAgent(id, agentConfig) {
  const role = ROLE_LINE.exec(agentConfig?.systemPrompt || '')?.[1]?.trim();
  const host = agentConfig?.host;
  const suffix = host ? ` [원격: ${host}]` : '';
  if (role) return `- ${id} — ${role}${suffix}`;
  const name = agentConfig?.name;
  if (name && name !== id) return `- ${id} — ${name}${suffix}`;
  return `- ${id}${suffix}`;
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
  const lines = ids.map((id) => describeAgent(id, agents?.[id]));
  const hasRemote = ids.some((id) => agents?.[id]?.host);
  if (hasRemote) {
    lines.push('원격 에이전트와는 파일이 공유되지 않습니다 — 결과는 커밋·푸시로 받습니다.');
  }
  return lines.join('\n');
}
