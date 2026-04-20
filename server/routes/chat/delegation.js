import { logger } from '../../lib/logger.js';

/**
 * Creates delegation-related handlers. All cross-module calls (sendRunnerMessage)
 * are resolved lazily via ctx to allow circular wiring.
 */
export function createDelegation(ctx) {
  const {
    sessionsStore,
    configStore,
    runner,
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
    await Promise.all(
      parsed.map((p) =>
        executeDelegation(originSessionId, p.delegate.agent, p.delegate.task, JSON.stringify(p))
      )
    );
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
        logger.warn({ targetAgentIdRaw }, 'delegation: target agent not found');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⚠️ 위임 실패 — 에이전트 "${targetAgentIdRaw}"를 찾을 수 없습니다.`
        });
        return;
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
        loop: wantsLoop
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
      ctx.sendRunnerMessage(targetSession.id, fullTask);

      logger.info({
        id: entry.id,
        origin: originSessionId,
        target: targetSession.id,
        agent: targetAgentId,
        loop: wantsLoop
      }, 'delegation: task sent');
    } catch (err) {
      logger.error({ err, targetAgentId: targetAgentIdRaw }, 'delegation: execution failed');
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `❌ 위임 실패 — ${err.message}`
      });
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

    const promiseTag = `<promise>${loop.completionPromise}</promise>`;
    const completed = text.includes(promiseTag);

    const escalateMatch = text.match(/<escalate>([\s\S]*?)<\/escalate>/);
    const escalated = !!escalateMatch;
    const escalateReason = escalateMatch?.[1]?.trim() ?? '';

    if (completed || nextIter >= loop.maxIterations) {
      await sessionsStore.update(sessionId, { loop: null });
      eventBus.publish('session.loop.completed', {
        sessionId,
        iterations: nextIter,
        reason: completed ? 'promise' : 'max_iterations'
      });
      logger.info({ sessionId, iterations: nextIter, reason: completed ? 'promise' : 'max' }, 'ralph loop: completed');
    } else if (escalated) {
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter, paused: true, escalateReason }
      });
      await sessionsStore.appendMessage(sessionId, {
        role: 'assistant',
        content: `🚨 **Loop 에스컬레이션** (${nextIter}/${loop.maxIterations})\n\n**이유**: ${escalateReason}\n\n후속 지시를 보내주시면 Loop 가 재개됩니다.`
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
                `**문제**: ${escalateReason}\n\n` +
                `위임한 작업이 Ralph Loop 중 막혔습니다. 문제를 검토하고 사용자에게 상황을 설명한 뒤, 해결 방안 / 수정 지시 / 중단 중 선택지를 <choices> 로 제시해 주세요.`;
              await sessionsStore.appendMessage(originId, { role: 'user', content: trigger });
              ctx.sendRunnerMessage(originId, trigger);
            }
          } catch (err) {
            logger.warn({ err: err.message }, 'escalation → origin planner trigger failed');
          }
        }
      }
      eventBus.publish('session.loop.escalated', {
        sessionId,
        iteration: nextIter,
        reason: escalateReason
      });
      logger.info({ sessionId, iteration: nextIter, reason: escalateReason }, 'ralph loop: escalated');
    } else {
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
          const s = sessionsStore.get(sessionId);
          if (!s?.loop?.enabled || s.loop.paused) return;
          const iterLabel = `[Loop ${nextIter}/${loop.maxIterations}] ${loop.prompt}`;
          sessionsStore.appendMessage(sessionId, { role: 'user', content: iterLabel });
          ctx.sendRunnerMessage(sessionId, loop.prompt);
        } catch (err) {
          eventBus.publish('chat.error', { sessionId, error: `Loop failed: ${err.message}` });
        }
      }, 2000);
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
