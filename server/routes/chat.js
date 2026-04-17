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

  // ── 응답 중 입력 메시지 큐 ──
  // sessionId → 큐잉된 유저 메시지 배열
  // 현재 응답 끝날 때 합쳐서 다음 턴으로 자동 전송
  const messageQueue = new Map();

  function enqueueMessage(sessionId, message) {
    if (!messageQueue.has(sessionId)) messageQueue.set(sessionId, []);
    messageQueue.get(sessionId).push(message);
  }

  function flushQueue(sessionId) {
    const q = messageQueue.get(sessionId);
    if (!q || q.length === 0) return null;
    messageQueue.delete(sessionId);
    // 여러 메시지를 합쳐서 하나로 (각각 줄 구분)
    return q.length === 1 ? q[0] : q.map((m, i) => `[추가 ${i + 1}] ${m}`).join('\n\n');
  }

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

    // 선택지 버튼 UI 힌트: 여러 옵션 중 하나 고르게 할 때 <choices> 태그 사용
    agent.choicesHint = `\n<ui-hints>\n사용자가 여러 옵션 중 하나를 선택해야 할 때 응답 끝에 <choices> 태그로 감싸서 제공하세요. UI에서 버튼으로 렌더링됩니다.\n가장 추천하는 옵션 하나에 ⭐ 마커를 앞에 붙이면 추천 배지로 강조됩니다. (또는 [추천] / (추천) 태그도 가능)\n예시:\n<choices>\n- ⭐ 옵션 A (가장 추천)\n- 옵션 B\n- 옵션 C\n</choices>\n</ui-hints>`;

    // 위임 포맷 안내: 같은 프로젝트 내 다른 에이전트 ID + JSON 포맷 자동 주입
    {
      const allAgents = configStore.getAgents?.() || {};
      const sameProject = [];
      const selfMeta = metadataStore?.getAgent(session.agentId);
      const myProj = selfMeta?.projectId;
      if (myProj) {
        for (const [id, cfg] of Object.entries(allAgents)) {
          if (id === session.agentId) continue;
          const m = metadataStore?.getAgent(id);
          if (m?.projectId === myProj) {
            sameProject.push({ id, name: cfg?.name || id });
          }
        }
      }
      const delegateTargets = sameProject.length > 0
        ? sameProject.map(a => `- ${a.id}${a.name && a.name !== a.id ? ` (${a.name})` : ''}`).join('\n')
        : '- (동일 프로젝트 내 다른 에이전트 없음 — 필요 시 범용 planner_office 또는 다른 프로젝트 에이전트 ID 사용)';
      agent.delegateHint = `\n<delegation>\n다른 에이전트에게 작업을 맡기려면 응답에 아래 JSON을 포함하세요 (코드블록 안이어도 됨):\n\n\`\`\`json\n{"message": "짧은 안내", "delegate": {"agent": "실제_에이전트_ID", "task": "작업 설명(200자 이내)", "model": "glm-5.1 또는 sonnet/opus", "loop": false}}\n\`\`\`\n\n중요:\n- agent ID는 반드시 실제 등록된 ID(언더스코어 표기). 점(.)/대시(-) 표기는 자동 정규화되지만 혼동 방지를 위해 언더스코어 권장.\n- task 는 한국어 200자 이내 요약. 파일 전체 본문을 붙여넣지 마세요.\n- loop:true 면 Ralph Loop 모드 (DONE 출력까지 반복).\n- "새 세션을 열어 붙여넣으세요" 같은 우회 응답 금지 — 직접 이 JSON 을 출력하세요.\n\n같은 프로젝트 내 위임 가능 에이전트:\n${delegateTargets}\n</delegation>`;
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

            // 응답 중 큐잉된 메시지 있으면 자동으로 다음 턴에 전송
            // (메시지는 이미 session.messages에 queued:true 플래그로 저장됨 → 중복 저장 안 함)
            const queued = flushQueue(sessionId);
            if (queued) {
              logger.info({ sessionId }, 'chat: flushing queued messages — next turn with context ref');
              setTimeout(() => {
                try {
                  const prefixed = `[이전 답변 중에 추가된 요청 — 이전 맥락을 참고해서 답변하세요]\n\n${queued}`;
                  sendRunnerMessage(sessionId, prefixed);
                } catch (err) {
                  logger.warn({ err, sessionId }, 'chat: failed to flush queue');
                }
              }, 500);
            }

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
          // 재발 방지: 에러 시 세션에 에러 메시지 append (사용자가 UI 열면 바로 인지)
          sessionsStore.appendMessage(sessionId, {
            role: 'assistant',
            content: `⚠️ **응답 중단됨** — ${err.message}\n\n메시지를 다시 보내주세요.`
          }).catch(() => {});
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
        onExit({ code } = {}) {
          eventBus.publish('chat.exit', { sessionId, code });
          // 비정상 종료 + 응답이 없었던 경우 방어막:
          // accumText 가 비어있고 code !== 0 이면 onError 에서 이미 처리됐을 것이지만,
          // code === 0 인데도 응답이 없을 수도 있어서 (CLI 가 조용히 실패) 한 번 더 체크.
          if ((code === 0 || code === null) && !accumText.trim()) {
            sessionsStore.appendMessage(sessionId, {
              role: 'assistant',
              content: '⚠️ **응답이 비어있습니다** — runner 가 응답 없이 종료. 다시 시도해 주세요.'
            }).catch(() => {});
          }
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
  /**
   * 텍스트에서 "delegate" 키가 있는 JSON 블록을 찾아 파싱 (중첩 괄호 균형)
   */
  function extractDelegateJson(text) {
    // 코드 블록 안에 있을 수도 있음
    const candidates = [];
    // 1) ```json ... ``` 코드 블록
    const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const cb of codeBlocks) candidates.push(cb[1]);
    // 2) 전체 텍스트
    candidates.push(text);

    for (const src of candidates) {
      let idx = src.indexOf('"delegate"');
      while (idx !== -1) {
        // 앞으로 가서 여는 중괄호 찾기
        let start = src.lastIndexOf('{', idx);
        if (start === -1) { idx = src.indexOf('"delegate"', idx + 1); continue; }
        // 균형 맞는 닫는 중괄호
        let depth = 0, end = -1, inString = false, prev = '';
        for (let i = start; i < src.length; i++) {
          const c = src[i];
          if (inString) {
            if (c === '"' && prev !== '\\') inString = false;
          } else {
            if (c === '"') inString = true;
            else if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) { end = i; break; }
            }
          }
          prev = c;
        }
        if (end !== -1) {
          try {
            const obj = JSON.parse(src.slice(start, end + 1));
            if (obj?.delegate?.agent && obj?.delegate?.task) return obj;
          } catch { /* ignore, try next */ }
        }
        idx = src.indexOf('"delegate"', idx + 1);
      }
    }
    return null;
  }

  async function handleDelegation(originSessionId, responseText) {
    if (!delegationTracker || !responseText) return;
    const parsed = extractDelegateJson(responseText);
    if (!parsed) return;
    return executeDelegation(
      originSessionId,
      parsed.delegate.agent,
      parsed.delegate.task,
      JSON.stringify(parsed)
    );
  }

  /**
   * agent ID 정규화: 플래너 systemPrompt가 "cf.router"로 적어도 실제 ID "cf_router"로 매칭.
   * 또 "cf/router", "cf-router", 대소문자 차이, 뒤쪽 점표기(.planner → _planner)도 허용.
   */
  function resolveAgentId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    // 1) 정확 일치
    if (configStore.getAgent(trimmed)) return trimmed;
    // 2) 구분자 바꿔 시도 (., -, /, 공백 → _)
    const normalized = trimmed.replace(/[.\-/\s]+/g, '_');
    if (configStore.getAgent(normalized)) return normalized;
    // 3) _ → . 반대 방향
    const dotted = trimmed.replace(/_/g, '.');
    if (configStore.getAgent(dotted)) return dotted;
    // 4) 대소문자 무시로 전체 탐색
    const all = configStore.getAgents() || {};
    const lowerNorm = normalized.toLowerCase();
    for (const id of Object.keys(all)) {
      const idNorm = id.replace(/[.\-/\s]+/g, '_').toLowerCase();
      if (idNorm === lowerNorm) return id;
    }
    return null;
  }

  async function executeDelegation(originSessionId, targetAgentIdRaw, task, rawText) {
    try {
      // Verify target agent exists (with ID normalization)
      const targetAgentId = resolveAgentId(targetAgentIdRaw);
      if (!targetAgentId) {
        logger.warn({ targetAgentIdRaw }, 'delegation: target agent not found');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⚠️ 위임 실패 — 에이전트 "${targetAgentIdRaw}"를 찾을 수 없습니다.`
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
      // 실행 중이면 큐잉 — 현재 응답 끝나면 자동으로 다음 턴에 전송
      // (Claude Code와 동일한 방식: LLM은 스트림 도중 끊으면 컨텍스트 손실)
      if (runner.isRunning(sessionId)) {
        let augmentedMessage = message;
        if (attachmentPaths && attachmentPaths.length > 0) {
          const fileList = attachmentPaths.map((p) => `- ${p}`).join('\n');
          augmentedMessage = `${message}\n\n[첨부 파일]\n${fileList}`;
        }
        enqueueMessage(sessionId, augmentedMessage);
        // UI에 표시되도록 세션에도 저장 (queued 플래그로 구분)
        await sessionsStore.appendMessage(sessionId, {
          role: 'user',
          content: augmentedMessage,
          attachmentPaths: attachmentPaths ?? [],
          queued: true
        });
        eventBus.publish('chat.queued', { sessionId, count: messageQueue.get(sessionId)?.length ?? 0 });
        logger.info({ sessionId, queue: messageQueue.get(sessionId)?.length }, 'chat: queued during running');
        return res.status(202).json({ sessionId, status: 'queued', queueLength: messageQueue.get(sessionId)?.length });
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

  /**
   * 서버 재시작 시 중단된 세션을 자동 재개 — 마지막 user 메시지를 runner 에 재제출.
   * index.js 의 시작 단계에서 pending-resume.json 기반으로 호출.
   */
  async function resumeInterruptedSession(sessionId) {
    const session = sessionsStore.get(sessionId);
    if (!session) return false;
    const msgs = Array.isArray(session.messages) ? session.messages : [];
    // 마지막 user 메시지 찾기 (응답 중단 알림 직전의 user 입력)
    const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
    if (!lastUser?.content) return false;
    logger.info({ sessionId }, 'resuming interrupted session from last user message');
    // 재개 안내 메시지 append → 사용자가 UI 에서 인지
    await sessionsStore.appendMessage(sessionId, {
      role: 'assistant',
      content: '▶ **재시작 후 작업 이어가기** — 마지막 메시지로 다시 시도합니다.'
    }).catch(() => {});
    sendRunnerMessage(sessionId, lastUser.content);
    return true;
  }

  return { router, resumeInterruptedSession };
}
