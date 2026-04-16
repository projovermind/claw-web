/**
 * Claude CLI Runner — 디스코드 봇의 _runClaudeOnce()와 동일한 방식
 * 봇 소스: /Volumes/Core/claude-discord-bot/bot.js 라인 2320-2440
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { logger } from '../lib/logger.js';

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

// 봇과 동일한 MODEL_ID_MAP
const MODEL_ID_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-sonnet-4-6' // haiku banned → sonnet fallback
};

export function startClaudeRun({
  agent,
  message,
  claudeSessionId,
  envOverrides = {},
  callbacks = {},
  spawn = nodeSpawn
}) {
  const { onText, onToolUse, onResult, onError, onExit } = callbacks;

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

  // ── 모델 결정 (봇 bot.js 라인 2391-2410 동일) ──
  // 항상 MODEL_ID_MAP으로 변환 — Z.AI anthropic 프록시도 claude-sonnet-4-6을 받음
  const rawModel = (agent.model ?? 'opus').toLowerCase();
  const model = MODEL_ID_MAP[rawModel] ?? agent.model ?? 'claude-opus-4-6';

  // ⚠️ 핵심: --model 플래그만으로는 -p 모드에서 무시될 수 있음
  // ANTHROPIC_MODEL 환경변수로도 동시에 세팅 (봇 bot.js 라인 2408-2410)
  cleanEnv.ANTHROPIC_MODEL = model;

  // ── CLI 인자 구성 (봇 bot.js 라인 2353-2412 동일) ──
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];

  if (agent.planMode) args.push('--permission-mode', 'plan');
  // Z.AI 등 외부 프록시는 effort/thinking 미지원 → ANTHROPIC_BASE_URL 있으면 스킵
  if (agent.thinkingEffort && agent.thinkingEffort !== 'auto' && !cleanEnv.ANTHROPIC_BASE_URL) {
    args.push('--effort', agent.thinkingEffort);
  }
  if (claudeSessionId) args.push('--resume', claudeSessionId);
  if (agent.allowedTools?.length) args.push('--allowedTools', ...agent.allowedTools);
  if (agent.disallowedTools?.length) args.push('--disallowedTools', ...agent.disallowedTools);

  args.push('--model', model);

  // 스킬을 시스템 프롬프트로 주입
  const parts = [];
  if (Array.isArray(agent.skills) && agent.skills.length > 0) {
    parts.push('[첨부된 스킬]');
    for (const sk of agent.skills) {
      parts.push(`\n## ${sk.name}${sk.description ? ` — ${sk.description}` : ''}\n\n${sk.content}`);
    }
    parts.push('\n---\n');
  }
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
    { agent: agent.id, model, cwd, resume: !!claudeSessionId },
    'runner: spawn claude'
  );

  // ── 프로세스 실행 (봇 bot.js 라인 2420 동일) ──
  const proc = spawn(CLAUDE_BIN, args, {
    env: cleanEnv,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let buffer = '';
  const assistantTexts = [];
  let resultText = null;
  let resultSessionId = null;
  let resultModel = null;
  let resultUsage = null;
  let gotAnyOutput = false;

  // ── 타임아웃: 120초 동안 아무 출력 없으면 kill ──
  // Claude CLI가 --resume로 깨진 세션 로드하면 무한 대기하는 문제 방지
  const IDLE_TIMEOUT_MS = 120_000;
  let idleTimer = setTimeout(() => {
    if (!gotAnyOutput) {
      logger.warn({ agent: agent.id, cwd }, 'runner: claude CLI idle timeout — killing');
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      // 잠시 후 SIGKILL
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    }
  }, IDLE_TIMEOUT_MS);

  function resetIdleTimer() {
    gotAnyOutput = true;
    clearTimeout(idleTimer);
    // 출력이 있으면 5분으로 연장 (도구 실행 중일 수 있음)
    idleTimer = setTimeout(() => {
      logger.warn({ agent: agent.id }, 'runner: claude CLI stalled after output — killing');
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    }, 300_000);
  }

  function handleEvent(event) {
    if (event.type === 'tool_use') {
      onToolUse?.({ name: event.name || event.tool_name || 'unknown', input: event.input || {} });
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      onToolUse?.({ name: event.content_block.name, input: event.content_block.input || {} });
    } else if (event.type === 'assistant') {
      if (!resultModel) resultModel = event.message?.model || event.model || null;
      const content = event.message?.content || event.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            onToolUse?.({ name: block.name, input: block.input || {} });
          } else if (block.type === 'text' && block.text) {
            assistantTexts.push(block.text);
            onText?.(block.text);
          }
        }
      }
      if (event.message?.text) { assistantTexts.push(event.message.text); onText?.(event.message.text); }
      if (typeof event.text === 'string' && event.text) { assistantTexts.push(event.text); onText?.(event.text); }
    } else if (event.type === 'result') {
      resultText = event.result ?? null;
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
    resetIdleTimer();
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
  });

  const stderrChunks = [];
  proc.stderr.on('data', (d) => stderrChunks.push(d.toString()));

  proc.on('close', (code) => {
    clearTimeout(idleTimer);
    const final = resultText || (assistantTexts.length ? assistantTexts.join('\n\n') : null);
    if (code === 0 || final) {
      onResult?.({ text: final, claudeSessionId: resultSessionId, model: resultModel, usage: resultUsage, exitCode: code });
    } else if (code === 143 || code === 137) {
      // SIGTERM(143) / SIGKILL(137) = 유저가 중단하거나 타임아웃 kill
      // 에러가 아닌 정상 중단으로 처리
      onResult?.({ text: final ?? '(응답이 중단되었습니다)', claudeSessionId: resultSessionId, model: resultModel, usage: resultUsage, exitCode: code });
    } else {
      const errMsg = stderrChunks.join('').trim().slice(0, 400) || `exit ${code}`;
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
