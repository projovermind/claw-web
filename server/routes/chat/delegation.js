import { logger } from '../../lib/logger.js';
import { buildRoster, listProjectAgentIds } from '../../lib/agent-roster.js';

/**
 * Hard ceiling on delegation chain length (planner → worker → sub-worker).
 * Without it a worker can re-delegate indefinitely; each hop multiplies token
 * spend and there is no natural termination condition.
 */
const MAX_DELEGATION_DEPTH = 3;

/**
 * 워커가 결과를 남기지 못한 채 사라지면(크래시, 외부 kill, 디스패치 유실) chat.done
 * 이 끝내 오지 않아 트래커는 영원히 running 으로 남는다. 플래너는 오지 않을 보고를
 * 기다리고 대상 에이전트는 계속 busy 로 잡힌다. 주기적으로 훑어 정리한다.
 */
const SWEEP_INTERVAL_MS = 60_000;
const STALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Creates delegation-related handlers. All cross-module calls (ctx.dispatch)
 * are resolved lazily via ctx to allow circular wiring.
 */
export function createDelegation(ctx) {
  const {
    sessionsStore,
    configStore,
    eventBus,
    delegationTracker,
    pushStore,
    failureReEntryCounters,
    MAX_FAILURE_REENTRY
  } = ctx;

  /** Parse text for JSON blocks containing a "delegate" key. */
  function extractDelegateJson(text) {
    const results = [];
    const seen = new Set();
    const candidates = [];
    const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const cb of codeBlocks) candidates.push(cb[1]);
    candidates.push(text);

    for (const src of candidates) {
      let idx = src.indexOf('"delegate"');
      while (idx !== -1) {
        let start = src.lastIndexOf('{', idx);
        if (start === -1) { idx = src.indexOf('"delegate"', idx + 1); continue; }
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
            if (obj?.delegate?.agent && obj?.delegate?.task) {
              const key = `${obj.delegate.agent}::${obj.delegate.task}`;
              if (!seen.has(key)) { seen.add(key); results.push(obj); }
            }
          } catch { /* ignore, try next */ }
        }
        idx = src.indexOf('"delegate"', idx + 1);
      }
    }
    return results;
  }

  async function handleDelegation(originSessionId, responseText) {
    if (!delegationTracker || !responseText) return;
    const parsed = extractDelegateJson(responseText);
    if (!parsed.length) return;
    const badIds = [];
    const depthBlocked = [];
    // 같은 턴에서 나온 위임 N(≥2)건은 하나의 그룹으로 묶어, 전원이 끝난 뒤
    // 한 턴으로 합쳐 보고한다. 단건이면 그룹 없이 기존대로 즉시 보고.
    const groupId = ctx.openDelegationGroup?.(originSessionId, parsed.length) ?? null;
    for (const p of parsed) {
      const res = await executeDelegation(originSessionId, p.delegate.agent, p.delegate.task, JSON.stringify(p), groupId);
      if (res?.badId) badIds.push(res);
      else if (res?.depthExceeded) depthBlocked.push(res);
    }
    if (badIds.length || depthBlocked.length) {
      await reportUndeliveredTasks(originSessionId, badIds, depthBlocked);
    }
  }

  /** 원 세션 에이전트와 같은 프로젝트에 속한 위임 가능 대상 ID 목록. */
  function listDelegateTargets(originSessionId) {
    const originAgentId = sessionsStore.get(originSessionId)?.agentId ?? null;
    return listProjectAgentIds({
      agents: configStore.getAgents() || {},
      metadataStore: ctx.metadataStore,
      projectId: originAgentId ? ctx.metadataStore?.getAgent(originAgentId)?.projectId ?? null : null,
      excludeAgentId: originAgentId,
    });
  }

  function formatTargets(ids) {
    return buildRoster(
      ids,
      configStore.getAgents() || {},
      '- (같은 프로젝트에 다른 에이전트가 없습니다 — planner_office 등 범용 에이전트를 쓰세요)'
    );
  }

  /**
   * 전달되지 못한 위임을 플래너에게 되돌려준다. 되먹임이 없으면 플래너는 실패를
   * 모른 채 턴을 끝내고 위임한 작업이 통째로 사라진다.
   */
  async function reportUndeliveredTasks(originSessionId, badIds, depthBlocked) {
    const count = (failureReEntryCounters.get(originSessionId) ?? 0) + 1;
    if (count > MAX_FAILURE_REENTRY) {
      logger.warn({ originSessionId, count }, 'delegation: retry limit exceeded — not re-entering');
      return;
    }
    failureReEntryCounters.set(originSessionId, count);

    const sections = [];
    if (badIds.length) {
      sections.push(
        `**존재하지 않는 에이전트 ID**\n\n` +
        badIds.map((f) => `- 요청한 ID: \`${f.badId}\` (존재하지 않음)\n  작업: ${f.task}`).join('\n') +
        `\n\n실제 사용 가능한 에이전트:\n${formatTargets(badIds[0].targets)}\n\n` +
        `목록에 있는 정확한 ID 로 위임 JSON 을 다시 출력하세요. 방금 쓴 잘못된 ID 를 다시 쓰지 마세요.`
      );
    }
    if (depthBlocked.length) {
      sections.push(
        `**위임 체인 깊이 한계(${MAX_DELEGATION_DEPTH}단계) 초과 — 재위임이 거부됨**\n\n` +
        depthBlocked.map((f) => `- 대상: \`${f.targetAgentId}\` (깊이 ${f.depth})\n  작업: ${f.task}`).join('\n') +
        `\n\n더 깊이 위임할 수 없습니다. 이 작업은 직접 처리하거나, 범위를 줄여 스스로 끝낸 뒤 결과를 보고하세요.`
      );
    }

    const trigger =
      `[위임 실패 — 아래 작업은 아무에게도 전달되지 않았습니다]\n\n` +
      sections.join('\n\n---\n\n') +
      `\n\n적합한 처리 방법이 없으면 위임을 반복하지 말고 사용자에게 상황을 알리세요.`;
    try {
      await sessionsStore.appendMessage(originSessionId, { role: 'user', content: trigger });
      ctx.dispatch(originSessionId, { kind: 'undelivered', content: trigger });
    } catch (err) {
      logger.warn({ err: err.message, originSessionId }, 'delegation: retry trigger send failed');
    }
  }

  /**
   * 에이전트가 동시에 소화할 수 있는 위임 수. config 의 maxConcurrent 가 없거나
   * 이상한 값이면 1 — 기존(한 번에 하나) 동작을 그대로 유지한다.
   */
  const MAX_CONCURRENT_CEILING = 10;
  function getMaxConcurrent(agentId) {
    const raw = configStore?.getAgent?.(agentId)?.maxConcurrent;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_CONCURRENT_CEILING, Math.max(1, Math.floor(n)));
  }

  /**
   * 지금 이 에이전트에게 위임을 하나 더 밀어 넣어도 되는가.
   * reserved — 대기열에서 이미 꺼냈지만 아직 트래커에 등록되지 않은 작업 수.
   * 드레인 중에는 이 예약분을 함께 세야 같은 슬롯을 두 번 꺼내지 않는다.
   */
  function hasAgentCapacity(agentId, reserved = 0) {
    if (!delegationTracker) return true;
    const activeNow = delegationTracker.activeCountForAgent
      ? delegationTracker.activeCountForAgent(agentId)
      : (delegationTracker.isAgentBusy(agentId) ? 1 : 0);
    return activeNow + reserved < getMaxConcurrent(agentId);
  }

  /** Normalize agent ID (cf.router → cf_router, case-insensitive). */
  function resolveAgentId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (configStore.getAgent(trimmed)) return trimmed;
    const normalized = trimmed.replace(/[.\-/\s]+/g, '_');
    if (configStore.getAgent(normalized)) return normalized;
    const dotted = trimmed.replace(/_/g, '.');
    if (configStore.getAgent(dotted)) return dotted;
    const all = configStore.getAgents() || {};
    const lowerNorm = normalized.toLowerCase();
    for (const id of Object.keys(all)) {
      const idNorm = id.replace(/[.\-/\s]+/g, '_').toLowerCase();
      if (idNorm === lowerNorm) return id;
    }
    return null;
  }

  async function executeDelegation(originSessionId, targetAgentIdRaw, task, rawText, groupId = null, queuedAt = null) {
    // 그룹 슬롯은 정확히 한 번만 소비돼야 한다 — 등록(attach) 뒤에 예외가 나면
    // 취소(drop)까지 겹쳐 배리어가 형제들을 기다리지 않고 먼저 닫힌다.
    let attached = false;
    // 발주가 접수된 시각. 대기열을 거쳐 재진입한 경우 호출자가 원래 시각을 넘겨주므로
    // 그 값을 유지해야 큐에서 흘려버린 시간이 실행 시간에 섞이지 않는다.
    const acceptedAt = queuedAt ?? new Date().toISOString();
    try {
      const targetAgentId = resolveAgentId(targetAgentIdRaw);
      if (!targetAgentId) {
        const targets = listDelegateTargets(originSessionId);
        logger.warn({ targetAgentIdRaw, candidates: targets.length }, 'delegation: target agent not found');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⚠️ 위임 실패 — 에이전트 \`${targetAgentIdRaw}\` 는 존재하지 않습니다. 올바른 ID 로 재시도합니다.\n\n**사용 가능한 에이전트**\n${formatTargets(targets)}`
        });
        ctx.dropGroupSlot?.(groupId, 'unknown-agent');
        return { badId: targetAgentIdRaw, task, targets };
      }

      const depth = delegationTracker.getChainDepth(originSessionId) + 1;
      if (depth > MAX_DELEGATION_DEPTH) {
        logger.warn({ originSessionId, targetAgentId, depth }, 'delegation: depth limit exceeded — refused');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⛔ **위임 거부 — 체인 깊이 한계** (${depth}/${MAX_DELEGATION_DEPTH}단계)\n\n**대상**: \`${targetAgentId}\`\n**작업**: ${task}\n\n이 작업은 전달되지 않았습니다. 직접 처리해야 합니다.`
        });
        ctx.dropGroupSlot?.(groupId, 'depth-exceeded');
        return { depthExceeded: true, task, targetAgentId, depth };
      }

      if (!hasAgentCapacity(targetAgentId)) {
        const max = getMaxConcurrent(targetAgentId);
        const agentQueue = ctx.agentQueue;
        if (!agentQueue.has(targetAgentId)) agentQueue.set(targetAgentId, []);
        const queue = agentQueue.get(targetAgentId);
        queue.push({ originSessionId, targetAgentId, task, rawText, groupId, queuedAt: acceptedAt });
        delegationTracker.setPendingQueue?.(agentQueue);
        const pos = queue.length;
        logger.info({ targetAgentId, queueLength: pos, max }, 'delegation: queued (agent at capacity)');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⏳ **위임 대기** — \`${targetAgentId}\`가 동시 처리 한도(${max})에 도달했습니다. 대기열 ${pos}번째에 추가됐습니다.\n\n**작업**: ${task}`
        });
        return;
      }

      const wantsLoop = /"loop"\s*:\s*true/.test(rawText);

      const targetSession = await sessionsStore.create({
        agentId: targetAgentId,
        title: `[위임] ${task.slice(0, 40)}`,
        isDelegation: true
      });
      eventBus.publish('session.created', { session: targetSession });

      const entry = delegationTracker.create({
        originSessionId,
        targetSessionId: targetSession.id,
        targetAgentId,
        task,
        loop: wantsLoop,
        depth,
        groupId,
        queuedAt: acceptedAt
      });
      attached = ctx.attachGroupMember?.(groupId, entry) ?? false;

      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `🔄 **위임 시작** — ${targetAgentId}에게 작업을 전달했습니다.\n\n**작업**: ${task}\n**세션**: ${targetSession.id}${wantsLoop ? '\n**모드**: Ralph Loop (자동 반복)' : ''}`
      });
      eventBus.publish('delegation.started', {
        id: entry.id,
        originSessionId,
        targetSessionId: targetSession.id,
        targetAgentId,
        task,
        groupId,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        queueMs: entry.queueMs
      });

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

      const fullTask = wantsLoop
        ? `${task}\n\n완료되면 <promise>DONE</promise>을 출력하세요. 도움이 필요하면 <escalate>이유</escalate>를 출력하세요.`
        : task;
      await sessionsStore.appendMessage(targetSession.id, { role: 'user', content: fullTask });
      ctx.dispatch(targetSession.id, { kind: 'task', content: fullTask });

      logger.info({
        id: entry.id,
        origin: originSessionId,
        target: targetSession.id,
        agent: targetAgentId,
        loop: wantsLoop,
        taskLength: task.length,
        depth,
        queueMs: entry.queueMs
      }, 'delegation: task sent');
    } catch (err) {
      // 등록까지 마친 뒤 터졌다면 멤버는 이미 트래커에 있다 — 스톨 스윕이
      // 중단 처리하면서 그때 그룹에 결과가 들어간다.
      if (!attached) ctx.dropGroupSlot?.(groupId, 'dispatch-error');
      logger.error({ err, targetAgentId: targetAgentIdRaw }, 'delegation: execution failed');
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `❌ 위임 실패 — ${err.message}`
      });
    }
  }

  /**
   * 위임 대상 세션이 결과를 내지 못한 채 멈췄을 때(사용자 중단 / 세션 삭제 /
   * 빈 응답으로 자동 재시도 포기) 트래커를 정리한다. 이걸 안 하면 대상 에이전트가
   * 영원히 busy 로 남아 이후 위임이 전부 대기열에 쌓이고, 플래너는 오지 않을
   * 보고를 기다리며 턴을 끝낸다.
   */
  async function abandonDelegation(targetSessionId, reason) {
    if (!delegationTracker) return null;
    try {
      if (!delegationTracker.getByTarget(targetSessionId)) return null;
      const failed = delegationTracker.fail(targetSessionId, reason);
      if (!failed) return null;
      ctx.dequeueNextAgent(failed.targetAgentId);

      const body =
        `**작업**: ${failed.task}\n` +
        `**사유**: ${reason}\n\n` +
        `이 작업은 완료되지 않았습니다.`;
      // 같은 턴에 함께 발주된 위임이면 형제들이 끝날 때까지 보고를 모아 둔다.
      const held = ctx.collectGroupReport?.(failed, { status: 'aborted', body }) ?? false;
      if (!held) {
        const trigger =
          `[위임 중단]\n\n` +
          `**대상**: ${failed.targetAgentId}\n` +
          body + `\n\n` +
          `직접 처리할지, 다른 에이전트에게 다시 위임할지, 사용자에게 상황을 알릴지 판단해 계속 진행하세요.`;
        await sessionsStore.appendMessage(failed.originSessionId, { role: 'user', content: trigger });
        ctx.dispatch(failed.originSessionId, { kind: 'report', content: trigger });
      }
      logger.info(
        { id: failed.id, targetSessionId, targetAgentId: failed.targetAgentId, reason },
        'delegation: abandoned — tracker released, planner resumed'
      );
      return failed;
    } catch (err) {
      logger.warn({ err: err.message, targetSessionId, reason }, 'delegation: abandon cleanup failed');
      return null;
    }
  }

  /**
   * 위임이 마지막으로 살아 있었던 시각. 러너의 lastActivity 는 프로세스가 끝나면
   * 지워지므로, 세션 updatedAt 과 생성 시각까지 함께 보고 가장 최근 것을 쓴다.
   */
  function lastActivityMs(entry) {
    const stamps = [Date.parse(entry.createdAt)];
    const fromRunner = ctx.runner?.lastActivityAt?.(entry.targetSessionId);
    if (fromRunner) stamps.push(fromRunner);
    const updatedAt = sessionsStore.get(entry.targetSessionId)?.updatedAt;
    if (updatedAt) stamps.push(Date.parse(updatedAt));
    return Math.max(0, ...stamps.filter(Number.isFinite));
  }

  /** running 인데 러너도 없고 한참 조용한 위임을 중단 처리한다. */
  async function sweepStalledDelegations() {
    if (!delegationTracker) return;
    const now = Date.now();
    for (const entry of delegationTracker.list()) {
      if (entry.status !== 'running') continue;
      // 러너가 살아 있거나 디스패치 큐에서 차례를 기다리는 중이면 정상 작동이다.
      if (ctx.isSessionBusy?.(entry.targetSessionId)) continue;
      const idleMs = now - lastActivityMs(entry);
      if (idleMs < STALL_TIMEOUT_MS) continue;
      const idleMinutes = Math.floor(idleMs / 60_000);
      logger.warn(
        { id: entry.id, targetSessionId: entry.targetSessionId, targetAgentId: entry.targetAgentId, idleMinutes },
        'delegation: stalled worker detected by sweep'
      );
      await abandonDelegation(
        entry.targetSessionId,
        `응답 없이 중단됨 (워커 프로세스 없음, ${idleMinutes}분간 활동 없음)`
      );
    }
  }

  const sweepTimer = setInterval(() => {
    sweepStalledDelegations().catch((err) => {
      logger.warn({ err: err.message }, 'delegation: sweep failed');
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  /** Escape special regex characters in a string. */
  function escapeForRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Queue the next loop iteration. The loop guard is re-evaluated at dequeue
   * time, not just here — otherwise an iteration queued behind a long turn would
   * still fire after the user stopped or escalated the loop.
   */
  async function sendLoopIteration(sessionId, prompt) {
    const loopStillActive = () => {
      const s = sessionsStore.get(sessionId);
      return !!s?.loop?.enabled && !s.loop.paused;
    };
    if (!loopStillActive()) return;
    try {
      await sessionsStore.appendMessage(sessionId, { role: 'user', content: prompt });
      ctx.dispatch(sessionId, { kind: 'loop', content: prompt, guard: loopStillActive });
    } catch (err) {
      eventBus.publish('chat.error', { sessionId, error: `Loop failed: ${err.message}` });
    }
  }

  /**
   * Ralph Loop continuation — after each assistant response, decide:
   * continue, complete, or escalate.
   */
  async function handleLoopContinuation(sessionId, responseText) {
    const session = sessionsStore.get(sessionId);
    const loop = session?.loop;
    if (!loop?.enabled || loop.paused) return;

    const text = responseText ?? '';
    const nextIter = (loop.currentIteration ?? 0) + 1;

    // (1) 완료/에스컬레이트 판정: 정규식으로 관대하게 (공백 허용, 대소문자 무관)
    const completionRegex = new RegExp(
      `<promise>\\s*${escapeForRegex(loop.completionPromise)}\\s*<\\/promise>`,
      'i'
    );
    const completed = completionRegex.test(text);

    const escalateMatch = text.match(/<escalate>([\s\S]*?)<\/escalate>/i);
    const escalated = !!escalateMatch;
    const escalateReason = escalateMatch?.[1]?.trim() ?? '';

    // (3) 진전 없음 감지: 최근 3개 응답이 길이차 10% 이내 + 첫 200자 동일이면 자동 에스컬레이트
    const recentResponses = [...(loop.recentResponses ?? []), text].slice(-3);
    let stagnated = false;
    if (!completed && !escalated && recentResponses.length >= 3) {
      const similar = (a, b) => {
        const maxLen = Math.max(a.length, b.length, 1);
        return (
          Math.abs(a.length - b.length) / maxLen <= 0.1 &&
          a.slice(0, 200) === b.slice(0, 200)
        );
      };
      const [r1, r2, r3] = recentResponses;
      if (similar(r1, r2) && similar(r2, r3)) stagnated = true;
    }

    if (completed || nextIter >= loop.maxIterations) {
      await sessionsStore.update(sessionId, { loop: null });
      eventBus.publish('session.loop.completed', {
        sessionId,
        iterations: nextIter,
        reason: completed ? 'promise' : 'max_iterations'
      });
      logger.info({ sessionId, iterations: nextIter, reason: completed ? 'promise' : 'max' }, 'ralph loop: completed');
    } else if (escalated || stagnated) {
      const reason = stagnated ? '진전 없음 감지' : escalateReason;
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter, paused: true, escalateReason: reason, recentResponses }
      });
      await sessionsStore.appendMessage(sessionId, {
        role: 'assistant',
        content: `🚨 **Loop 에스컬레이션** (${nextIter}/${loop.maxIterations})\n\n**이유**: ${reason}\n\n후속 지시를 보내주시면 Loop 가 재개됩니다.`
      }).catch(() => {});
      if (delegationTracker) {
        const del = delegationTracker.getByTarget(sessionId);
        if (del) {
          try {
            const originId = del.originSessionId;
            const origin = sessionsStore.get(originId);
            const msgs = origin?.messages ?? [];
            const recentTrigger = msgs.slice(-4).some((m) =>
              m?.role === 'user' && (m.content || '').startsWith('[위임 에스컬레이션]')
            );
            if (!recentTrigger) {
              const trigger =
                `[위임 에스컬레이션]\n\n` +
                `**대상**: ${del.targetAgentId}\n` +
                `**작업**: ${del.task}\n` +
                `**문제**: ${reason}\n\n` +
                `위임한 작업이 Ralph Loop 중 막혔습니다. 문제를 검토하고 사용자에게 상황을 설명한 뒤, 해결 방안 / 수정 지시 / 중단 중 선택지를 <choices> 로 제시해 주세요.`;
              await sessionsStore.appendMessage(originId, { role: 'user', content: trigger });
              ctx.dispatch(originId, { kind: 'escalation', content: trigger });
            }
          } catch (err) {
            logger.warn({ err: err.message }, 'escalation → origin planner trigger failed');
          }
        }
      }
      eventBus.publish('session.loop.escalated', {
        sessionId,
        iteration: nextIter,
        reason
      });
      logger.info({ sessionId, iteration: nextIter, reason }, 'ralph loop: escalated');
    } else {
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter, recentResponses }
      });
      eventBus.publish('session.loop.iteration', {
        sessionId,
        iteration: nextIter,
        maxIterations: loop.maxIterations
      });
      logger.info({ sessionId, iteration: nextIter, max: loop.maxIterations }, 'ralph loop: next iteration');

      // (2) 재전송 프롬프트: 진행상황 검토 규칙 항상 포함
      const rule = `[Loop ${nextIter}/${loop.maxIterations}] 이전까지 진행상황 검토 후 남은 작업만 수행. 완료 시 <promise>DONE</promise>, 막히면 <escalate>이유</escalate> 반드시 출력`;
      sendLoopIteration(sessionId, `${rule}\n\n${loop.prompt}`);
    }
  }

  return {
    extractDelegateJson,
    handleDelegation,
    resolveAgentId,
    getMaxConcurrent,
    hasAgentCapacity,
    executeDelegation,
    abandonDelegation,
    sweepStalledDelegations,
    handleLoopContinuation
  };
}
