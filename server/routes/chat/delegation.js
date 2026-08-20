import { logger } from '../../lib/logger.js';

/**
 * Hard ceiling on delegation chain length (planner → worker → sub-worker).
 * Without it a worker can re-delegate indefinitely; each hop multiplies token
 * spend and there is no natural termination condition.
 */
const MAX_DELEGATION_DEPTH = 3;

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
    reEntryCounters,
    MAX_REENTRY
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
    for (const p of parsed) {
      const res = await executeDelegation(originSessionId, p.delegate.agent, p.delegate.task, JSON.stringify(p));
      if (res?.badId) badIds.push(res);
      else if (res?.depthExceeded) depthBlocked.push(res);
    }
    if (badIds.length || depthBlocked.length) {
      await reportUndeliveredTasks(originSessionId, badIds, depthBlocked);
    }
  }

  /** 원 세션 에이전트와 같은 프로젝트에 속한 위임 가능 대상 ID 목록. */
  function listDelegateTargets(originSessionId) {
    const all = configStore.getAgents() || {};
    const originAgentId = sessionsStore.get(originSessionId)?.agentId ?? null;
    const myProj = originAgentId ? ctx.metadataStore?.getAgent(originAgentId)?.projectId ?? null : null;
    if (!myProj) return [];
    const out = [];
    for (const id of Object.keys(all)) {
      if (id === originAgentId) continue;
      if (ctx.metadataStore?.getAgent(id)?.projectId === myProj) out.push(id);
    }
    return out;
  }

  function formatTargets(ids) {
    if (!ids.length) return '- (같은 프로젝트에 다른 에이전트가 없습니다 — planner_office 등 범용 에이전트를 쓰세요)';
    return ids.map((id) => `- ${id}`).join('\n');
  }

  /**
   * 전달되지 못한 위임을 플래너에게 되돌려준다. 되먹임이 없으면 플래너는 실패를
   * 모른 채 턴을 끝내고 위임한 작업이 통째로 사라진다.
   */
  async function reportUndeliveredTasks(originSessionId, badIds, depthBlocked) {
    const count = (reEntryCounters.get(originSessionId) ?? 0) + 1;
    if (count > MAX_REENTRY) {
      logger.warn({ originSessionId, count }, 'delegation: retry limit exceeded — not re-entering');
      return;
    }
    reEntryCounters.set(originSessionId, count);

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

  async function executeDelegation(originSessionId, targetAgentIdRaw, task, rawText) {
    try {
      const targetAgentId = resolveAgentId(targetAgentIdRaw);
      if (!targetAgentId) {
        const targets = listDelegateTargets(originSessionId);
        logger.warn({ targetAgentIdRaw, candidates: targets.length }, 'delegation: target agent not found');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⚠️ 위임 실패 — 에이전트 \`${targetAgentIdRaw}\` 는 존재하지 않습니다. 올바른 ID 로 재시도합니다.\n\n**사용 가능한 에이전트**\n${formatTargets(targets)}`
        });
        return { badId: targetAgentIdRaw, task, targets };
      }

      const depth = delegationTracker.getChainDepth(originSessionId) + 1;
      if (depth > MAX_DELEGATION_DEPTH) {
        logger.warn({ originSessionId, targetAgentId, depth }, 'delegation: depth limit exceeded — refused');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⛔ **위임 거부 — 체인 깊이 한계** (${depth}/${MAX_DELEGATION_DEPTH}단계)\n\n**대상**: \`${targetAgentId}\`\n**작업**: ${task}\n\n이 작업은 전달되지 않았습니다. 직접 처리해야 합니다.`
        });
        return { depthExceeded: true, task, targetAgentId, depth };
      }

      if (delegationTracker && delegationTracker.isAgentBusy(targetAgentId)) {
        const agentQueue = ctx.agentQueue;
        if (!agentQueue.has(targetAgentId)) agentQueue.set(targetAgentId, []);
        const queue = agentQueue.get(targetAgentId);
        queue.push({ originSessionId, targetAgentId, task, rawText });
        const pos = queue.length;
        logger.info({ targetAgentId, queueLength: pos }, 'delegation: queued (agent busy)');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⏳ **위임 대기** — \`${targetAgentId}\`가 다른 작업을 처리 중입니다. 대기열 ${pos}번째에 추가됐습니다.\n\n**작업**: ${task}`
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
        depth
      });

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
        depth
      }, 'delegation: task sent');
    } catch (err) {
      logger.error({ err, targetAgentId: targetAgentIdRaw }, 'delegation: execution failed');
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `❌ 위임 실패 — ${err.message}`
      });
    }
  }

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
    executeDelegation,
    handleLoopContinuation
  };
}
