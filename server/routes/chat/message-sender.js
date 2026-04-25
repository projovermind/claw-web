import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../lib/logger.js';
import { buildCarlContext } from '../../lib/carl-injector.js';
import { buildSkillContext } from '../../lib/skill-injector.js';
import { buildBaseContext } from '../../lib/base-reader.js';
import { buildPaulContext } from '../../lib/paul-reader.js';
import { buildPinnedFilesContext, buildGitDiffContext, buildBridgeContext } from '../../lib/working-context-injector.js';
import { findClaudeSessionFile } from '../../runners/claude-cli-runner.js';
import { classifyError, resolveAgent, buildConversationSummary } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/routes/chat/ → ../../mcp/permission-bridge.js
const PERMISSION_BRIDGE_PATH = path.resolve(__dirname, '../../mcp/permission-bridge.js');

/**
 * Builds an ephemeral .mcp.json for this session that registers our stdio
 * permission-prompt bridge. Returns { configPath, cleanup }.
 *
 * The bridge subprocess receives CLAW_BRIDGE_URL/TOKEN/SESSION_ID via env so it
 * can POST back to /internal/approval/request when Claude asks for permission.
 */
function buildMcpPermissionConfig({ sessionId, bridgeToken, port }) {
  const configPath = path.join(os.tmpdir(), `claw-mcp-${sessionId}.json`);
  const bridgeUrl = `http://127.0.0.1:${port}/internal/approval/request`;
  const config = {
    mcpServers: {
      claw: {
        command: process.execPath, // node binary
        args: [PERMISSION_BRIDGE_PATH],
        env: {
          CLAW_BRIDGE_URL: bridgeUrl,
          CLAW_BRIDGE_TOKEN: bridgeToken,
          CLAW_SESSION_ID: sessionId
        }
      }
    }
  };
  try {
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message, configPath }, 'mcp-permission: failed to write config (disabling prompt)');
    return null;
  }
  return {
    configPath,
    cleanup() {
      fsp.unlink(configPath).catch(() => {});
    }
  };
}

/**
 * Creates sendRunnerMessage. References ctx.handleDelegation,
 * ctx.handleLoopContinuation, ctx.flushQueue, ctx.dequeueNextAgent,
 * which must be wired before the first invocation.
 */
