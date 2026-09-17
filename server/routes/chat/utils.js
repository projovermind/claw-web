import { logger } from '../../lib/logger.js';
import { resolveConfigDir } from '../../lib/config-dir.js';
import { resolveTierModel, tierBackendId as tierBackendOf } from '../../lib/model-tiers.js';

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
  // `rate_limit:` 는 러너가 한도 result 를 onError 로 돌릴 때 붙이는 프리픽스.
  // 공백형('rate limit')과 달리 기존 조건에 안 걸려서 unrecoverable 로 떨어졌다.
  if (msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('429')) {
    return { canRetry: true, delay: 60000, label: 'rate_limit' };
  }
  if (msg.includes('overloaded') || msg.includes('529') || msg.includes('503')) {
    return { canRetry: true, delay: 30000, label: 'overloaded' };
  }
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('network')) {
    return { canRetry: true, delay: 3000, label: 'network' };
  }
  // Claude CLI 내부 fetch()(undici) 가 API 스트림 도중 소켓이 끊길 때 던지는 에러.
  // "The socket connection was closed unexpectedly" / "other side closed" / "terminated" 등.
  // 일시적 네트워크/터널(cloudflared) 흔들림이라 재시도로 대개 복구됨.
  if (msg.includes('socket connection was closed') || msg.includes('closed unexpectedly')
      || msg.includes('other side closed') || (msg.includes('connection') && msg.includes('closed'))) {
    return { canRetry: true, delay: 3000, label: 'socket_closed' };
  }
  if (msg.includes('context') && (msg.includes('long') || msg.includes('length') || msg.includes('exceed'))) {
    return { canRetry: true, delay: 1000, label: 'context_length' };
  }
  // Runner 가 system.init 에서 --resume 드롭을 감지해 abort 한 경우.
  // 재시도는 반드시 claudeSessionId=null 로 해야 동일 조건 반복 루프를 피함.
  if (msg.includes('silent_fallback')) {
    return { canRetry: true, delay: 300, label: 'silent_fallback' };
  }
  // Claude CLI 가 --resume 대상 jsonl 을 못 찾고 stderr 로 "No conversation found
  // with session ID: <uuid>" 출력 후 종료. pre-check(findClaudeSessionFile) 통과
  // 후에도 발생 가능 — cross-account configDir 전환 실패, 파일 손상, race condition 등.
  // → 동일 sessionId 반복 시도해도 같은 결과이므로 fresh-start 로 전환 필요.
  if (msg.includes('no conversation found with session id')) {
    return { canRetry: true, delay: 300, label: 'no_conversation' };
  }
  // Claude CLI 가 stderr 없이 exit != 0 로 종료 (runner.js 가 생성한 'claude CLI exited N'
  // 또는 'exit N' fallback 메시지). 주로 --resume 세션 손상/모델 일시 장애.
  // → 1회만 재시도 허용 (message-sender 에서 counter 로 cap). claudeSessionId 는 자동 클리어됨.
  if (/^claude cli exited\s+\d+/i.test(errMsg) || /^exit\s+\d+\s*$/i.test(msg)) {
    return { canRetry: true, delay: 1500, label: 'cli_exit' };
  }
  return { canRetry: false, delay: 0, label: 'unrecoverable' };
}

/**
 * Replace attachment references in a message content string with a compact placeholder.
 * Applied to messages older than the recent N turns to reduce token usage.
 * Patterns: markdown images, <claw-download> tags, bare /uploads/ paths.
 */
function redactAttachments(content) {
  if (typeof content !== 'string') return content;
  // ![alt](path) or ![alt](path "title")
  content = content.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_, path) => {
    const filename = path.trim().split('/').pop().split(' ')[0];
    return `[첨부: ${filename}]`;
  });
  // <claw-download path="..." ... />
  content = content.replace(/<claw-download[^>]*path="([^"]+)"[^>]*\/?>/g, (_, path) => {
    const filename = path.trim().split('/').pop();
    return `[첨부: ${filename}]`;
  });
  // bare /uploads/... paths not already caught above
  content = content.replace(/\/uploads\/[^\s)\]"]+/g, (match) => {
    const filename = match.split('/').pop();
    return `[첨부: ${filename}]`;
  });
  return content;
}

/**
 * Build a conversation summary for fresh-start retries when --resume is dropped.
 * Older messages are compressed (first 200 chars); the last `recent` messages kept in full.
 * Output is prefixed onto the next user message so the model has context without --resume.
 * Default: 10 messages (≈ 5 user-assistant turns) preserved verbatim.
 * Attachment paths/images in older messages are replaced with placeholders to reduce tokens.
 */
