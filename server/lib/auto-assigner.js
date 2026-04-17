/**
 * Auto-Assigner — 에이전트 역할 기반 스킬/도구 자동 배분
 *
 * 에이전트의 id/name/systemPrompt를 분석해서 역할을 감지하고
 * 적절한 스킬과 도구를 자동으로 할당.
 */
import { logger } from './logger.js';

// ── 역할별 프리셋 ──────────────────────────────────────

const ROLE_PRESETS = {
  // 기획자/아키텍트 — 읽기만, 코드 수정 금지
  planner: {
    match: [/기획/, /planner/i, /architect/i, /아키텍트/, /총괄/],
    skills: ['코드 리뷰'],
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent'],
    disallowedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
    description: '기획/아키텍처 — 읽기 전용'
  },
  // 라우터 — 위임만, 실행 금지
  router: {
    match: [/라우터/, /router/i, /dispatcher/i],
    skills: [],
    allowedTools: ['Read', 'Grep', 'Glob', 'Agent', 'WebFetch'],
    disallowedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit', 'TodoWrite'],
    description: '라우팅/위임 — 읽기+에이전트 호출만'
  },
  // QA 테스터 — 테스트 실행, 리포트
  tester: {
    match: [/테스터/, /tester/i, /qa/i, /test/i],
    skills: ['TDD Workflow'],
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'WebFetch'],
    disallowedTools: [],
    description: '테스트/QA — 실행 + 리포트'
  },
  // 프론트엔드 개발자
  frontend: {
    match: [/frontend/i, /프론트엔드/, /ui/i, /component/i, /컴포넌트/],
    skills: ['TDD Workflow', '코드 리뷰', '코딩 공통 룰'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'WebFetch'],
    disallowedTools: [],
    description: '프론트엔드 개발'
  },
  // 백엔드/API 개발자
  backend: {
    match: [/api/i, /backend/i, /백엔드/, /server/i, /worker/i, /워커/],
    skills: ['TDD Workflow', '코드 리뷰', '코딩 공통 룰'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'WebFetch'],
    disallowedTools: [],
    description: '백엔드/API 개발'
  },
  // 데이터 엔지니어
  data: {
    match: [/data/i, /데이터/, /pipeline/i, /파이프/, /analyst/i, /분석/],
    skills: ['TDD Workflow', '코딩 공통 룰'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'WebFetch', 'NotebookEdit'],
    disallowedTools: [],
    description: '데이터 엔지니어링'
  },
  // 리서처 — 웹 조사 + 분석
  researcher: {
    match: [/research/i, /리서처/, /investigator/i],
    skills: [],
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite'],
    disallowedTools: ['Write', 'Edit', 'Bash'],
    description: '리서치 — 웹 조사'
  },
  // 리뷰어 — 코드 리뷰
  reviewer: {
    match: [/review/i, /리뷰/],
    skills: ['코드 리뷰', '코딩 공통 룰'],
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite'],
    disallowedTools: ['Write', 'Edit', 'Bash'],
    description: '코드 리뷰어'
  },
  // 보안/감사
  security: {
    match: [/security/i, /보안/, /audit/i, /감사/, /aegis/i],
    skills: ['코드 리뷰'],
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'TodoWrite'],
    disallowedTools: ['Write', 'Edit'],
    description: '보안 감사'
  },
  // 인스톨러/배포
  installer: {
    match: [/install/i, /인스톨/, /deploy/i, /배포/, /devops/i],
    skills: ['코딩 공통 룰'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite'],
    disallowedTools: [],
    description: '인스톨/배포'
  },
  // 범용 에이전트 (기본값)
  general: {
    match: [/general/i, /어시스턴트/, /assistant/i, /hivemind/i, /하이브마인드/],
    skills: ['TDD Workflow', '코드 리뷰', '코딩 공통 룰'],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'WebFetch', 'WebSearch', 'Agent', 'NotebookEdit'],
    disallowedTools: [],
    description: '범용 에이전트'
  }
};

