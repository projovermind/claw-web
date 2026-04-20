import { logger } from '../../lib/logger.js';
import { buildCarlContext } from '../../lib/carl-injector.js';
import { buildBaseContext } from '../../lib/base-reader.js';
import { buildPaulContext } from '../../lib/paul-reader.js';
import { classifyError, resolveAgent } from './utils.js';

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
    runner,
    eventBus,
    delegationTracker,
    pushStore,
    webConfig,
    retryCounters,
    MAX_AUTO_RETRIES
  } = ctx;

  function sendRunnerMessage(sessionId, message, { claudeSessionId } = {}) {
    const session = sessionsStore.get(sessionId);
    if (!session) return;
    const resolved = resolveAgent(session.agentId, {
      configStore, metadataStore, projectsStore, backendsStore, skillsStore, systemSkillsStore
    });
    if (!resolved) return;
    const { agent, envOverrides, backendType, backendConfig } = resolved;

    // ── 프레임워크 자동 주입 ──
    const isFirstMsg = !session.messages?.length || session.messages.length <= 1;
    if (isFirstMsg) {
      const baseCtx = buildBaseContext(agent.workingDir);
      if (baseCtx) agent.baseContext = baseCtx;

      const agentMeta = metadataStore?.getAgent(session.agentId);
      if (agentMeta?.projectId && projectsStore) {
        const proj = projectsStore.getById(agentMeta.projectId);
        const memory = proj?.dashboard?.memory?.trim();
        if (memory) agent.projectMemory = memory;
      }
    }
    const carlContext = buildCarlContext(agent.workingDir, message);
    if (carlContext) agent.carlContext = carlContext;
    const paulCtx = buildPaulContext(agent.workingDir);
    if (paulCtx) agent.paulContext = paulCtx;

    // 대시보드 API 안내: 프로젝트 소속 에이전트에게 대시보드 조작 방법 주입
    const isWorkerSession = session.isDelegation === true;
    const meta = metadataStore?.getAgent(session.agentId);
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
        async onResult(result) {
          retryCounters.delete(sessionId);
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

          if (canRetry && counter.count < MAX_AUTO_RETRIES) {
            const attempt = counter.count + 1;
            retryCounters.set(sessionId, { count: attempt, lastError: err.message });
            logger.warn({ sessionId, label, attempt, delay }, 'chat: auto-recovery scheduled');
            sessionsStore.appendMessage(sessionId, {
              role: 'assistant',
              content: `🔄 **자동 복구 중** (${attempt}/${MAX_AUTO_RETRIES}) — \`${label}\` 오류 감지. ${delay >= 1000 ? `${delay / 1000}초 후 재시도합니다...` : '즉시 재시도합니다...'}`
            }).catch(() => {});
            eventBus.publish('chat.error', { sessionId, error: `[auto-retry ${attempt}/${MAX_AUTO_RETRIES}] ${err.message}` });
            sessionsStore.update(sessionId, { claudeSessionId: null }).catch(() => {});
            setTimeout(() => {
              try {
                const s = sessionsStore.get(sessionId);
                if (!s) return;
                const lastUser = [...(s.messages ?? [])].reverse().find((m) => m.role === 'user');
                if (lastUser?.content) {
                  sendRunnerMessage(sessionId, lastUser.content);
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
            content: `⚠️ **응답 중단됨** — ${err.message}${counter.count >= MAX_AUTO_RETRIES ? `\n\n자동 복구를 ${MAX_AUTO_RETRIES}회 시도했지만 해결되지 않았습니다.` : '\n\n메시지를 다시 보내주세요.'}`
          }).catch(() => {});
          if (session.claudeSessionId) {
            logger.warn({ sessionId, err: err.message }, 'chat: clearing claudeSessionId on error (auto-recovery)');
            sessionsStore.update(sessionId, { claudeSessionId: null }).catch(() => {});
          }
          if (delegationTracker) {
            const del = delegationTracker.getByTarget(sessionId);
            if (del) {
              const failed = delegationTracker.fail(sessionId, err.message);
              if (failed) ctx.dequeueNextAgent(failed.targetAgentId);
            }
          }
        },
        onExit({ code } = {}) {
          eventBus.publish('chat.exit', { sessionId, code });
          if ((code === 0 || code === null) && !accumText.trim()) {
            const counter = retryCounters.get(sessionId) ?? { count: 0, lastError: '' };
            if (counter.count < MAX_AUTO_RETRIES) {
              const attempt = counter.count + 1;
              retryCounters.set(sessionId, { count: attempt, lastError: 'silent_exit' });
              logger.warn({ sessionId, attempt }, 'chat: silent exit detected, auto-retry');
              sessionsStore.appendMessage(sessionId, {
                role: 'assistant',
                content: `🔄 **자동 복구 중** (${attempt}/${MAX_AUTO_RETRIES}) — 응답 없이 종료 감지. 재시도합니다...`
              }).catch(() => {});
              sessionsStore.update(sessionId, { claudeSessionId: null }).catch(() => {});
              setTimeout(() => {
                try {
                  const s = sessionsStore.get(sessionId);
                  const lastUser = [...(s?.messages ?? [])].reverse().find((m) => m.role === 'user');
                  if (lastUser?.content) sendRunnerMessage(sessionId, lastUser.content);
                } catch (retryErr) {
                  logger.error({ retryErr, sessionId }, 'chat: silent-exit retry failed');
                }
              }, 2000);
            } else {
              retryCounters.delete(sessionId);
              sessionsStore.appendMessage(sessionId, {
                role: 'assistant',
                content: `⚠️ **응답이 비어있습니다** — runner 가 응답 없이 종료됐고, 자동 복구에도 실패했습니다. 다시 시도해 주세요.`
              }).catch(() => {});
            }
          }
        }
      }
    });
    } catch (err) {
      eventBus.publish('chat.error', { sessionId, error: err.message });
      sessionsStore.appendMessage(sessionId, { role: 'assistant', content: `⚠️ 실행 실패 — ${err.message}` }).catch(() => {});
      eventBus.publish('chat.exit', { sessionId, code: -1 });
    }
  }

  return { sendRunnerMessage };
}
