import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../lib/logger.js';
import { buildCarlContext } from '../lib/carl-injector.js';
import { buildBaseContext } from '../lib/base-reader.js';
import { buildPaulContext } from '../lib/paul-reader.js';

const sendSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(50000),
  attachmentPaths: z.array(z.string().max(1000)).max(20).optional()
}).strict();

export function createChatRouter({
  sessionsStore,
  configStore,
  metadataStore,
  skillsStore,
  systemSkillsStore,
  projectsStore,
  backendsStore,
  runner,
  eventBus,
  delegationTracker
}) {
  const router = Router();

  // ── Shared helpers ─────────────────────────────────────

  function resolveSkills(ids) {
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
   * Resolve the active backend for an agent and return:
   *   { backendId, backendType, backendObj }
   */
  function resolveBackend(agent) {
    if (!backendsStore) return { backendId: 'claude', backendType: 'claude-cli', backendObj: null };
    const raw = backendsStore.getRaw();
    const agentBackendId = agent?.backendId;
    const globalActiveId = raw?.austerityMode ? raw.austerityBackend : raw?.activeBackend;
    const backendId = agentBackendId || globalActiveId || 'claude';
    const backendObj = raw?.backends?.[backendId] ?? null;
    const backendType = backendObj?.type || 'claude-cli';
    return { backendId, backendType, backendObj };
  }

  /**
   * Build env overrides for Claude CLI — only needed for anthropic-compatible.
   * openai-compatible backends use their own SDK client (no env needed).
   */
  function buildBackendEnv(agent) {
    const { backendType, backendObj } = resolveBackend(agent);
    // Only anthropic-compatible needs env overrides for Claude CLI proxy
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

  /** Resolve an agent with all inheritance (skills, tools, backend). */
  function resolveAgent(agentId) {
    const agentConfig = configStore.getAgent(agentId);
    if (!agentConfig) return null;
    const meta = metadataStore?.getAgent(agentId) ?? {};
    const agent = { id: agentId, ...agentConfig, ...meta };
    const project = meta.projectId && projectsStore
      ? projectsStore.getById(meta.projectId)
      : null;
    // Skill inheritance
    const pSkills = Array.isArray(project?.defaultSkillIds) ? project.defaultSkillIds : [];
    const aSkills = Array.isArray(meta.skillIds) ? meta.skillIds : [];
    const mergedSkills = [...new Set([...pSkills, ...aSkills])];
    if (mergedSkills.length > 0) agent.skills = resolveSkills(mergedSkills);
    // Tool inheritance
    const pAllow = Array.isArray(project?.defaultAllowedTools) ? project.defaultAllowedTools : [];
    const pDeny = Array.isArray(project?.defaultDisallowedTools) ? project.defaultDisallowedTools : [];
    const aAllow = Array.isArray(agentConfig.allowedTools) ? agentConfig.allowedTools : [];
    const aDeny = Array.isArray(agentConfig.disallowedTools) ? agentConfig.disallowedTools : [];
    const allow = [...new Set([...pAllow, ...aAllow])];
    const deny = [...new Set([...pDeny, ...aDeny])];
    if (allow.length) agent.allowedTools = allow;
    if (deny.length) agent.disallowedTools = deny;
    const envOverrides = buildBackendEnv(agent);
    // Backend routing info for runner (Discord bot dual-mode approach)
    const { backendId, backendType, backendObj } = resolveBackend(agent);
    return {
      agent, envOverrides, backendType,
      backendConfig: { backendName: backendId, fallbackId: backendObj?.fallback || null }
    };
  }

  /**
   * Send a message to the runner for a given session. Handles agent resolution,
   * env overrides, and the onResult/onError/onExit callbacks. Used by both
   * the initial POST handler and Ralph Loop continuations.
   */
  function sendRunnerMessage(sessionId, message, { claudeSessionId } = {}) {
    const session = sessionsStore.get(sessionId);
    if (!session) return;
    const resolved = resolveAgent(session.agentId);
    if (!resolved) return;
    const { agent, envOverrides, backendType, backendConfig } = resolved;

    // ── 프레임워크 자동 주입 ──
    // BASE: 워크스페이스 건강 상태 (첫 메시지에만)
    const isFirstMsg = !session.messages?.length || session.messages.length <= 1;
    if (isFirstMsg) {
      const baseCtx = buildBaseContext(agent.workingDir);
      if (baseCtx) agent.baseContext = baseCtx;
    }
    // CARL: 키워드 매칭 규칙 (매 메시지)
    const carlContext = buildCarlContext(agent.workingDir, message);
    if (carlContext) agent.carlContext = carlContext;
    // PAUL: 프로젝트 Phase/State (.paul/ 있으면)
    const paulCtx = buildPaulContext(agent.workingDir);
    if (paulCtx) agent.paulContext = paulCtx;

    // 대시보드 API 안내: 프로젝트 소속 에이전트에게 대시보드 조작 방법 주입
    const meta = metadataStore?.getAgent(session.agentId);
    if (meta?.projectId) {
      agent.dashboardHint = `\n<dashboard-api>\n작업 완료/진행 시 프로젝트 대시보드를 업데이트할 수 있습니다.\n- 목표 추가: curl -s -X POST http://localhost:3838/api/projects/${meta.projectId}/goals -H "Content-Type: application/json" -d '{"title":"목표","status":"todo"}'\n- 목표 완료: curl -s -X PATCH http://localhost:3838/api/projects/${meta.projectId}/goals/GOAL_ID -H "Content-Type: application/json" -d '{"status":"done"}'\n- 위젯 추가: curl -s -X POST http://localhost:3838/api/projects/${meta.projectId}/widgets -H "Content-Type: application/json" -d '{"type":"link","title":"제목","value":"URL"}'\n- 메모 수정: curl -s -X PUT http://localhost:3838/api/projects/${meta.projectId}/notes -H "Content-Type: application/json" -d '{"notes":"내용"}'\n</dashboard-api>`;
    }

    let accumText = '';
    const toolCalls = [];

    eventBus.publish('chat.started', { sessionId });

    runner.start({
      sessionId,
      agent,
      message,
      claudeSessionId: claudeSessionId ?? session.claudeSessionId,
      envOverrides,
      backendType,
      backendConfig,
      callbacks: {
        onText(chunk) {
          accumText += chunk;
          eventBus.publish('chat.chunk', { sessionId, text: chunk });
        },
        onToolUse(tool) {
          toolCalls.push(tool);
          eventBus.publish('chat.tool', { sessionId, tool });
        },
        async onResult(result) {
          try {
            await sessionsStore.appendMessage(sessionId, {
              role: 'assistant',
              content: result.text ?? accumText,
              toolCalls,
              model: result.model,
              usage: result.usage ?? null
            });
            if (result.claudeSessionId) {
              await sessionsStore.update(sessionId, { claudeSessionId: result.claudeSessionId });
            }
            eventBus.publish('chat.done', {
              sessionId,
              text: result.text,
              model: result.model,
              usage: result.usage ?? null
            });
            // Delegation detection + Ralph Loop continuation
            const responseText = result.text ?? accumText;
            handleDelegation(sessionId, responseText);
            handleLoopContinuation(sessionId, responseText);

            // Delegation report-back: if THIS session was a delegated task,
            // report the result to the originating session.
            if (delegationTracker) {
              const del = delegationTracker.getByTarget(sessionId);
              if (del) {
                const summary = (responseText ?? '').slice(0, 1000) || '(응답 없음)';
                const completed = delegationTracker.complete(sessionId, summary);
                if (completed) {
                  // Append result as a system message to the origin session
                  const reportMsg = `✅ **위임 완료** — ${completed.targetAgentId}\n\n**작업**: ${completed.task}\n\n**결과 요약**:\n${summary}`;
                  sessionsStore.appendMessage(completed.originSessionId, {
                    role: 'assistant',
                    content: reportMsg
                  });
                  eventBus.publish('delegation.completed', {
                    id: completed.id,
                    originSessionId: completed.originSessionId,
                    targetSessionId: completed.targetSessionId,
                    targetAgentId: completed.targetAgentId
                  });
                }
              }
            }
          } catch (err) {
            eventBus.publish('chat.error', { sessionId, error: err.message });
            // Also fail the delegation if this was a delegated session
            if (delegationTracker) {
              const del = delegationTracker.getByTarget(sessionId);
              if (del) delegationTracker.fail(sessionId, err.message);
            }
          }
        },
        onError(err) {
          eventBus.publish('chat.error', { sessionId, error: err.message });
          // 세션 손상 자동 복구: 에러 시 claudeSessionId 클리어 → 다음 시도는 새 세션
          if (session.claudeSessionId) {
            logger.warn({ sessionId, err: err.message }, 'chat: clearing claudeSessionId on error (auto-recovery)');
            sessionsStore.update(sessionId, { claudeSessionId: null }).catch(() => {});
          }
          if (delegationTracker) {
            const del = delegationTracker.getByTarget(sessionId);
            if (del) delegationTracker.fail(sessionId, err.message);
          }
        },
        onExit() {
          eventBus.publish('chat.exit', { sessionId });
        }
      }
    });
  }

  // ── Delegation (agent-to-agent) ────────────────────────

  /**
   * Scan the assistant's response for a delegation command:
   *   {"delegate": {"agent": "agent_id", "task": "description", "loop": true/false}}
   *
   * When found:
   * 1. Create a new session for the target agent
   * 2. Register the delegation in the tracker
   * 3. Send the task (first message) to the new session
   * 4. If loop:true, also start a Ralph Loop
   * 5. Publish delegation.started event
   * 6. Append a "[위임 중]" message to the origin session
   */
  async function handleDelegation(originSessionId, responseText) {
    if (!delegationTracker || !responseText) return;

    // Pattern: {"delegate": {"agent": "...", "task": "..."}}
    // Could also be {"message": "...", "delegate": {"agent": "...", "task": "..."}}
    const match = responseText.match(
      /\{\s*"delegate"\s*:\s*\{\s*"agent"\s*:\s*"([^"]+)"\s*,\s*"task"\s*:\s*"([^"]+)"(?:\s*,\s*"(?:model|loop)"\s*:\s*(?:"[^"]*"|true|false|null|\d+))*\s*\}\s*\}/
    );
    if (!match) {
      // Try alternate format with "message" field first
      const match2 = responseText.match(
        /\{\s*"message"\s*:\s*"[^"]*"\s*,\s*"delegate"\s*:\s*\{\s*"agent"\s*:\s*"([^"]+)"\s*,\s*"task"\s*:\s*"([^"]+)"(?:\s*,\s*"(?:model|loop)"\s*:\s*(?:"[^"]*"|true|false|null|\d+))*\s*\}\s*\}/
      );
      if (!match2) return;
      return executeDelegation(originSessionId, match2[1], match2[2], responseText);
    }
    return executeDelegation(originSessionId, match[1], match[2], responseText);
  }

  async function executeDelegation(originSessionId, targetAgentId, task, rawText) {
    try {
      // Verify target agent exists
      if (!configStore.getAgent(targetAgentId)) {
        logger.warn({ targetAgentId }, 'delegation: target agent not found');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⚠️ 위임 실패 — 에이전트 "${targetAgentId}"를 찾을 수 없습니다.`
        });
        return;
      }

      // Check for "loop" in the raw JSON
      const wantsLoop = /"loop"\s*:\s*true/.test(rawText);

      // Create a new session for the target agent
      const targetSession = await sessionsStore.create({
        agentId: targetAgentId,
        title: `[위임] ${task.slice(0, 40)}`
      });
      eventBus.publish('session.created', { session: targetSession });

      // Register in tracker
      const entry = delegationTracker.create({
        originSessionId,
        targetSessionId: targetSession.id,
        targetAgentId,
        task,
        loop: wantsLoop
      });

      // Append status to origin session
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `🔄 **위임 시작** — ${targetAgentId}에게 작업을 전달했습니다.\n\n**작업**: ${task}\n**세션**: ${targetSession.id}${wantsLoop ? '\n**모드**: Ralph Loop (자동 반복)' : ''}`
      });
      eventBus.publish('delegation.started', {
        id: entry.id,
        originSessionId,
        targetSessionId: targetSession.id,
        targetAgentId,
        task
      });

      // If loop mode, set up the loop config before sending
      if (wantsLoop) {
        await sessionsStore.update(targetSession.id, {
          loop: {
            enabled: true,
            prompt: task + '\n\n완료되면 <promise>DONE</promise>을 출력하세요. 도움이 필요하면 <escalate>이유</escalate>를 출력하세요.',
            maxIterations: 10,
            completionPromise: 'DONE',
            currentIteration: 0,
            startedAt: new Date().toISOString()
          }
        });
      }

      // Send the task as the first message
      const fullTask = wantsLoop
        ? `${task}\n\n완료되면 <promise>DONE</promise>을 출력하세요. 도움이 필요하면 <escalate>이유</escalate>를 출력하세요.`
        : task;
      await sessionsStore.appendMessage(targetSession.id, { role: 'user', content: fullTask });
      sendRunnerMessage(targetSession.id, fullTask);

      logger.info({
        id: entry.id,
        origin: originSessionId,
        target: targetSession.id,
        agent: targetAgentId,
        loop: wantsLoop
      }, 'delegation: task sent');
    } catch (err) {
      logger.error({ err, targetAgentId }, 'delegation: execution failed');
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `❌ 위임 실패 — ${err.message}`
      });
    }
  }

  // ── Ralph Loop + Escalation ────────────────────────────

  /**
   * Called after each assistant response. Checks if the session is in an
   * active Ralph Loop and decides: continue, complete, or escalate.
   *
   * Tags the agent should output:
   *   <promise>DONE</promise>       → loop completes successfully
   *   <escalate>reason</escalate>   → loop PAUSES, user notified with reason
   *   (neither)                     → next iteration auto-scheduled
   */
  async function handleLoopContinuation(sessionId, responseText) {
    const session = sessionsStore.get(sessionId);
    const loop = session?.loop;
    if (!loop?.enabled || loop.paused) return;

    const text = responseText ?? '';
    const nextIter = (loop.currentIteration ?? 0) + 1;

    // Check for completion promise
    const promiseTag = `<promise>${loop.completionPromise}</promise>`;
    const completed = text.includes(promiseTag);

    // Check for escalation
    const escalateMatch = text.match(/<escalate>([\s\S]*?)<\/escalate>/);
    const escalated = !!escalateMatch;
    const escalateReason = escalateMatch?.[1]?.trim() ?? '';

    if (completed || nextIter >= loop.maxIterations) {
      // ✅ Loop finished
      await sessionsStore.update(sessionId, { loop: null });
      eventBus.publish('session.loop.completed', {
        sessionId,
        iterations: nextIter,
        reason: completed ? 'promise' : 'max_iterations'
      });
      logger.info({ sessionId, iterations: nextIter, reason: completed ? 'promise' : 'max' }, 'ralph loop: completed');
    } else if (escalated) {
      // ⚠️ Escalation — pause the loop, notify user
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter, paused: true, escalateReason }
      });
      eventBus.publish('session.loop.escalated', {
        sessionId,
        iteration: nextIter,
        reason: escalateReason
      });
      logger.info({ sessionId, iteration: nextIter, reason: escalateReason }, 'ralph loop: escalated');
    } else {
      // 🔄 Continue — schedule next iteration after cooldown
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter }
      });
      eventBus.publish('session.loop.iteration', {
        sessionId,
        iteration: nextIter,
        maxIterations: loop.maxIterations
      });
      logger.info({ sessionId, iteration: nextIter, max: loop.maxIterations }, 'ralph loop: next iteration');
      setTimeout(() => {
        try {
          // Re-check: loop might have been cancelled during cooldown
          const s = sessionsStore.get(sessionId);
          if (!s?.loop?.enabled || s.loop.paused) return;
          // Persist the loop prompt as a user message so it appears in history
          const iterLabel = `[Loop ${nextIter}/${loop.maxIterations}] ${loop.prompt}`;
          sessionsStore.appendMessage(sessionId, { role: 'user', content: iterLabel });
          sendRunnerMessage(sessionId, loop.prompt);
        } catch (err) {
          eventBus.publish('chat.error', { sessionId, error: `Loop failed: ${err.message}` });
        }
      }, 2000);
    }
  }

  // ── Routes ─────────────────────────────────────────────

  router.post('/', async (req, res, next) => {
    try {
      const { sessionId, message, attachmentPaths } = sendSchema.parse(req.body);
      const session = sessionsStore.get(sessionId);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      if (!configStore.getAgent(session.agentId)) {
        throw new HttpError(404, `Agent ${session.agentId} not found`, 'AGENT_NOT_FOUND');
      }
      if (runner.isRunning(sessionId)) {
        throw new HttpError(409, 'Session is currently running', 'BUSY');
      }

      // Auto-title on first message
      const isFirstMessage = !session.messages?.length;
      let augmentedMessage = message;
      if (attachmentPaths && attachmentPaths.length > 0) {
        const fileList = attachmentPaths.map((p) => `- ${p}`).join('\n');
        augmentedMessage = `${message}\n\n[첨부 파일]\n${fileList}\n\n위 경로의 파일들을 Read 도구로 확인해주세요.`;
      }
      await sessionsStore.appendMessage(sessionId, {
        role: 'user',
        content: augmentedMessage,
        attachmentPaths: attachmentPaths ?? []
      });
      if (isFirstMessage && (!session.title || session.title === 'New session')) {
        const title = message.slice(0, 40).replace(/\n/g, ' ').trim() || 'New session';
        await sessionsStore.update(sessionId, { title });
      }

      // If the session had a PAUSED loop (escalation), the user's message
      // is the escalation response. Unpause so the next onResult continues.
      if (session.loop?.enabled && session.loop?.paused) {
        await sessionsStore.update(sessionId, {
          loop: { ...session.loop, paused: false }
        });
      }

      sendRunnerMessage(sessionId, augmentedMessage);
      res.status(202).json({ sessionId, status: 'started' });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/:sessionId', (req, res) => {
    const aborted = runner.abort(req.params.sessionId);
    if (eventBus) eventBus.publish('chat.aborted', { sessionId: req.params.sessionId });
    res.json({ aborted });
  });

  return router;
}
