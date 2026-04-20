/**
 * Dual-mode Runner — Discord bot 구조 복제
 *
 * bot.js line 2646: if (agent.backend && agent.backend !== 'claude') → runZAI()
 *                   else → _runClaudeOnce()
 *
 * 동일하게:
 *   backendType === 'claude-cli'         → startClaudeRun (Claude CLI spawn)
 *   backendType === 'openai-compatible'  → runAgent (OpenAI SDK 직접 호출)
 *   backendType === 'anthropic-compatible' → startClaudeRun + env 오버라이드
 */
import { startClaudeRun } from '../runners/claude-cli-runner.js';
import { runAgent as runOpenAIAgent } from '../runners/openai-runner.js';
import { logger } from './logger.js';

export function createRunner({ processTracker, accountScheduler } = {}) {
  const active = new Map();

  function cleanup(sessionId) {
    active.delete(sessionId);
    if (processTracker) processTracker.release(sessionId);
  }

  return {
    /**
     * @param {object} opts
     * @param {string} opts.sessionId
     * @param {object} opts.agent
     * @param {string} opts.message
     * @param {string} [opts.claudeSessionId]
     * @param {object} [opts.envOverrides]
     * @param {string} [opts.backendType]    - 'claude-cli' | 'openai-compatible' | 'anthropic-compatible'
     * @param {object} [opts.backendConfig]  - { backendName: 'zai' | 'deepseek' | ... }
     * @param {object} [opts.callbacks]
     */
    start({ sessionId, agent, message, claudeSessionId, envOverrides = {}, backendType, backendConfig, callbacks = {} }) {
      if (active.has(sessionId)) {
        throw new Error(`Session ${sessionId} already running`);
      }

      // ── Discord bot 라우팅 로직 (bot.js line 2646) ──
      // openai-compatible → OpenAI SDK 직접 호출 (zai, deepseek, openai, openrouter)
      if (backendType === 'openai-compatible') {
        return this._startOpenAI({ sessionId, agent, message, claudeSessionId, envOverrides, backendConfig, callbacks });
      }

      // ── Claude CLI (claude-cli 또는 anthropic-compatible) ──
      const handle = startClaudeRun({
        agent,
        message,
        claudeSessionId,
        envOverrides,
        accountScheduler,
        callbacks: {
          ...callbacks,
          onExit: (info) => {
            cleanup(sessionId);
            callbacks.onExit?.(info);
          }
        }
      });
      active.set(sessionId, handle);
      if (processTracker && handle.process?.pid) {
        processTracker.track(sessionId, handle.process.pid);
      }
      return handle;
    },

    /**
     * OpenAI SDK 경로 — zai_runner.js 복제
     * Z.AI coding/paas 엔드포인트 + 로컬 도구 실행 루프
     */
    _startOpenAI({ sessionId, agent, message, claudeSessionId, envOverrides, backendConfig, callbacks }) {
      const { onText, onToolUse, onResult, onError, onExit } = callbacks;

      let aborted = false;
      const handle = { abort() { aborted = true; } };
      active.set(sessionId, handle);

      // 시스템 프롬프트 조합 (claude-cli-runner와 동일한 로직)
      const parts = [];
      if (Array.isArray(agent.skills) && agent.skills.length > 0) {
        parts.push('[첨부된 스킬]');
        for (const sk of agent.skills) {
          parts.push(`\n## ${sk.name}${sk.description ? ` — ${sk.description}` : ''}\n\n${sk.content}`);
        }
        parts.push('\n---\n');
      }
      // 프레임워크 자동 주입: BASE → CARL → PAUL → ProjectMemory → 에이전트 MD → Dashboard(마지막 고정)
      if (agent.baseContext) parts.push(agent.baseContext);
      if (agent.carlContext) parts.push(agent.carlContext);
      if (agent.paulContext) parts.push(agent.paulContext);
      if (agent.projectMemory) parts.push(`\n<project-memory>\n${agent.projectMemory}\n</project-memory>`);
      if (agent.choicesHint) parts.push(agent.choicesHint);
      if (agent.delegateHint) parts.push(agent.delegateHint);
      if (agent.systemPrompt) parts.push(agent.systemPrompt);
      // dashboardHint 는 systemPrompt 뒤에 위치 → 에이전트 MD보다 높은 우선순위로 강제 적용
      if (agent.dashboardHint) parts.push(agent.dashboardHint);
      const systemPrompt = parts.join('\n').trim() || 'You are a helpful assistant.';

      const backendName = backendConfig?.backendName || 'zai';
      const fallbackId = backendConfig?.fallbackId || null;

      logger.info(
        { agent: agent.id, backend: backendName, model: agent.model, fallback: fallbackId },
        'runner: openai-runner start'
      );

      // runAgent()는 비동기 — fire-and-forget, 결과는 콜백으로
      runOpenAIAgent({
        message,
        systemPrompt,
        agent,
        backend: backendName,
        workingDir: agent.workingDir,
        onToolCall: (name, args) => {
          if (!aborted) onToolUse?.({ name, input: args });
        },
        onChunk: (text) => {
          if (!aborted) onText?.(text);
        },
      })
        .then((result) => {
          if (aborted) return;
          logger.info(
            { agent: agent.id, textLen: result.text?.length, toolCalls: result.toolCalls?.length },
            'runner: openai-runner done'
          );
          onResult?.({
            text: result.text,
            claudeSessionId: null,
            model: backendName,
            usage: result.usage
              ? {
                  inputTokens: result.usage.prompt_tokens ?? 0,
                  outputTokens: result.usage.completion_tokens ?? 0,
                  cacheReadTokens: 0,
                  totalTokens:
                    (result.usage.prompt_tokens ?? 0) +
                    (result.usage.completion_tokens ?? 0),
                }
              : null,
            exitCode: 0,
          });
        })
        .catch((err) => {
          if (aborted) return;
          logger.warn({ err: err.message, agent: agent.id, backend: backendName, fallback: fallbackId }, 'runner: openai-runner failed');

          // ── Fallback: 실패 시 다른 백엔드로 재시도 ──
          if (fallbackId) {
            logger.info({ agent: agent.id, fallback: fallbackId }, 'runner: falling back to Claude CLI');
            cleanup(sessionId);

            // Claude CLI로 fallback (envOverrides로 전달)
            const fbHandle = startClaudeRun({
              agent,
              message,
              claudeSessionId,
              envOverrides: envOverrides || {},
              callbacks: {
                ...callbacks,
                onExit: (info) => {
                  cleanup(sessionId);
                  callbacks.onExit?.(info);
                }
              }
            });
            active.set(sessionId, fbHandle);
            if (processTracker && fbHandle.process?.pid) {
              processTracker.track(sessionId, fbHandle.process.pid);
            }
            return;
          }

          onError?.(err);
        })
        .finally(() => {
          // fallback이 실행 중이면 cleanup하지 않음
          if (active.get(sessionId) === handle) {
            cleanup(sessionId);
            if (!aborted) onExit?.({ code: 0 });
          }
        });

      return handle;
    },

    abort(sessionId) {
      const h = active.get(sessionId);
      if (h) {
        h.abort();
        active.delete(sessionId);
        if (processTracker) processTracker.release(sessionId);
        return true;
      }
      return false;
    },

    isRunning: (sessionId) => active.has(sessionId),
    activeIds: () => [...active.keys()]
  };
}
