import { logger } from '../../lib/logger.js';

/**
 * Classify an error message and return retry strategy.
 * @returns {{ canRetry: boolean, delay: number, label: string }}
 */
export function classifyError(errMsg = '') {
  const msg = errMsg.toLowerCase();
  // 쿨다운 선제 차단 메시지 (runner pre-spawn) — 재시도 불가, 사용자에게 바로 표시
  if (msg.includes('사용량 한도 도달') || msg.includes('자동 복구됩니다')) {
    return { canRetry: false, delay: 0, label: 'rate_limit_cooldown' };
  }
  if (msg.includes('rate limit') || msg.includes('429')) {
    return { canRetry: true, delay: 60000, label: 'rate_limit' };
  }
  if (msg.includes('overloaded') || msg.includes('529') || msg.includes('503')) {
    return { canRetry: true, delay: 30000, label: 'overloaded' };
  }
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('network')) {
    return { canRetry: true, delay: 3000, label: 'network' };
  }
  if (msg.includes('context') && (msg.includes('long') || msg.includes('length') || msg.includes('exceed'))) {
    return { canRetry: true, delay: 1000, label: 'context_length' };
  }
  // Claude CLI 가 stderr 없이 exit != 0 로 종료 (runner.js 가 생성한 'claude CLI exited N'
  // 또는 'exit N' fallback 메시지). 주로 --resume 세션 손상/모델 일시 장애.
  // → 1회만 재시도 허용 (message-sender 에서 counter 로 cap). claudeSessionId 는 자동 클리어됨.
  if (/^claude cli exited\s+\d+/i.test(errMsg) || /^exit\s+\d+\s*$/i.test(msg)) {
    return { canRetry: true, delay: 1500, label: 'cli_exit' };
  }
  return { canRetry: false, delay: 0, label: 'unrecoverable' };
}

export function resolveSkills(ids, skillsStore, systemSkillsStore) {
  if (!ids || ids.length === 0) return [];
  return ids
    .map((id) =>
      id.startsWith('sys:')
        ? systemSkillsStore?.get(id) ?? null
        : skillsStore?.get(id) ?? null
    )
    .filter(Boolean);
}

/**
 * Resolve the active backend for an agent.
 * Handles model→backend auto-remapping (glm-* → zai, claude-* → claude).
 */
export function resolveBackend(agent, backendsStore) {
  if (!backendsStore) return { backendId: 'claude', backendType: 'claude-cli', backendObj: null };
  const raw = backendsStore.getRaw();
  const agentBackendId = agent?.backendId;
  const globalActiveId = raw?.austerityMode ? raw.austerityBackend : raw?.activeBackend;
  let backendId = agentBackendId || globalActiveId || 'claude';
  let backendObj = raw?.backends?.[backendId] ?? null;

  const model = typeof agent?.model === 'string' ? agent.model.toLowerCase() : '';
  if (model) {
    const currentType = backendObj?.type;
    const isGlm = model.startsWith('glm-');
    const isClaudeModelId = model.startsWith('claude-');
    if (isGlm && currentType === 'claude-cli' && raw?.backends?.zai) {
      backendId = 'zai';
      backendObj = raw.backends.zai;
      logger.warn({ agent: agent?.id, model, autoRoutedTo: 'zai' },
        'resolveBackend: glm-* model rerouted to Z.AI (backend was claude-cli)');
    } else if (isClaudeModelId && currentType === 'openai-compatible' && raw?.backends?.claude) {
      backendId = 'claude';
      backendObj = raw.backends.claude;
      logger.warn({ agent: agent?.id, model, autoRoutedTo: 'claude' },
        'resolveBackend: claude-* model rerouted to Claude CLI (backend was openai-compatible)');
    }
  }

  const backendType = backendObj?.type || 'claude-cli';
  return { backendId, backendType, backendObj };
}

/**
 * Build env overrides for Claude CLI (anthropic-compatible backends only).
 */
