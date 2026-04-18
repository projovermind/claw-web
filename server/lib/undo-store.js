import { nanoid } from 'nanoid';

const MAX_STACK = 10;
const stack = [];

/**
 * patch 내용을 보고 한국어 description 자동 생성
 */
function describeFromPatch(configPatch, metaPatch) {
  const parts = [];
  if (configPatch.name !== undefined) parts.push('이름 변경');
  if (configPatch.model !== undefined) parts.push('모델 변경');
  if (configPatch.systemPrompt !== undefined) parts.push('시스템 프롬프트 변경');
  if (configPatch.workingDir !== undefined) parts.push('작업 디렉토리 변경');
  if (configPatch.avatar !== undefined) parts.push('아바타 변경');
  if (configPatch.allowedTools !== undefined || configPatch.disallowedTools !== undefined) parts.push('도구 권한 변경');
  if (configPatch.planMode !== undefined) parts.push('플랜 모드 변경');
  if (configPatch.backendId !== undefined) parts.push('백엔드 변경');
  if (configPatch.thinkingEffort !== undefined) parts.push('추론 강도 변경');
  if (metaPatch.projectId !== undefined) parts.push('에이전트 이동');
  if (metaPatch.tier !== undefined) parts.push('티어 변경');
  if (metaPatch.parentId !== undefined) parts.push('부모 변경');
  if (metaPatch.order !== undefined) parts.push('순서 변경');
  if (metaPatch.favorite !== undefined) parts.push('즐겨찾기 변경');
  if (metaPatch.skillIds !== undefined) parts.push('스킬 변경');
  if (metaPatch.lightweightMode !== undefined) parts.push('경량 모드 변경');
  return parts.length > 0 ? parts.join(', ') : '에이전트 수정';
}

export function pushUndo({ agentId, configBefore, metaBefore, configPatch, metaPatch }) {
  const entry = {
    id: nanoid(8),
    timestamp: new Date().toISOString(),
    agentId,
    description: describeFromPatch(configPatch ?? {}, metaPatch ?? {}),
    configBefore,
    metaBefore
  };
  stack.push(entry);
  if (stack.length > MAX_STACK) stack.shift();
  return entry;
}

export function popUndo() {
  return stack.pop() ?? null;
}

export function peekUndo() {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

export function getStack() {
  return [...stack];
}