// ── 역할 감지 ───────────────────────────────────────────

/**
 * 에이전트의 id/name/systemPrompt에서 역할을 감지
 */
export function detectRole(agent) {
  const haystack = [
    agent.id || '',
    agent.name || '',
    (agent.systemPrompt || '').slice(0, 500)
  ].join(' ').toLowerCase();

  // 우선순위: 특수 역할 먼저 매칭
  const priority = [
    'router', 'planner', 'tester', 'reviewer', 'researcher',
    'security', 'frontend', 'backend', 'data', 'installer', 'general'
  ];

  for (const roleKey of priority) {
    const preset = ROLE_PRESETS[roleKey];
    for (const pattern of preset.match) {
      if (pattern.test(haystack)) {
        return { role: roleKey, ...preset };
      }
    }
  }

  return { role: 'general', ...ROLE_PRESETS.general };
}

/**
 * 스킬 이름을 ID로 변환
 */
function skillNamesToIds(skillNames, skillsStore) {
  if (!skillsStore || skillNames.length === 0) return [];
  const allSkills = skillsStore.getAll?.() || [];
  const list = Array.isArray(allSkills) ? allSkills : Object.values(allSkills);
  const ids = [];
  for (const name of skillNames) {
    const match = list.find(s => s.name === name);
    if (match) ids.push(match.id);
  }
  return ids;
}

/**
 * 에이전트에 자동으로 스킬/도구 배분
 *
 * @param {object} agent - 에이전트 객체
 * @param {object} stores - { configStore, metadataStore, skillsStore }
 * @param {object} opts - { force: false } — true면 기존 값 덮어쓰기
 * @returns {object} - { role, skillIds, allowedTools, disallowedTools, description }
 */
export async function autoAssignAgent(agent, stores, opts = {}) {
  const { configStore, metadataStore, skillsStore } = stores;
  const { force = false } = opts;

  const detected = detectRole(agent);
  const result = { role: detected.role, description: detected.description };

  // 스킬 ID 변환
  const skillIds = skillNamesToIds(detected.skills, skillsStore);
  result.skills = detected.skills;
  result.skillIds = skillIds;

  // 기존 값 있으면 스킵 (force=false)
  const currentMeta = metadataStore?.getAgent(agent.id) || {};
  const currentSkillIds = currentMeta.skillIds || [];
  const currentAllowed = agent.allowedTools || [];
  const currentDisallowed = agent.disallowedTools || [];

  // 스킬 업데이트
  if (force || currentSkillIds.length === 0) {
    if (metadataStore && skillIds.length > 0) {
      await metadataStore.updateAgent(agent.id, { skillIds });
      result.skillsUpdated = true;
    }
  } else {
    result.skillsUpdated = false;
    result.skillsReason = 'existing skillIds preserved';
  }

  // 도구 업데이트
  if (force || (currentAllowed.length === 0 && currentDisallowed.length === 0)) {
    if (configStore) {
      await configStore.updateAgent(agent.id, {
        allowedTools: detected.allowedTools,
        disallowedTools: detected.disallowedTools
      });
      result.toolsUpdated = true;
      result.allowedTools = detected.allowedTools;
      result.disallowedTools = detected.disallowedTools;
    }
  } else {
    result.toolsUpdated = false;
    result.toolsReason = 'existing tools preserved';
  }

  logger.debug({ agent: agent.id, role: detected.role }, 'auto-assigner: completed');
  return result;
}

/**
 * 모든 에이전트 일괄 배분
 */
export async function autoAssignAll(stores, opts = {}) {
  const { configStore } = stores;
  const agents = configStore.getAgents?.() || {};
  const results = [];

  for (const [id, agent] of Object.entries(agents)) {
    try {
      const result = await autoAssignAgent({ id, ...agent }, stores, opts);
      results.push({ id, ...result });
    } catch (err) {
      logger.warn({ err: err.message, agent: id }, 'auto-assigner: failed');
      results.push({ id, error: err.message });
    }
  }

  return results;
}

export { ROLE_PRESETS };