export function buildBackendEnv(agent, backendsStore) {
  const { backendType, backendObj } = resolveBackend(agent, backendsStore);
  if (!backendObj || backendType !== 'anthropic-compatible') return {};
  const env = {};
  if (backendObj.baseURL) {
    env.ANTHROPIC_BASE_URL = backendObj.baseURL;
    if (backendObj.envKey) {
      const tok = process.env[backendObj.envKey];
      if (tok) env.ANTHROPIC_AUTH_TOKEN = tok;
    }
    env.API_TIMEOUT_MS = env.API_TIMEOUT_MS ?? '3000000';
  }
  const models = backendObj.models ?? {};
  if (models.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus;
  if (models.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet;
  if (models.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku;
  if (agent?.model === 'default') agent.model = 'sonnet';
  return env;
}

/**
 * Resolve an agent with full inheritance (skills, tools, backend).
 */
export function resolveAgent(agentId, { configStore, metadataStore, projectsStore, backendsStore, skillsStore, systemSkillsStore, accountsStore }) {
  const agentConfig = configStore.getAgent(agentId);
  if (!agentConfig) return null;
  const meta = metadataStore?.getAgent(agentId) ?? {};
  const agent = { id: agentId, ...agentConfig, ...meta };

  // 멀티 계정: accountId 지정 시 configDir 주입 → runner에서 CLAUDE_CONFIG_DIR로 사용
  if (agent.accountId && accountsStore) {
    const acc = accountsStore.getById(agent.accountId);
    if (acc?.configDir && acc.status !== 'disabled') {
      agent.configDir = acc.configDir;
    }
  }
  const project = meta.projectId && projectsStore
    ? projectsStore.getById(meta.projectId)
    : null;
  // 프로젝트 레벨 accountId → 스케줄러가 priority 2로 사용
  if (project?.accountId) agent.projectAccountId = project.accountId;
  const pSkills = Array.isArray(project?.defaultSkillIds) ? project.defaultSkillIds : [];
  const aSkills = Array.isArray(meta.skillIds) ? meta.skillIds : [];
  const mergedSkills = [...new Set([...pSkills, ...aSkills])];
  if (mergedSkills.length > 0) agent.skills = resolveSkills(mergedSkills, skillsStore, systemSkillsStore);
  const pAllow = Array.isArray(project?.defaultAllowedTools) ? project.defaultAllowedTools : [];
  const pDeny = Array.isArray(project?.defaultDisallowedTools) ? project.defaultDisallowedTools : [];
  const aAllow = Array.isArray(agentConfig.allowedTools) ? agentConfig.allowedTools : [];
  const aDeny = Array.isArray(agentConfig.disallowedTools) ? agentConfig.disallowedTools : [];
  const allow = [...new Set([...pAllow, ...aAllow])];
  const deny = [...new Set([...pDeny, ...aDeny])];
  if (allow.length) agent.allowedTools = allow;
  if (deny.length) agent.disallowedTools = deny;
  const envOverrides = buildBackendEnv(agent, backendsStore);
  const { backendId, backendType, backendObj } = resolveBackend(agent, backendsStore);

  // ── 모델 별칭 해석 ──
  // 백엔드 models 딕셔너리: { "opus sub": "claude-opus-4-5", ... }
  // agent.model이 별칭(예: "opus sub")이면 실제 모델 ID로 교체.
  // 1차: 선택된 백엔드에서 해석 시도
  if (backendObj?.models && agent.model) {
    const resolvedId = backendObj.models[agent.model];
    if (resolvedId) {
      agent.model = resolvedId;
    }
  }
  // 2차: 여전히 별칭이 남아있으면 agent.backendId 원본 백엔드에서 시도
  if (!backendObj?.models?.[agent.model] && backendsStore && agent.backendId) {
    const originalBackend = backendsStore.getBackend(agent.backendId);
    if (originalBackend?.models && agent.model) {
      const resolvedId = originalBackend.models[agent.model];
      if (resolvedId) agent.model = resolvedId;
    }
  }
  // 3차: backendId 없는 에이전트가 서브계정 별칭(e.g. "sonnet sub")을 사용하는 경우
  // → 모든 백엔드를 스캔해서 해당 별칭을 가진 첫 번째 백엔드로 해석
  if (backendsStore && agent.model) {
    const raw = backendsStore.getRaw();
    const allBackends = Object.values(raw?.backends ?? {});
    const isRawModelId = agent.model.startsWith('claude-') || agent.model.startsWith('glm-');
    if (!isRawModelId) {
      for (const b of allBackends) {
        if (b.models?.[agent.model]) {
          const resolvedId = b.models[agent.model];
          logger.info({ agentId: agent.id, alias: agent.model, resolvedId }, 'resolveAgent: alias resolved via global backend scan');
          agent.model = resolvedId;
          break;
        }
      }
    }
  }

  return {
    agent, envOverrides, backendType,
    backendConfig: { backendName: backendId, fallbackId: backendObj?.fallback || null }
  };
}
