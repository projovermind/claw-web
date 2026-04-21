/**
 * Claude CLI Runner — 디스코드 봇의 _runClaudeOnce()와 동일한 방식
 * 봇 소스: /Volumes/Core/claude-discord-bot/bot.js 라인 2320-2440
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { isRateLimitText, parseRateLimitExpiry } from '../lib/account-scheduler.js';

// Claude CLI 경로 (봇과 동일한 탐지 로직)
function findClaudeBin() {
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}
const CLAUDE_BIN = findClaudeBin();

// Claude CLI 세션 파일 위치 — <configDir>/projects/-cwd-encoded/SESSION_ID.jsonl
// resume 대상 세션이 존재하는지 pre-check 해 crash/idle timeout 을 막는다.
// 멀티계정(claude-claw) 대응:
//   - configDir 이 명시되면 해당 경로의 projects/ 만 탐색 (정확).
//   - configDir 미지정 시 기본 ~/.claude/ + ~/.claude-claw/*/ 모두 스캔 (pre-check 용 하위 호환).
export function findClaudeSessionFile(workingDir, sessionId, configDir = null) {
  if (!sessionId) return null;

  const roots = [];
  if (configDir) {
    roots.push(path.join(configDir, 'projects'));
  } else {
    roots.push(path.join(process.env.HOME || '', '.claude', 'projects'));
    const clawBase = path.join(process.env.HOME || '', '.claude-claw');
    if (fs.existsSync(clawBase)) {
      try {
        for (const accountDir of fs.readdirSync(clawBase)) {
          const projectsDir = path.join(clawBase, accountDir, 'projects');
          if (fs.existsSync(projectsDir)) roots.push(projectsDir);
        }
      } catch { /* ignore */ }
    }
  }

  for (const projectsRoot of roots) {
    if (!fs.existsSync(projectsRoot)) continue;

    // 1) cwd 기반 정확 경로 (/ → - 치환)
    if (workingDir) {
      const encoded = workingDir.replace(/\//g, '-');
      const dirName = (encoded.startsWith('-') ? encoded : '-' + encoded).replace(/-+$/, '');
      const exact = path.join(projectsRoot, dirName, `${sessionId}.jsonl`);
      if (fs.existsSync(exact)) return exact;
    }

    // 2) fallback: 모든 projects/ 하위에서 ID 매치
    try {
      for (const projDir of fs.readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, projDir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* ignore */ }
  }

  return null;
}

// 봇과 동일한 MODEL_ID_MAP
const MODEL_ID_MAP = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-sonnet-4-6', // haiku banned → sonnet fallback
  // GLM 계열 — 그대로 통과
  'glm-5.1': 'glm-5.1',
  'glm-4-5': 'glm-4-5',
  'glm-4': 'glm-4',
};

export function startClaudeRun({
  agent,
  message,
  claudeSessionId,
  envOverrides = {},
  callbacks = {},
  spawn = nodeSpawn,
  accountScheduler = null,
}) {
  const { onText, onToolUse, onResult, onError, onExit, onRateLimit } = callbacks;

  // ── 환경변수 설정 (봇 bot.js 라인 2325-2349 동일) ──
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;

  // PATH 보강 (launchctl에서 제한적)
  const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
  if (cleanEnv.PATH && !cleanEnv.PATH.includes('/usr/local/bin')) {
    cleanEnv.PATH = extraPaths.join(':') + ':' + cleanEnv.PATH;
  }

  // 백엔드 env 주입 (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN 등)
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v !== undefined && v !== null) cleanEnv[k] = String(v);
  }

  // 멀티 계정: 스케줄러 우선 → 없으면 agent.configDir 직접 지정 fallback
  let pickedAccountId = null;
  if (accountScheduler) {
    const pickedAcc = accountScheduler.pickAccount(agent);
    if (pickedAcc) {
      pickedAccountId = pickedAcc.id;
      if (pickedAcc.configDir) {
        // configDir이 실제 경로일 때만 설정
        cleanEnv.CLAUDE_CONFIG_DIR = pickedAcc.configDir;
      } else {
        // null이면 기본 ~/.claude/ 사용 — 이전 값 완전히 제거
        delete cleanEnv.CLAUDE_CONFIG_DIR;
      }
    }
  } else if (agent.configDir) {
    cleanEnv.CLAUDE_CONFIG_DIR = agent.configDir;
  } else {
    // configDir 미지정 시 혹시 남아있을 수 있는 값 제거
    delete cleanEnv.CLAUDE_CONFIG_DIR;
  }

  // 백엔드 스케줄러: backendsStore 기반 pickBackend 지원
  let pickedBackendId = agent.backendId ?? agent.accountId ?? null;

  // ── 모델 결정 (봇 bot.js 라인 2391-2410 동일) ──
  // 항상 MODEL_ID_MAP으로 변환 — Z.AI anthropic 프록시도 claude-sonnet-4-6을 받음
  const rawModel = (agent.model ?? 'opus').toLowerCase();
  // glm- 으로 시작하는 모델은 원본 그대로 통과 (맵 등록 유무 무관)
  const model = MODEL_ID_MAP[rawModel] ?? (rawModel.startsWith('glm-') ? agent.model : null) ?? agent.model ?? 'claude-opus-4-6';

  // ⚠️ 핵심: --model 플래그만으로는 -p 모드에서 무시될 수 있음
  // ANTHROPIC_MODEL 환경변수로도 동시에 세팅 (봇 bot.js 라인 2408-2410)
  cleanEnv.ANTHROPIC_MODEL = model;

  // ── CLI 인자 구성 (봇 bot.js 라인 2353-2412 동일) ──
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];

  if (agent.planMode) args.push('--permission-mode', 'plan');
  // Z.AI 등 외부 프록시는 effort/thinking 미지원 → ANTHROPIC_BASE_URL 있으면 스킵
  if (agent.thinkingEffort && agent.thinkingEffort !== 'auto' && !cleanEnv.ANTHROPIC_BASE_URL) {
    // Claude.ai 구독자(Max 플랜)는 "max" 값을 거부. 'high' 로 자동 강등.
    const effort = agent.thinkingEffort === 'max' ? 'high' : agent.thinkingEffort;
    args.push('--effort', effort);
  }
  // ── Resume pre-check ──
  // Claude CLI 는 --resume 에 존재하지 않는 세션을 넘기면 버전에 따라
  //   (a) stderr 에러 + exit, (b) 새 세션으로 silent fallback, (c) 무한 대기
  // 어느 경우든 이어가기 UX가 깨지므로 파일 존재 여부를 먼저 확인.
  let effectiveResumeId = claudeSessionId || null;
  let resumeSessionFile = null;
  if (effectiveResumeId) {
    resumeSessionFile = findClaudeSessionFile(agent.workingDir, effectiveResumeId, cleanEnv.CLAUDE_CONFIG_DIR || null);
    if (!resumeSessionFile) {
      logger.warn(
        { agent: agent.id, sessionId: effectiveResumeId, cwd: agent.workingDir },
        'runner: claude session file not found — resume disabled, starting fresh (context lost)'
      );
      effectiveResumeId = null;
    }
  }
  if (effectiveResumeId) args.push('--resume', effectiveResumeId);
  if (agent.allowedTools?.length) args.push('--allowedTools', ...agent.allowedTools);

  // 전역 자동 차단:
  // - AskUserQuestion: Claude 의 대화형 질문 툴. -p 비대화형 모드에서는 응답 방법이
  //   없어 자동 '취소'됨 → 에이전트가 "질문이 취소됐으니 알아서 진행" 로 애매하게 종료.
  //   사용자 선택지는 <choices> 태그 (choicesHint) 로 처리.
  // - ExitPlanMode: plan 모드 진입/종료 승인 툴. -p 모드에 부적합.
  const AUTO_BLOCK = ['AskUserQuestion', 'ExitPlanMode'];
  const mergedDisallowed = [
    ...new Set([...(agent.disallowedTools || []), ...AUTO_BLOCK])
  ];
  if (mergedDisallowed.length) args.push('--disallowedTools', ...mergedDisallowed);

  args.push('--model', model);

  // 스킬을 시스템 프롬프트로 주입
  // skill-injector 가 trigger 미매치 스킬은 content='' 로 비워 둠.
  // -p 모드에서는 모델이 skill content 를 별도로 fetch 할 수단이 없으므로
  // content 가 비면 헤더만 찍어도 순수 토큰 낭비 → 본문 있는 스킬만 주입.
  const parts = [];
  if (Array.isArray(agent.skills) && agent.skills.length > 0) {
    const liveSkills = agent.skills.filter(sk => sk?.content && sk.content.trim());
    if (liveSkills.length > 0) {
      parts.push('[첨부된 스킬]');
      for (const sk of liveSkills) {
        parts.push(`\n## ${sk.name}${sk.description ? ` — ${sk.description}` : ''}\n\n${sk.content}`);
      }
      parts.push('\n---\n');
    }
  }
  // 프레임워크 자동 주입 순서: BASE → CARL → PAUL → ProjectMemory → Dashboard
  if (agent.baseContext) parts.push(agent.baseContext);
  if (agent.carlContext) parts.push(agent.carlContext);
  if (agent.paulContext) parts.push(agent.paulContext);
  if (agent.projectMemory) parts.push(`\n<project-memory>\n${agent.projectMemory}\n</project-memory>`);
  if (agent.pinnedFilesContext) parts.push(agent.pinnedFilesContext);
  if (agent.dashboardHint) parts.push(agent.dashboardHint);
  if (agent.choicesHint) parts.push(agent.choicesHint);
  if (agent.delegateHint) parts.push(agent.delegateHint);
  if (!agent.lightweightMode && agent.systemPrompt) {
    parts.push(agent.systemPrompt);
  }
  const composedPrompt = parts.join('\n').trim();
  if (composedPrompt) {
    args.push('--append-system-prompt', composedPrompt);
  }
  args.push(message);

  // ── CWD (워킹 디렉토리) ──
  let cwd = agent.workingDir || process.cwd();
  try {
    if (agent.workingDir) {
      const stat = fs.statSync(agent.workingDir);
      if (!stat.isDirectory()) cwd = process.cwd();
    }
  } catch {
    logger.warn({ agent: agent.id, workingDir: agent.workingDir }, 'runner: workingDir not found, fallback');
    cwd = process.cwd();
  }

  logger.info(
    {
      agent: agent.id,
      model,
      cwd,
      resume: !!effectiveResumeId,
      resumeRequested: !!claudeSessionId,
      resumeFile: resumeSessionFile ? path.basename(resumeSessionFile) : null
    },
    'runner: spawn claude'
  );

  // ── 프로세스 실행 (봇 bot.js 라인 2420 동일) ──
  const proc = spawn(CLAUDE_BIN, args, {
    env: cleanEnv,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // spawn 직후 사용 기록
  if (accountScheduler && pickedAccountId) {
    accountScheduler.markUsed(pickedAccountId).catch(() => {});
  }
  if (envOverrides?._backendsStore && pickedBackendId) {
    envOverrides._backendsStore.markUsed(pickedBackendId).catch(() => {});
  }

  // MOCK_RATE_LIMIT=1: 테스트용 강제 rate-limit 트리거 (0.5초 후)
  if (process.env.MOCK_RATE_LIMIT === '1') {
    setTimeout(() => {
      handleRateLimit('rate limit exceeded, try again in 5 hours');
    }, 500);
  }

  let buffer = '';
  const assistantTexts = [];
  let resultText = null;
  let resultSessionId = null;
  let resultModel = null;
  let resultUsage = null;
  let gotAnyOutput = false;
  let rateLimitDetected = false;
  let rateLimitRestartDone = false;

  function handleRateLimit(text) {
    if (rateLimitDetected) return;
    if (!isRateLimitText(text)) return;
    rateLimitDetected = true;
    const expiresAt = new Date(parseRateLimitExpiry(text)).toISOString();

    // backendsStore 기반 쿨다운 (우선)
    if (envOverrides?._backendsStore && pickedBackendId) {
      envOverrides._backendsStore.setCooldown(pickedBackendId, expiresAt).catch(() => {});
    } else if (accountScheduler && pickedAccountId) {
      accountScheduler.setCooldown(pickedAccountId, expiresAt).catch(() => {});
    }

    // Find next account synchronously (before async cooldown persists)
    const nextAcc = accountScheduler?.pickNextAccount?.(pickedAccountId);
    const nextAccountId = nextAcc?.id ?? null;
    logger.warn(
      { accountId: pickedAccountId, backendId: pickedBackendId, expiresAt, nextAccountId },
      `[scheduler] rate-limited → next: ${nextAccountId ?? 'none'}`
    );
    onRateLimit?.({ accountId: pickedAccountId, backendId: pickedBackendId, nextAccountId });

    // Kill process so caller can restart with new account (max 1 restart enforced by caller)
    if (!rateLimitRestartDone) {
      rateLimitRestartDone = true;
      setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, 200);
    }
  }

  // ── 타임아웃 전략 (상태별 차등) ──
  // 1) 초기 출력 없음 (5분): resume 깨짐/크래시 감지
  // 2) tool_use 진행 중 stall (30분): Bash 도구가 npm build/pkg 빌드 등 장시간 실행 중
  // 3) 일반 stall (10분): Claude 모델이 응답 생성 중 멈춤
  const INITIAL_IDLE_MS = 300_000;       // 5분
  const TOOL_RUNNING_STALL_MS = 1_800_000; // 30분 (도구 실행 중)
  const IDLE_STALL_MS = 1_200_000;         // 20분 (일반 응답 대기) — 이미지 분석/큰 컨텍스트 thinking 보호
  const POST_TOOL_THINKING_MS = 60_000;    // 60초: tool_result 직후 모델 thinking 보호 구간

  let pendingToolUse = false;  // 마지막으로 본 이벤트가 tool_use인데 아직 결과 못 받음
  let postToolThinkingTimer = null; // tool_result 직후 pendingToolUse 를 잠시 더 유지시키는 타이머
  let silentFallbackDetected = false; // system.init 에서 --resume 드롭 감지 → 즉시 abort
  let idleTimer = setTimeout(() => {
    if (!gotAnyOutput) {
      logger.warn({ agent: agent.id, cwd }, 'runner: claude CLI idle timeout (no output) — killing');
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    }
  }, INITIAL_IDLE_MS);

  function scheduleStallTimer() {
    clearTimeout(idleTimer);
    const timeoutMs = pendingToolUse ? TOOL_RUNNING_STALL_MS : IDLE_STALL_MS;
    const reason = pendingToolUse ? 'stalled while tool running' : 'stalled (no tool)';
    idleTimer = setTimeout(() => {
      logger.warn({ agent: agent.id, reason, timeoutMs }, 'runner: claude CLI killed — ' + reason);
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    }, timeoutMs);
  }

  function resetIdleTimer() {
    gotAnyOutput = true;
    scheduleStallTimer();
  }

  function handleEvent(event) {
    // ── Silent-fallback 조기 감지 ──
    // Claude CLI 는 세션 시작 직후 system.init 이벤트로 실제 사용된 session_id 를 흘려보냄.
    // 요청한 resume ID 와 다르면 --resume 이 조용히 드롭된 것. 이대로 진행하면
    // 시스템 프롬프트도 없고 이전 대화도 없는 쌩 모델이 유저 메시지에 엉뚱한 답을 함.
    // → 토큰 소비 전에 즉시 abort 해서 message-sender onError 로 fresh-start 재시도 트리거.
    if (event.type === 'system' && event.subtype === 'init') {
      const actualId = event.session_id;
      if (effectiveResumeId && actualId && actualId !== effectiveResumeId) {
        silentFallbackDetected = true;
        logger.warn(
          { agent: agent.id, requested: effectiveResumeId, actual: actualId },
          'runner: --resume dropped at init (silent fallback) — aborting for fresh-start retry'
        );
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
        return;
      }
    }
    if (event.type === 'tool_use') {
      pendingToolUse = true;
      onToolUse?.({ name: event.name || event.tool_name || 'unknown', input: event.input || {} });
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      pendingToolUse = true;
      onToolUse?.({ name: event.content_block.name, input: event.content_block.input || {} });
    } else if (event.type === 'user') {
      // tool_result 가 담겨서 오는 이벤트 — 도구 실행 완료.
      // 단, 직후 60초간은 모델이 다음 행동(특히 이미지/대용량 분석 thinking)을 결정하는
      // 구간이라 stdout이 잠시 비는데, 이때 IDLE_STALL_MS 가 발동하면 부당하게 kill 됨.
      // → POST_TOOL_THINKING_MS 동안은 pendingToolUse=true 로 유지해 TOOL_RUNNING_STALL 적용.
      pendingToolUse = true;
      if (postToolThinkingTimer) clearTimeout(postToolThinkingTimer);
      postToolThinkingTimer = setTimeout(() => {
        pendingToolUse = false;
        postToolThinkingTimer = null;
        scheduleStallTimer();
      }, POST_TOOL_THINKING_MS);
    } else if (event.type === 'assistant') {
      if (!resultModel) resultModel = event.message?.model || event.model || null;
      const content = event.message?.content || event.content || [];
      let sawToolUse = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            sawToolUse = true;
            onToolUse?.({ name: block.name, input: block.input || {} });
          } else if (block.type === 'text' && block.text) {
            assistantTexts.push(block.text);
            onText?.(block.text);
          }
        }
      }
      // assistant 메시지에 tool_use 블록이 있으면 도구 실행 시작 상태로 전환
      if (sawToolUse) pendingToolUse = true;
      if (event.message?.text) { assistantTexts.push(event.message.text); onText?.(event.message.text); }
      if (typeof event.text === 'string' && event.text) { assistantTexts.push(event.text); onText?.(event.text); }
    } else if (event.type === 'result') {
      pendingToolUse = false;
      resultText = event.result ?? null;
      // 실제 rate-limit 오류만 감지 — is_error: true 인 result 이벤트에서만 체크
      if (event.is_error && resultText) handleRateLimit(resultText);
      resultSessionId = event.session_id || null;
      if (!resultModel) resultModel = event.model || null;
      if (event.usage) {
        resultUsage = {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
          totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0)
        };
      }
    }
  }

  proc.stdout.on('data', (d) => {
    gotAnyOutput = true;
    const chunk = d.toString();
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
    // 이벤트 파싱 후 pendingToolUse 상태 반영하여 타이머 재설정
    scheduleStallTimer();
  });

  const stderrChunks = [];
  proc.stderr.on('data', (d) => {
    const chunk = d.toString();
    stderrChunks.push(chunk);
    handleRateLimit(chunk);
    // stderr activity (debug logs, warnings) 도 활동 신호로 간주 → idle timeout 리셋
    resetIdleTimer();
  });

  proc.on('close', (code) => {
    clearTimeout(idleTimer);
    // init 단계에서 silent-fallback 을 감지해 abort 한 경우: 응답 없음 → fresh-start 재시도 에러로 즉시 종료.
    if (silentFallbackDetected) {
      onError?.(new Error('silent_fallback: --resume dropped by CLI, fresh-start retry required'));
      onExit?.({ code });
      return;
    }
    // 그 외 close 시점 검증 (init 을 못 받고 끝난 경우 등의 방어): 요청 ID 와 실제 ID 가 다르면 로그만 남김.
    if (effectiveResumeId && resultSessionId && resultSessionId !== effectiveResumeId) {
      logger.warn(
        { agent: agent.id, requested: effectiveResumeId, actual: resultSessionId },
        'runner: claude CLI dropped --resume target — created NEW session (context lost)'
      );
    }
    const final = resultText || (assistantTexts.length ? assistantTexts.join('\n\n') : null);
    if (code === 0 || final) {
      onResult?.({ text: final, claudeSessionId: resultSessionId, model: resultModel, usage: resultUsage, exitCode: code });
    } else if (code === 143 || code === 137) {
      // SIGTERM(143) / SIGKILL(137) = 유저가 중단하거나 타임아웃 kill
      // 에러가 아닌 정상 중단으로 처리
      onResult?.({ text: final ?? '(응답이 중단되었습니다)', claudeSessionId: resultSessionId, model: resultModel, usage: resultUsage, exitCode: code });
    } else {
      const rawStderr = stderrChunks.join('').trim();
      // stderr 가 비었는데 exit != 0 인 경우: Claude CLI 가 조용히 죽은 상황 (주로
      // --resume 세션 파일 손상/버전 불일치). 에러 메시지에 resume 상태를 포함해서
      // classifyError 가 'cli_exit' 로 재시도 가능하도록 판단할 수 있게 함.
      const errMsg = rawStderr
        ? rawStderr.slice(0, 400)
        : `claude CLI exited ${code} (no stderr${effectiveResumeId ? ', resume=true' : ''})`;
      onError?.(new Error(errMsg));
    }
    onExit?.({ code });
  });

  proc.on('error', (err) => onError?.(err));

  return {
    process: proc,
    abort() {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  };
}
