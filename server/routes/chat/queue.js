import { logger } from '../../lib/logger.js';

/** 꺼낸 작업이 실제로 실행되기까지의 유예 — 완료 이벤트가 정리될 시간을 준다. */
const START_DELAY_MS = 500;

/**
 * Agent-level delegation queue: holds tasks aimed at an agent that is already
 * busy with another delegation. Distinct from the per-session dispatch queue
 * (dispatch.js), which serializes turns within one session.
 * Cross-module calls (executeDelegation) are resolved lazily via ctx.
 */
export function createQueue(ctx) {
  // agentId → pending delegation entries (when agent is busy)
  const agentQueue = new Map();
  // agentId → 꺼냈지만 아직 executeDelegation 이 트래커에 등록하지 않은 작업 수.
  // 이 예약분을 세지 않으면 같은 빈 슬롯을 여러 번 꺼내 순서가 뒤집힌다.
  const inFlight = new Map();

  function reserve(agentId, delta) {
    const next = (inFlight.get(agentId) ?? 0) + delta;
    if (next > 0) inFlight.set(agentId, next);
    else inFlight.delete(agentId);
  }

  function hasFreeSlot(agentId) {
    if (!ctx.hasAgentCapacity) return true;
    return ctx.hasAgentCapacity(agentId, inFlight.get(agentId) ?? 0);
  }

  function startLater(agentId, next) {
    setTimeout(() => {
      // executeDelegation 은 async — 타이머 콜백에서 reject 되면 unhandledRejection 이다.
      Promise.resolve(
        ctx.executeDelegation(next.originSessionId, next.targetAgentId, next.task, next.rawText, next.groupId ?? null)
      )
        .catch((err) =>
          logger.warn({ err: err?.message, agentId }, 'delegation: dequeued execution failed')
        )
        .finally(() => {
          reserve(agentId, -1);
          // 슬롯 상태가 확정됐다 — 남은 backlog 를 이어서 드레인한다. 한 번에 한 건만
          // 꺼내면 여유 슬롯이 있어도 완료 1건당 1건씩만 풀려 동시성이 1에 머문다.
          dequeueNextAgent(agentId);
        });
    }, START_DELAY_MS);
  }

  /**
   * 대기열에서 지금 실행 가능한 만큼 꺼낸다. FIFO 를 유지하며, 한도를 넘겨 꺼내지
   * 않는다(중복 pop 금지). 여유 슬롯이 없으면 대기열은 그대로 둔다.
   */
  function dequeueNextAgent(agentId) {
    const queue = agentQueue.get(agentId);
    if (!queue || queue.length === 0) return 0;

    let released = 0;
    while (queue.length > 0 && hasFreeSlot(agentId)) {
      const next = queue.shift();
      reserve(agentId, 1);
      released++;
      startLater(agentId, next);
    }

    if (!released) {
      logger.info({ agentId, waiting: queue.length }, 'delegation: still at capacity — keeping queue');
      return 0;
    }

    if (queue.length === 0) agentQueue.delete(agentId);
    // 재시작 복구가 이미 꺼내간 작업을 다시 보고하지 않도록 즉시 반영.
    ctx.delegationTracker?.setPendingQueue?.(agentQueue);
    logger.info(
      { agentId, released, remaining: agentQueue.get(agentId)?.length ?? 0 },
      'delegation: dequeuing next task(s)'
    );
    return released;
  }

  // maxConcurrent 를 올려도 다음 완료 때까지 대기열이 묶여 있으면 상향의 의미가
  // 없다. 설정이 바뀌는 즉시 늘어난 슬롯만큼 드레인한다.
  const unsubscribe = ctx.eventBus?.subscribe?.((evt) => {
    if (evt?.topic !== 'agent.updated') return;
    const { agentId, patch } = evt.payload ?? {};
    if (!agentId || patch?.maxConcurrent === undefined) return;
    try {
      const released = dequeueNextAgent(agentId);
      if (released) {
        logger.info({ agentId, released, maxConcurrent: patch.maxConcurrent }, 'delegation: queue drained after limit change');
      }
    } catch (err) {
      logger.warn({ err: err?.message, agentId }, 'delegation: drain on limit change failed');
    }
  });

  return { agentQueue, dequeueNextAgent, stopQueue: unsubscribe };
}