export function createMessageSender(ctx) {
  const {
    sessionsStore,
    configStore,
    metadataStore,
    skillsStore,
    systemSkillsStore,
    projectsStore,
    backendsStore,
    accountsStore,
    runner,
    eventBus,
    delegationTracker,
    pushStore,
    webConfig,
    getBridgeContext,
    retryCounters,
    MAX_AUTO_RETRIES,
    approvalBroker,
    bridgeToken
  } = ctx;

  function sendRunnerMessage(sessionId, message, { claudeSessionId } = {}) {
    const session = sessionsStore.get(sessionId);
    if (!session) return;
    const resolved = resolveAgent(session.agentId, {
      configStore, metadataStore, projectsStore, backendsStore, skillsStore, systemSkillsStore, accountsStore
    });
    if (!resolved) return;
    const { agent, envOverrides, backendType, backendConfig } = resolved;

    // ── Resume target 검증 ──
    // Claude CLI 세션 파일이 사라졌거나 손상된 경우 --resume 실패로 silent fallback 발생.
    // 이 시점에 session.claudeSessionId 를 clear 해야 아래 isFirstMsg 가 true 로 잡혀
    // persona/skills/base/carl/paul 이 fresh session 에 재주입된다.
    // (호출자가 claudeSessionId:null 로 fresh-start 를 명시한 경우는 검증 생략)
    const explicitFreshStart = claudeSessionId === null;
    if (!explicitFreshStart && session.claudeSessionId) {
      // agent.configDir 가 있으면 정확 탐색, 없으면 ~/.claude + ~/.claude-claw/* 전체 스캔(fallback)
      const resumeFile = findClaudeSessionFile(agent.workingDir, session.claudeSessionId, agent.configDir || null);
      if (!resumeFile) {
        logger.warn(
          { sessionId, claudeSessionId: session.claudeSessionId, cwd: agent.workingDir, configDir: agent.configDir || null },
          'chat: resume file missing — clearing claudeSessionId to force persona re-injection'
        );
        sessionsStore.update(sessionId, { claudeSessionId: null, personaBakedInto: null }).catch(() => {});
        session.claudeSessionId = null;
        session.personaBakedInto = null;
      }
    }

    // ── 프레임워크 자동 주입 ──
    // 중요: --append-system-prompt 에 넣는 모든 내용은 첫 턴에만 주입한다.
    // 이후 턴은 --resume 으로 세션의 원본 시스템 프롬프트가 그대로 복원되므로
    // 매 턴 다른 컨텍스트를 append 하면 (1) prompt cache 완전 파괴 → 토큰 폭증,
    // (2) 모델이 보는 시스템 프롬프트가 매 턴 달라져 대화 맥락 일관성 붕괴.
    // 특히 carlContext 는 userMessage 키워드 매칭 결과라 매 턴 내용이 바뀜 → 치명적.
    //
    // isFirstMsg 판정 기준:
    // - claudeSessionId 부재 == CLI 가 resume 할 대상 없음 == fresh session 을 열게 됨
    //   → 이 fresh session 은 아직 system prompt 를 받은 적 없으므로 반드시 주입 필요.
    // - messages.length <= 1: 브랜드뉴 세션 방어 (claudeSessionId 가 혹시 남아 있어도)
    // 과거 버그: messages.length 만 보면 silent-exit/context-length 재시도로
    // claudeSessionId 를 null 로 초기화해 fresh CLI 세션을 여는데, messages 는 수십 개이므로
    // isFirstMsg=false → 주입 스킵 → persona/스킬 없는 '누구인지 모르는 에이전트' 로 전락.
    const effectiveResumeId = explicitFreshStart ? null : (claudeSessionId ?? session.claudeSessionId);
    // isFirstMsg 판정:
    // (a) resume 대상 없음 → fresh session → 주입 필요
    // (b) messages.length <= 1 → 브랜드뉴 세션
    // (c) personaBakedInto !== effectiveResumeId → 이 CLI 세션에 persona 가 구워진 적 없음
    //     (silent-fallback 으로 CLI 세션 ID 가 교체됐는데 messages 는 남아있는 경우 방어)
    const isFirstMsg =
      !effectiveResumeId ||
      !session.messages?.length ||
      session.messages.length <= 1 ||
      session.personaBakedInto !== effectiveResumeId;
    const isWorkerSession = session.isDelegation === true;
    const meta = metadataStore?.getAgent(session.agentId);

    if (isFirstMsg) {
      const baseCtx = buildBaseContext(agent.workingDir);
      if (baseCtx) agent.baseContext = baseCtx;

      if (meta?.projectId && projectsStore) {
        const proj = projectsStore.getById(meta.projectId);
        const memory = proj?.dashboard?.memory?.trim();
        if (memory) agent.projectMemory = memory;
      }

      if (Array.isArray(agent.skills) && agent.skills.length > 0) {
        agent.skills = buildSkillContext(agent.skills, message);
      }

      const carlContext = buildCarlContext(agent.workingDir, message);
      if (carlContext) agent.carlContext = carlContext;
      const paulCtx = buildPaulContext(agent.workingDir);
      if (paulCtx) agent.paulContext = paulCtx;

      // Phase 1: pinned files (first-turn only → cached via --resume)
      if (Array.isArray(agent.pinnedFiles) && agent.pinnedFiles.length > 0) {
        const pinnedCtx = buildPinnedFilesContext(agent.pinnedFiles, agent.workingDir);
        if (pinnedCtx) agent.pinnedFilesContext = pinnedCtx;
      }

      // 대시보드 API 안내: 프로젝트 소속 에이전트에게 대시보드 조작 방법 주입
      if (!isWorkerSession && meta?.projectId) {
        const isLead = meta.tier === 'project';
        const leadPrefix = isLead
          ? `당신은 이 프로젝트의 리드 에이전트입니다. 작업 시작/완료/진행 상황을 반드시 대시보드에 기록하세요. 목표는 시작 시 todo로 추가하고, 완료 시 done으로 갱신하세요. 위젯/메모도 적극 활용하세요.\n`
          : `작업 완료 시 반드시 프로젝트 대시보드를 업데이트하세요. 작업 시작 시 goal을 todo로 추가하고, 완료 시 done으로 갱신하세요.\n`;
        const authHeader = webConfig?.auth?.enabled && webConfig?.auth?.token
          ? ` -H "Authorization: Bearer ${webConfig.auth.token}"`
          : '';
        agent.dashboardHint = `\n<dashboard-api>\n${leadPrefix}- 목표 추가: curl -s -X POST http://localhost:3838/api/projects/${meta.projectId}/goals${authHeader} -H "Content-Type: application/json" -d '{"title":"목표","status":"todo"}'\n- 목표 완료: curl -s -X PATCH http://localhost:3838/api/projects/${meta.projectId}/goals/GOAL_ID${authHeader} -H "Content-Type: application/json" -d '{"status":"done"}'\n- 위젯 추가: curl -s -X POST http://localhost:3838/api/projects/${meta.projectId}/widgets${authHeader} -H "Content-Type: application/json" -d '{"type":"link","title":"제목","value":"URL"}'\n- 메모 수정: curl -s -X PUT http://localhost:3838/api/projects/${meta.projectId}/notes${authHeader} -H "Content-Type: application/json" -d '{"notes":"내용"}'\n- 프로젝트 메모리 업데이트: curl -s -X PUT http://localhost:3838/api/projects/${meta.projectId}/memory${authHeader} -H "Content-Type: application/json" -d '{"memory":"내용"}'\n\n프로젝트 메모리는 모든 에이전트가 세션 시작 시 읽는 운영 컨텍스트입니다. 작업 완료 시 핵심 경로/배포 방식/최근 작업 내역을 반드시 업데이트하세요. 1500자 이하로 유지하세요.\n</dashboard-api>`;
      }

      agent.choicesHint = `\n<ui-hints>\n이 세션은 비대화형(-p) 모드 입니다. AskUserQuestion / ExitPlanMode 같은 대화형 툴은 호출하지 마세요 — 응답이 '취소됨' 으로 돌아와 작업이 애매하게 종료됩니다.\n\n사용자에게 질문하거나 선택지를 주고 싶을 때는 반드시 응답 끝에 <choices> 태그로 감싸서 제공하세요. UI 에서 버튼으로 렌더링됩니다.\n가장 추천하는 옵션 하나에 ⭐ 마커를 앞에 붙이면 추천 배지로 강조됩니다. (또는 [추천] / (추천) 태그도 가능)\n예시:\n<choices>\n- ⭐ 옵션 A (가장 추천)\n- 옵션 B\n- 옵션 C\n</choices>\n\n사용자 승인이 필요한 플랜을 세운 경우에도 ExitPlanMode 대신: (1) 플랜 본문 마크다운으로 작성 → (2) 끝에 <choices> 로 "바로 실행" / "수정 필요" / "보류" 제시.\n</ui-hints>`;

      if (!isWorkerSession) {
        const allAgents = configStore.getAgents?.() || {};
        const sameProject = [];
        const myProj = meta?.projectId;
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
    } else {
      // 이후 턴: --append-system-prompt 를 완전히 비워 둠.
      // --resume 으로 복원된 원본 시스템 프롬프트만 사용 → 캐시 히트 + 맥락 일관성 유지.
      agent.skills = [];
      agent.baseContext = null;
      agent.carlContext = null;
      agent.paulContext = null;
      agent.projectMemory = null;
      agent.dashboardHint = null;
      agent.choicesHint = null;
      agent.delegateHint = null;
      agent.pinnedFilesContext = null;
      // agent.systemPrompt 도 제거 — 첫 턴에 이미 세션에 구워짐
      agent.systemPrompt = null;
    }

    // Phase 1: git diff auto-attach — per-turn prepend (not cached; dynamic by design)
    if (agent.gitDiffAutoAttach) {
      const diffCtx = buildGitDiffContext(agent.workingDir);
      if (diffCtx) {
        message = `${diffCtx}\n\n${message}`;
      }
    }

    // Phase 5: VS Code bridge auto-attach — per-turn prepend (dynamic)
    if (agent.bridgeAutoAttach && typeof getBridgeContext === 'function') {
      try {
        const bridgeState = getBridgeContext(agent.workingDir);
        const bridgeBlock = buildBridgeContext(bridgeState, agent.workingDir);
        if (bridgeBlock) {
          message = `${bridgeBlock}\n\n${message}`;
        }
      } catch (err) {
        logger.warn({ err: err.message, sessionId }, 'chat: bridge context inject failed (non-fatal)');
      }
    }

    // ── 강제 fresh-start 감지 → 대화 요약 주입 ──
    // isFirstMsg=true 인데 session.messages 가 이미 쌓여 있으면 silent-fallback /
    // resume-file-missing 등으로 CLI 세션이 새로 열린 상황. --resume 복원이 불가능하므로
    // 이전 대화를 요약해서 user message 앞에 프리픽스로 주입해야 맥락이 이어진다.
    // (context_length / silent_exit 재시도 경로는 이미 summary 를 붙이지만,
    //  일반 턴 진입에서 claudeSessionId 가 null 로 바뀐 경우는 누락되어 대화가 끊겼음)
    if (isFirstMsg && Array.isArray(session.messages) && session.messages.length > 1) {
      const prior = session.messages.slice(0, -1);
      const summary = buildConversationSummary(prior, { recent: 6 });
      if (summary) {
        logger.info(
          { sessionId, priorMessages: prior.length },
          'chat: fresh-start with prior history — injecting conversation summary to preserve context'
        );
        message = `${summary}\n\n---\n\n[현재 요청]\n${message}`;
      }
    }

    let accumText = '';
    const toolCalls = [];

    // ── MCP permission-prompt bridge (optional, non-plan mode only) ──
    // Writes an ephemeral MCP config so Claude CLI spawns our stdio bridge and
    // routes tool-permission decisions back to the user via WS modal.
    let mcpPermission = null;
    if (!agent.planMode && approvalBroker && bridgeToken) {
      mcpPermission = buildMcpPermissionConfig({
        sessionId,
        bridgeToken,
        port: webConfig?.port || 3838
      });
      if (mcpPermission) {
        agent.mcpConfigPath = mcpPermission.configPath;
        agent.permissionPromptTool = 'mcp__claw__approval_prompt';
      }
    }
    function cleanupPermissionBridge() {
      if (mcpPermission) {
        try { mcpPermission.cleanup(); } catch { /* ignore */ }
        mcpPermission = null;
      }
      if (approvalBroker) approvalBroker.cancelForSession(sessionId, 'session ended');
    }

    eventBus.publish('chat.started', { sessionId });

    try {
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
        onRateLimit({ accountId, backendId, nextAccountId }) {
          eventBus.publish('chat.account-ratelimit', { sessionId, accountId, backendId: backendId ?? accountId ?? null, nextAccountId });
          logger.info({ sessionId, accountId, backendId, nextAccountId }, 'chat: account rate-limited, broadcasting switch');
        },
        async onResult(result) {
          retryCounters.delete(sessionId);
          // prompt cache 검증 로그 — cache_creation / cache_read 토큰 추적
          if (result.usage) {
            const { cacheReadTokens, inputTokens, outputTokens } = result.usage;
            logger.info(
              { sessionId, isFirstMsg, inputTokens, outputTokens, cacheReadTokens: cacheReadTokens ?? 0 },
              'chat: token usage'
            );
          }
          try {
            await sessionsStore.appendMessage(sessionId, {
              role: 'assistant',
              content: result.text ?? accumText,
              toolCalls,
              model: result.model,
              usage: result.usage ?? null
            });
            if (result.claudeSessionId) {
              // Silent fallback 감지: 요청한 resume ID 와 실제 돌려받은 ID 가 다름.
              // = Claude CLI 가 --resume 을 조용히 포기하고 새 세션을 만든 상황.
              // 이전 동작: claudeSessionId 를 null 로 지움 → 다음 턴도 fresh 세션을 새로 열어 무한 루프.
              // 개선: 새 CLI 세션 ID 를 보존하되 personaBakedInto=null 로 기록 →
              //   다음 턴 isFirstMsg 판정이 true 가 되어 persona 재주입.
              //   그리고 runner 의 session 파일에 persona 가 구워진 뒤부터는 --resume 으로 정상 이어짐.
              const requestedResume = explicitFreshStart ? null : (claudeSessionId ?? session.claudeSessionId);
              if (requestedResume && result.claudeSessionId !== requestedResume) {
                logger.warn(
                  { sessionId, requested: requestedResume, actual: result.claudeSessionId },
                  'chat: claude CLI silent-fallback (resume dropped) — preserving new session ID; persona will be re-injected next turn'
                );
                await sessionsStore.update(sessionId, {
                  claudeSessionId: result.claudeSessionId,
                  personaBakedInto: null
                });
              } else {
                // 정상 경로: claudeSessionId 저장.
                // isFirstMsg 였다면 이 턴에 persona 가 구워졌으니 personaBakedInto 도 갱신.
                const patch = { claudeSessionId: result.claudeSessionId };
                if (isFirstMsg) patch.personaBakedInto = result.claudeSessionId;
                await sessionsStore.update(sessionId, patch);
              }
            }
            eventBus.publish('chat.done', {
              sessionId,
              text: result.text,
              model: result.model,
              usage: result.usage ?? null
            });
            if (pushStore) {
              const agentName = configStore.getAgent(session.agentId)?.name || session.agentId;
              pushStore.sendPushToAll(`${agentName} 완료`, '응답이 완료되었습니다.', { url: `/chat/${sessionId}` }).catch(() => {});
            }
            const responseText = result.text ?? accumText;
            ctx.handleDelegation(sessionId, responseText);
            ctx.handleLoopContinuation(sessionId, responseText);

            const queued = ctx.flushQueue(sessionId);
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

            // Delegation report-back + auto re-entry
            if (delegationTracker) {
              const del = delegationTracker.getByTarget(sessionId);
              if (del) {
                const summary = (responseText ?? '').slice(0, 2000) || '(응답 없음)';
                const completed = delegationTracker.complete(sessionId, summary);
                if (completed) {
                  ctx.dequeueNextAgent(completed.targetAgentId);

                  await sessionsStore.appendMessage(completed.originSessionId, {
                    role: 'assistant',
                    content: `✅ **위임 완료** — ${completed.targetAgentId}\n\n**작업**: ${completed.task}\n\n**결과 요약**:\n${summary}`
                  });
                  eventBus.publish('delegation.completed', {
                    id: completed.id,
                    originSessionId: completed.originSessionId,
                    targetSessionId: completed.targetSessionId,
                    targetAgentId: completed.targetAgentId
                  });
                  if (pushStore) {
                    const agentName = configStore.getAgent(completed.targetAgentId)?.name || completed.targetAgentId;
                    pushStore.sendPushToAll(`${agentName} 위임 완료`, completed.task?.slice(0, 80) || '위임된 작업이 완료되었습니다.', { url: `/chat/${completed.originSessionId}` }).catch(() => {});
                  }

                  try {
                    const alreadyRunning = runner.isRunning(completed.originSessionId);
                    const reEntryCount = (ctx.reEntryCounters.get(completed.originSessionId) ?? 0) + 1;
                    if (!alreadyRunning && reEntryCount <= ctx.MAX_REENTRY) {
                      ctx.reEntryCounters.set(completed.originSessionId, reEntryCount);
                      const trigger =
                        `[위임 결과 보고]\n\n` +
                        `**대상 에이전트**: ${completed.targetAgentId}\n` +
                        `**작업**: ${completed.task}\n` +
                        `**결과 요약**:\n${summary}\n\n` +
                        `위 결과를 바탕으로 계획을 계속 진행하세요. ` +
                        `다음 위임할 작업이 있으면 즉시 위임 JSON을 출력하세요. ` +
                        `사용자에게 확인받거나 choices 태그로 질문하지 말고 자동으로 계속 진행하세요. ` +
                        `모든 작업이 완료됐을 때만 최종 결과를 사용자에게 보고하세요.`;
                      await sessionsStore.appendMessage(completed.originSessionId, {
                        role: 'user',
                        content: trigger
                      });
                      sendRunnerMessage(completed.originSessionId, trigger);
                    } else if (reEntryCount > ctx.MAX_REENTRY) {
                      logger.warn({ originSessionId: completed.originSessionId, reEntryCount }, 'delegation re-entry limit exceeded — stopping auto-chain');
                      await sessionsStore.appendMessage(completed.originSessionId, {
                        role: 'assistant',
                        content: `⚠️ **위임 자동 진행 한계 도달** (${reEntryCount - 1}/${ctx.MAX_REENTRY}회) — 무한 루프 방지를 위해 자동 진행을 중단합니다. 다음 단계를 직접 지시해 주세요.`
                      });
                    } else {
                      logger.info({ originSessionId: completed.originSessionId }, 'delegation re-entry skipped (planner already running)');
                    }
                  } catch (err) {
                    logger.warn({ err: err.message }, 'delegation re-entry failed');
                  }
                }
              }
            }
          } catch (err) {
            eventBus.publish('chat.error', { sessionId, error: err.message });
            if (delegationTracker) {
              const del = delegationTracker.getByTarget(sessionId);
              if (del) {
                const failed = delegationTracker.fail(sessionId, err.message);
                if (failed) ctx.dequeueNextAgent(failed.targetAgentId);
              }
            }
          }
        },
        onError(err) {
          const { canRetry, delay, label } = classifyError(err.message);
          const counter = retryCounters.get(sessionId) ?? { count: 0, lastError: '' };

          // cli_exit / silent_fallback 은 동일 조건 반복 가능성이 크므로 1회만 재시도.
          const maxForLabel = (label === 'cli_exit' || label === 'silent_fallback') ? 1 : MAX_AUTO_RETRIES;

          if (canRetry && counter.count < maxForLabel) {
            const attempt = counter.count + 1;
            retryCounters.set(sessionId, { count: attempt, lastError: err.message });
            logger.warn({ sessionId, label, attempt, delay }, 'chat: auto-recovery scheduled');
            sessionsStore.appendMessage(sessionId, {
              role: 'assistant',
              content: `🔄 **자동 복구 중** (${attempt}/${maxForLabel}) — \`${label}\` 오류 감지. ${delay >= 1000 ? `${delay / 1000}초 후 재시도합니다...` : '즉시 재시도합니다...'}`
            }).catch(() => {});
            eventBus.publish('chat.error', { sessionId, error: `[auto-retry ${attempt}/${maxForLabel}] ${err.message}` });
            // context_length / silent_fallback: --resume 유지 시 같은 실패 반복 → fresh-start 로 전환.
            //   summary prefix 는 sendRunnerMessage 내부(isFirstMsg 분기)에서 자동 주입되므로
            //   여기서 추가 prefix 하면 요약이 두 번 들어감 → 호출은 원본 메시지 그대로.
            const needsFreshStart = label === 'context_length' || label === 'silent_fallback';
            if (needsFreshStart) {
              sessionsStore.update(sessionId, { claudeSessionId: null, personaBakedInto: null }).catch(() => {});
            }
            // 그 외 에러는 claudeSessionId 보존 — 재시도에서 --resume 재사용해 컨텍스트 유지
            setTimeout(() => {
              try {
                const s = sessionsStore.get(sessionId);
                if (!s) return;
                const lastUser = [...(s.messages ?? [])].reverse().find((m) => m.role === 'user');
                if (!lastUser?.content) return;
                if (needsFreshStart) {
                  sendRunnerMessage(sessionId, lastUser.content, { claudeSessionId: null });
                } else {
                  sendRunnerMessage(sessionId, lastUser.content, { claudeSessionId: s.claudeSessionId });
                }
              } catch (retryErr) {
                logger.error({ retryErr, sessionId }, 'chat: auto-retry failed');
              }
            }, delay);
            return;
          }

          retryCounters.delete(sessionId);
          eventBus.publish('chat.error', { sessionId, error: err.message });
          sessionsStore.appendMessage(sessionId, {
            role: 'assistant',
            content: `⚠️ **응답 중단됨** — ${err.message}${counter.count >= maxForLabel ? `\n\n자동 복구를 ${counter.count}회 시도했지만 해결되지 않았습니다.` : '\n\n메시지를 다시 보내주세요.'}`
          }).catch(() => {});
          // 에러 시에도 claudeSessionId 보존 — 사용자 수동 재시도 시 --resume 재사용해 컨텍스트 유지
          if (delegationTracker) {
            const del = delegationTracker.getByTarget(sessionId);
            if (del) {
              const failed = delegationTracker.fail(sessionId, err.message);
              if (failed) ctx.dequeueNextAgent(failed.targetAgentId);
            }
          }
        },
        onExit({ code } = {}) {
          cleanupPermissionBridge();
          eventBus.publish('chat.exit', { sessionId, code });
          // Silent exit 감지: Claude CLI 가 exit 0 으로 나갔는데 응답 text 가 비어있음.
          // 과거엔 자동 재시도(3회) 했으나 — 같은 조건이면 무한히 반복되며
          // "(응답이 중단되었습니다)" + 같은 메시지 재전송 루프를 만들기만 함
          // (세션 파일 손상/컨텍스트 초과/모델 공백 응답 등은 재시도로 안 풀림).
          // 단 1회만 `--resume` 없이 fresh start 로 재시도 후, 실패하면
          // 사용자에게 진단 + 선택지를 제공하고 자동 재시도는 멈춤.
          if ((code === 0 || code === null) && !accumText.trim()) {
            const counter = retryCounters.get(sessionId) ?? { count: 0, lastError: '' };
            const session = sessionsStore.get(sessionId);
            const hadClaudeId = !!(session?.claudeSessionId || session?.claude_session_id);
            // 재시도는 hadClaudeId=true 일 때 1회만 (resume 을 꺼서 fresh start 로 전환)
            if (counter.count === 0 && hadClaudeId) {
              retryCounters.set(sessionId, { count: 1, lastError: 'silent_exit' });
              logger.warn({ sessionId, hadClaudeId }, 'chat: silent exit — retrying once as fresh session (no --resume)');
              sessionsStore.appendMessage(sessionId, {
                role: 'assistant',
                content: '🔄 **응답이 비어 있어 세션을 새로 열어 1회 재시도합니다** — 이전 대화 컨텍스트는 유지됩니다.'
              }).catch(() => {});
              sessionsStore.update(sessionId, { claudeSessionId: null, personaBakedInto: null }).catch(() => {});
              setTimeout(() => {
                try {
                  const s = sessionsStore.get(sessionId);
                  const msgs = s?.messages ?? [];
                  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
                  if (!lastUser?.content) return;
                  // fresh start (claudeSessionId=null) → sendRunnerMessage 내부 isFirstMsg 분기가
                  // 자동으로 conversation summary 를 prefix. 여기서 중복 prefix 하지 않는다.
                  sendRunnerMessage(sessionId, lastUser.content, { claudeSessionId: null });
                } catch (retryErr) {
                  logger.error({ retryErr, sessionId }, 'chat: silent-exit retry failed');
                }
              }, 2000);
              return;
            }
            // 재시도 실패 또는 처음부터 fresh session 이었던 경우 → 자동 재시도 중단 + 진단 안내
            retryCounters.delete(sessionId);
            logger.warn({ sessionId, retried: counter.count > 0 }, 'chat: silent exit — giving up auto-retry');
            sessionsStore.appendMessage(sessionId, {
              role: 'assistant',
              content:
                '⚠️ **응답이 비어 있습니다** — Claude CLI 가 텍스트 없이 종료했습니다.\n\n' +
                '원인 추측:\n' +
                '- Claude API / 외부 프록시(Z.AI 등)가 빈 응답을 반환\n' +
                '- 대화가 너무 길어 모델 컨텍스트 한도 초과\n' +
                '- --resume 대상 세션 파일 손상\n\n' +
                '**다음 조치 중 선택:** 같은 메시지를 다시 보내거나, 질문을 짧게 요약해 새 메시지로 시도하세요.\n' +
                '(자동 재시도는 중단됐습니다 — 무한 루프 방지)'
            }).catch(() => {});
          }
        }
      }
    });
    } catch (err) {
      cleanupPermissionBridge();
      eventBus.publish('chat.error', { sessionId, error: err.message });
      sessionsStore.appendMessage(sessionId, { role: 'assistant', content: `⚠️ 실행 실패 — ${err.message}` }).catch(() => {});
      eventBus.publish('chat.exit', { sessionId, code: -1 });
    }
  }

  return { sendRunnerMessage };
}