function extractAttachmentFilenames(content) {
  if (typeof content !== 'string') return [];
  const names = new Set();
  for (const [, path] of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    names.add(path.trim().split('/').pop().split(' ')[0]);
  }
  for (const [, path] of content.matchAll(/<claw-download[^>]*path="([^"]+)"[^>]*\/?>/g)) {
    names.add(path.trim().split('/').pop());
  }
  for (const [match] of content.matchAll(/\/uploads\/[^\s)\]"]+/g)) {
    names.add(match.split('/').pop());
  }
  return [...names];
}

export function buildConversationSummary(messages = [], { recent = 14 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const older = messages.slice(0, -recent);
  const tail = messages.slice(-recent);
  const lines = [];
  lines.push('[이전 대화 컨텍스트 — 세션이 새로 시작되어 요약으로 전달됨]');
  lines.push('');
  if (older.length > 0) {
    const olderAttachments = [];
    lines.push(`## 이전 대화 (${older.length}개 메시지, 압축됨)`);
    for (const m of older) {
      olderAttachments.push(...extractAttachmentFilenames(m.content ?? ''));
      const role = m.role === 'user' ? '👤' : '🤖';
      const redacted = redactAttachments(m.content ?? '');
      const content = redacted.replace(/\n/g, ' ').slice(0, 600);
      const ellipsis = redacted.length > 600 ? '...' : '';
      lines.push(`- ${role} ${content}${ellipsis}`);
    }
    lines.push('');
    const uniqueAttachments = [...new Set(olderAttachments)];
    if (uniqueAttachments.length > 0) {
      lines.push('## 이전 첨부 파일');
      for (const f of uniqueAttachments) lines.push(`- ${f}`);
      lines.push('');
    }
  }
  if (tail.length > 0) {
    lines.push(`## 최근 대화 (${tail.length}개 메시지, 전문)`);
    lines.push('');
    for (const m of tail) {
      const role = m.role === 'user' ? '👤 User' : '🤖 Assistant';
      lines.push(`### ${role}`);
      lines.push(m.content ?? '');
      lines.push('');
    }
  }
  return lines.join('\n');
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
 *
 * 우선순위: agent.backendId(개별 지정) > 절약 모드 > 티어가 고른 백엔드
 * (tiers.backends[agent.modelTier]) > 전역 activeBackend.
 *
 * 티어→백엔드 해석을 여기 한 곳에만 두는 이유: buildBackendEnv 와 resolveAgent 가
 * 각각 이 함수를 부르므로, 양쪽이 자동으로 같은 백엔드를 보게 된다.
 *
 * Handles model→backend auto-remapping (glm-* → zai, claude-* → claude) —
 * 단, 티어가 백엔드를 고른 경우엔 그 결정과 싸우지 않도록 건너뛴다.
 */
export function resolveBackend(agent, backendsStore) {
  if (!backendsStore) return { backendId: 'claude', backendType: 'claude-cli', backendObj: null };
  const raw = backendsStore.getRaw();
  const agentBackendId = agent?.backendId;
  // 절약 모드가 켜져 있어도 대상 백엔드가 실제로 등록돼 있어야 한다. 없으면
  // backendObj 가 null 이 되고 backendType 이 'claude-cli' 로 기본값을 먹어서
  // "절약 모드인데 조용히 클로드로 나가는" 상태가 된다 → 평소 백엔드로 되돌린다.
  let globalActiveId = raw?.activeBackend;
  let austerityActive = false;
  if (raw?.austerityMode) {
    if (raw?.backends?.[raw.austerityBackend]) {
      globalActiveId = raw.austerityBackend;
      austerityActive = true;
    } else {
      logger.warn({ austerityBackend: raw.austerityBackend, fellBackTo: globalActiveId },
        'resolveBackend: 절약 모드 대상 백엔드가 없어 activeBackend 로 폴백');
    }
  }

  // 티어가 고른 백엔드. 개별 지정과 절약 모드가 둘 다 없을 때만 본다.
  // 가리키는 백엔드가 지워졌으면 무시하고 전역으로 간다 — 조용히 죽는 것보다 낫다.
  let tierBackendId = null;
  if (!agentBackendId && !austerityActive && agent?.modelTier) {
    const wanted = tierBackendOf(raw?.tiers, agent.modelTier);
    if (wanted && raw?.backends?.[wanted]) tierBackendId = wanted;
    else if (wanted) {
      logger.warn({ agent: agent?.id, tier: agent.modelTier, backendId: wanted },
        'resolveBackend: 티어가 가리키는 백엔드가 등록돼 있지 않음 — 전역 백엔드로 진행');
    }
  }

  let backendId = agentBackendId || tierBackendId || globalActiveId || 'claude';
  let backendObj = raw?.backends?.[backendId] ?? null;

  // 레거시 자동 리라우팅은 티어 결정이 없을 때만. 티어가 백엔드를 골랐는데 여기서
  // 모델명만 보고 다른 백엔드로 틀면 사용자가 정한 급별 라우팅이 조용히 새어 나간다.
  const model = !tierBackendId && typeof agent?.model === 'string' ? agent.model.toLowerCase() : '';
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
 * Env for one concrete backend object. anthropic-compatible 만 실제 env 가 필요하고
 * (Claude CLI 를 게이트웨이로 돌려세우는 값들), 나머지 타입은 빈 객체다.
 */
function envForBackend(backendObj, agent) {
  if (backendObj?.type !== 'anthropic-compatible') return {};
  const env = {};
  if (backendObj.baseURL) {
    env.ANTHROPIC_BASE_URL = backendObj.baseURL;
    if (backendObj.envKey) {
      const tok = process.env[backendObj.envKey];
      if (tok) env.ANTHROPIC_AUTH_TOKEN = tok;
    }
    env.API_TIMEOUT_MS = env.API_TIMEOUT_MS ?? '3000000';
  }
  // 게이트웨이가 opus/sonnet/haiku 요청을 무엇으로 받을지. 티어 매핑이 있으면
  // 그쪽이 사용자가 실제로 정한 값이므로 우선하고, 없는 항목만 models 로 메운다.
  const models = backendObj.models ?? {};
  const tierModels = backendObj.tierModels ?? {};
  const opus = tierModels.high ?? models.opus;
  const sonnet = tierModels.middle ?? models.sonnet;
  const haiku = tierModels.low ?? models.haiku;
  if (opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  if (sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
  if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  // 티어를 쓰는 에이전트는 아래 resolveAgent 의 티어 해석이 모델을 확정한다.
  // 여기서 'default' 를 sonnet 으로 바꿔 버리면 그 해석 전에 급이 뒤바뀐다.
  if (!agent?.modelTier && agent?.model === 'default') agent.model = 'sonnet';
  return env;
}

/**
 * Build env overrides for Claude CLI (anthropic-compatible backends only).
 */
export function buildBackendEnv(agent, backendsStore) {
  const { backendObj } = resolveBackend(agent, backendsStore);
  if (!backendObj) return {};
  return envForBackend(backendObj, agent);
}

/**
 * 1차 백엔드가 실패했을 때 쓸 폴백 백엔드를 실행 가능한 형태로 푼다.
 *
 * 우선순위: backend.fallback > 전역 fallbackBackend.
 * 자기 자신을 가리키거나 등록되지 않은 id 면 폴백 없음(null)으로 취급한다 —
 * 그래야 러너가 같은 실패를 한 번 더 반복하지 않는다.
 *
 * @returns {{ backendId, backendType, envOverrides, configDir }|null}
 */
export function resolveFallbackBackend(agent, backendsStore, primaryBackendId) {
  if (!backendsStore) return null;
  const raw = backendsStore.getRaw();
  const primaryObj = raw?.backends?.[primaryBackendId] ?? null;
  const fallbackId = primaryObj?.fallback || raw?.fallbackBackend || null;
  if (!fallbackId || fallbackId === primaryBackendId) return null;

  const fallbackObj = raw?.backends?.[fallbackId] ?? null;
  if (!fallbackObj) {
    logger.warn({ agent: agent?.id, primaryBackendId, fallbackId },
      'resolveFallbackBackend: 폴백 대상 백엔드가 등록돼 있지 않음 — 폴백 없이 진행');
    return null;
  }

  const envOverrides = envForBackend(fallbackObj, agent);
  envOverrides._backendsStore = backendsStore;
  envOverrides._resolvedBackendId = fallbackId;

  return {
    backendId: fallbackId,
    backendType: fallbackObj.type || 'claude-cli',
    envOverrides,
    configDir: fallbackObj.type === 'claude-cli' ? resolveConfigDir(fallbackId, fallbackObj.configDir) : null
  };
}

/**
 * Resolve an agent with full inheritance (skills, tools, backend).
 */
export function resolveAgent(agentId, { configStore, metadataStore, projectsStore, backendsStore, skillsStore, systemSkillsStore, accountsStore, modelOverride }) {
  const agentConfig = configStore.getAgent(agentId);
  if (!agentConfig) return null;
  const meta = metadataStore?.getAgent(agentId) ?? {};
  const agent = { id: agentId, ...agentConfig, ...meta };

  // 세션별 모델 오버라이드: 아래 백엔드 라우팅/별칭 해석이 모두 이 값을 기준으로
  // 동작하도록 가장 먼저 덮어쓴다. (별칭 또는 raw 모델 ID 모두 허용)
  if (typeof modelOverride === 'string' && modelOverride.trim()) {
    agent.model = modelOverride.trim();
  }

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

  // ── 모델 티어 해석 (최우선) ──
  // agent.modelTier 가 있으면 "어느 급" 이 모델 지정을 이긴다. 해석된 뒤에도
  // modelAlias 에 티어 이름을 남겨 둬야 폴백 백엔드에서 그 백엔드의 tierModels
  // 기준으로 다시 풀린다 (runner._startFallback).
  const tierHit = agent.modelTier
    ? resolveTierModel({ backendObj, tier: agent.modelTier, tiers: backendsStore?.getRaw?.()?.tiers })
    : null;
  if (tierHit) {
    if (tierHit.demoted || tierHit.fromDefault) {
      logger.info(
        { agentId: agent.id, backendId, requestedTier: tierHit.requestedTier, usedTier: tierHit.tier, model: tierHit.modelId },
        'resolveAgent: 요청한 티어가 이 백엔드에 없어 강등/기본값으로 해석'
      );
    }
    agent.model = tierHit.modelId;
  }

  // ── 모델 별칭 해석 ──
  // 해석 전 원본을 남겨 둔다. 폴백 백엔드는 models 맵이 달라서, 1차 백엔드 기준으로
  // 확정된 모델 ID 를 그대로 들고 가면 남의 모델명을 전선에 싣게 된다.
  // runner._startFallback 이 이 별칭을 폴백 백엔드 기준으로 다시 해석한다.
  const originalModelAlias = typeof agent.model === 'string' ? agent.model : null;
  // 백엔드 models 딕셔너리: { "opus sub": "claude-opus-4-5", ... }
  // agent.model이 별칭(예: "opus sub")이면 실제 모델 ID로 교체.
  // 1차: 선택된 백엔드에서 해석 시도
  if (!tierHit && backendObj?.models && agent.model) {
    const resolvedId = backendObj.models[agent.model];
    if (resolvedId) {
      agent.model = resolvedId;
    }
  }
  // 2차: 여전히 별칭이 남아있으면 agent.backendId 원본 백엔드에서 시도
  if (!tierHit && !backendObj?.models?.[agent.model] && backendsStore && agent.backendId) {
    const originalBackend = backendsStore.getBackend(agent.backendId);
    if (originalBackend?.models && agent.model) {
      const resolvedId = originalBackend.models[agent.model];
      if (resolvedId) agent.model = resolvedId;
    }
  }
  // 3차: backendId 없는 에이전트가 서브계정 별칭(e.g. "sonnet sub")을 사용하는 경우
  // → 모든 백엔드를 스캔해서 해당 별칭을 가진 첫 번째 백엔드로 해석
  if (!tierHit && backendsStore && agent.model) {
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

  // 러너의 managed OAuth 토큰 주입 / 사용량·쿨다운 기록이 동작하려면 backendsStore
  // 참조와 "해석된" backendId 가 필요하다. agent.backendId 가 비어 있어도(전역 active
  // 백엔드 사용) 재인증으로 저장한 managed 토큰이 주입되도록 resolved id 를 함께 넘긴다.
  // (_ 프리픽스 키는 러너 env 주입 루프에서 제외되어 child env 로 새지 않음)
  if (backendsStore) {
    envOverrides._backendsStore = backendsStore;
    envOverrides._resolvedBackendId = backendId;
  }

  // 별칭이 실제로 다른 ID 로 치환된 경우에만 보존 — 원래부터 raw 모델 ID 면 폴백도 그대로 쓴다.
  // 티어로 해석된 경우엔 (강등됐더라도) 요청한 티어 이름을 보존한다.
  if (tierHit) {
    agent.modelAlias = tierHit.requestedTier;
  } else if (originalModelAlias && agent.model !== originalModelAlias) {
    agent.modelAlias = originalModelAlias;
  }

  const fallback = resolveFallbackBackend(agent, backendsStore, backendId);

  return {
    agent, envOverrides, backendType,
    backendConfig: { backendName: backendId, fallbackId: fallback?.backendId ?? null, fallback }
  };
}
