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
import { resolveTierModel, tierModelsCollapsed } from './model-tiers.js';

export function createRunner({ processTracker, accountScheduler } = {}) {
  const active = new Map();
  // sessionId → epoch ms of the last streamed chunk/tool event. Lets callers
  // distinguish a session that is actually producing output from one that is
  // running but stalled.
  const lastActivity = new Map();

  function cleanup(sessionId) {
    active.delete(sessionId);
    lastActivity.delete(sessionId);
    if (processTracker) processTracker.release(sessionId);
  }

  function withActivity(sessionId, callbacks = {}) {
    const touch = () => lastActivity.set(sessionId, Date.now());
    return {
      ...callbacks,
      onText: (text) => { touch(); callbacks.onText?.(text); },
      onToolUse: (tool) => { touch(); callbacks.onToolUse?.(tool); },
    };
  }

  const api = {
    /**
     * @param {object} opts
     * @param {string} opts.sessionId
     * @param {object} opts.agent
     * @param {string} opts.message
     * @param {string} [opts.claudeSessionId]
     * @param {object} [opts.envOverrides]
     * @param {string} [opts.backendType]    - 'claude-cli' | 'openai-compatible' | 'anthropic-compatible'
     * @param {object} [opts.backendConfig]  - { backendName, fallbackId, fallback }
     * @param {object} [opts.callbacks]
     */
    start({ sessionId, agent, message, claudeSessionId, envOverrides = {}, backendType, backendConfig, callbacks = {} }) {
      if (active.has(sessionId)) {
        throw new Error(`Session ${sessionId} already running`);
      }

      // ── Discord bot 라우팅 로직 (bot.js line 2646) ──
      // openai-compatible → OpenAI SDK 직접 호출 (zai, deepseek, openai, openrouter)
      if (backendType === 'openai-compatible') {
        return api._startOpenAI({ sessionId, agent, message, claudeSessionId, backendConfig, callbacks });
      }

      // ── Claude CLI (claude-cli 또는 anthropic-compatible) ──
      const fallback = backendConfig?.fallback ?? null;
      // 레이트리밋/기동실패로 한 번만 폴백한다. 폴백 실행에는 fallback:null 을
      // 넘기므로 폴백이 또 폴백하는 연쇄는 구조적으로 불가능하다(1홉).
      let fallbackStarted = false;
      let sawResult = false;

      lastActivity.set(sessionId, Date.now());
      const handle = startClaudeRun({
        agent,
        message,
        claudeSessionId,
        envOverrides,
        accountScheduler,
        callbacks: {
          ...withActivity(sessionId, callbacks),
          onResult: (result) => {
            sawResult = true;
            callbacks.onResult?.(result);
          },
          onError: (err) => {
            if (fallback && !fallbackStarted && !sawResult) {
              fallbackStarted = true;
              api._startFallback({ sessionId, agent, message, claudeSessionId, fallback, callbacks, cause: err });
              return;
            }
            callbacks.onError?.(err);
          },
          onExit: (info) => {
            // 폴백이 세션을 이어받았으면 1차 실행의 종료는 삼킨다 — 여기서
            // onExit 를 흘리면 호출자가 턴을 끝내 버려 폴백 응답이 버려진다.
            if (fallbackStarted) return;
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
     * 폴백 백엔드로 1회 재시도. 폴백 백엔드의 타입대로 라우팅한다
     * (claude-cli / anthropic-compatible → Claude CLI, openai-compatible → OpenAI SDK).
     */
    _startFallback({ sessionId, agent, message, claudeSessionId, fallback, callbacks, cause }) {
      logger.warn(
        { sessionId, agent: agent.id, fallbackBackend: fallback.backendId, fallbackType: fallback.backendType, cause: cause?.message },
        'runner: primary backend failed — retrying on fallback backend'
      );
      cleanup(sessionId);

      // backendId 를 폴백으로 갈아끼워야 러너/계정 스케줄러가 폴백 백엔드의
      // configDir·managed OAuth 토큰·사용량 기록을 쓴다. accountId 는 스케줄러에서
      // backendId 보다 우선하므로 같이 지운다.
      const fbAgent = { ...agent, backendId: fallback.backendId, accountId: null };
      if (fallback.configDir) fbAgent.configDir = fallback.configDir;
      else delete fbAgent.configDir;

      // 모델 별칭은 resolveAgent 가 1차 백엔드의 models 맵으로 이미 실제 ID 로 확정했다.
      // 그대로 넘기면 폴백이 남의 백엔드 모델 ID 를 전선에 실어 "모르는 모델"로 거절당한다.
      // → 보존해 둔 원본 별칭을 되돌려 놓고, 폴백 백엔드의 models 맵으로 다시 해석한다.
      //   맵에 없으면 별칭 그대로 넘겨 러너의 MODEL_ID_MAP(opus/sonnet/haiku)이 풀게 한다.
      if (agent.modelAlias) {
        const fbStore = fallback.envOverrides?._backendsStore ?? null;
        const fbBackend = fbStore?.getBackend?.(fallback.backendId) ?? null;
        // 티어 이름이면 폴백 백엔드의 tierModels 로 먼저 푼다 (없으면 강등 → models.default).
        // 티어가 아니면 null 이 돌아와 기존 models 별칭 경로가 그대로 동작한다.
        const fbTiers = fbStore?.getRaw?.()?.tiers;
        const fbTier = resolveTierModel({
          backendObj: fbBackend, tier: agent.modelAlias, tiers: fbTiers
        });
        // 폴백 백엔드가 모든 티어에 같은 모델을 걸어 두면 급 구분이 통째로 사라진다.
        // 실패가 아니라 조용히 지나가므로, 위임이 지정한 티어가 왜 아무 차이를
        // 만들지 못했는지 나중에 로그로 추적할 수 있게 여기서 남긴다.
        if (fbTier) {
          const flat = tierModelsCollapsed({ backendObj: fbBackend, tiers: fbTiers });
          if (flat.collapsed) {
            logger.warn(
              { sessionId, backendId: fallback.backendId, tiers: flat.tiers, model: flat.modelId, requestedTier: agent.modelAlias },
              'runner: 폴백 백엔드의 티어가 모두 같은 모델 — 급 구분 없음(요청 티어가 무의미해짐)'
            );
          }
        }
        fbAgent.model = fbTier?.modelId ?? fbBackend?.models?.[agent.modelAlias] ?? agent.modelAlias;
        if (fbAgent.model !== agent.model) {
          logger.info(
            { sessionId, alias: agent.modelAlias, from: agent.model, to: fbAgent.model, backendId: fallback.backendId },
            'runner: re-resolved model alias for fallback backend'
          );
        }
      }

      try {
        return api.start({
          sessionId,
          agent: fbAgent,
          message,
          claudeSessionId,
          envOverrides: fallback.envOverrides ?? {},
          backendType: fallback.backendType,
          backendConfig: { backendName: fallback.backendId, fallbackId: null, fallback: null },
          callbacks
        });
      } catch (err) {
        logger.error({ sessionId, fallbackBackend: fallback.backendId, err: err.message },
          'runner: fallback start failed');
        cleanup(sessionId);
        callbacks.onError?.(cause ?? err);
        callbacks.onExit?.({ code: 1 });
        return null;
      }
    },

    /**
     * OpenAI SDK 경로 — zai_runner.js 복제
     * Z.AI coding/paas 엔드포인트 + 로컬 도구 실행 루프
     */
    _startOpenAI({ sessionId, agent, message, claudeSessionId, backendConfig, callbacks }) {
      const { onText, onToolUse, onResult, onError, onExit } = withActivity(sessionId, callbacks);

      let aborted = false;
      const handle = { abort() { aborted = true; } };
      active.set(sessionId, handle);
      lastActivity.set(sessionId, Date.now());

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
      if (agent.pinnedFilesContext) parts.push(agent.pinnedFilesContext);
      if (agent.choicesHint) parts.push(agent.choicesHint);
      if (agent.delegateHint) parts.push(agent.delegateHint);
      if (agent.reportHint) parts.push(agent.reportHint);
      if (agent.systemPrompt) parts.push(agent.systemPrompt);
      // dashboardHint 는 systemPrompt 뒤에 위치 → 에이전트 MD보다 높은 우선순위로 강제 적용
      if (agent.dashboardHint) parts.push(agent.dashboardHint);
      if (agent.calendarHint) parts.push(agent.calendarHint);
      const systemPrompt = parts.join('\n').trim() || 'You are a helpful assistant.';

      const backendName = backendConfig?.backendName || 'zai';
      const fallback = backendConfig?.fallback ?? null;
      const fallbackId = fallback?.backendId ?? null;

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

          // ── Fallback: 실패 시 폴백 백엔드로 1회 재시도 ──
          // 폴백 백엔드의 타입대로 라우팅한다. 예전엔 여기서 무조건 Claude CLI 를
          // 띄워서, 폴백을 openai-compatible 로 지정해도 클로드로 샜다.
          if (fallback) {
            api._startFallback({ sessionId, agent, message, claudeSessionId, fallback, callbacks, cause: err });
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
        lastActivity.delete(sessionId);
        if (processTracker) processTracker.release(sessionId);
        return true;
      }
      return false;
    },

    isRunning: (sessionId) => active.has(sessionId),
    activeIds: () => [...active.keys()],
    lastActivityAt: (sessionId) => lastActivity.get(sessionId) ?? null
  };

  return api;
}
