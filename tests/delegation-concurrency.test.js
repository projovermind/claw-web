import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createEventBus } from '../server/lib/event-bus.js';

/**
 * 위임 동시 실행 상한(agent.maxConcurrent)의 회귀 테스트.
 * 상한 이하는 즉시 실행, 초과분은 agentQueue 에서 대기하다 슬롯이 비면 풀린다.
 */

let dir;
let ctx;
let agents;
let sessionSeq;

function makeCtx() {
  sessionSeq = 0;
  agents = { solo: { name: 'solo' }, wide: { name: 'wide', maxConcurrent: 3 } };

  const messages = [];
  const base = {
    sessionsStore: {
      create: async ({ agentId }) => ({ id: `sess_${++sessionSeq}`, agentId }),
      appendMessage: async (sessionId, msg) => { messages.push({ sessionId, ...msg }); },
      update: async () => {},
      getById: () => null
    },
    configStore: {
      getAgent: (id) => agents[id] ?? null,
      getAgents: () => agents
    },
    metadataStore: { getAgent: () => ({}) },
    eventBus: createEventBus(),
    delegationTracker: createDelegationTracker({
      filePath: path.join(dir, 'delegations.json'),
      reportsDir: path.join(dir, 'reports')
    }),
    pushStore: null,
    failureReEntryCounters: new Map(),
    MAX_FAILURE_REENTRY: 1,
    dispatch: vi.fn(),
    messages
  };
  const queue = createQueue(base);
  Object.assign(base, queue);
  base.delegationTracker.setPendingQueue(queue.agentQueue);
  Object.assign(base, createDelegation(base));
  return base;
}

const delegate = (agentId, task) => ctx.executeDelegation('lead', agentId, task, '{}');
const queued = (agentId) => ctx.agentQueue.get(agentId)?.length ?? 0;
const lastQueueMessage = () => [...ctx.messages].reverse().find((m) => m.content.includes('위임 대기'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-conc-'));
  ctx = makeCtx();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent maxConcurrent', () => {
  it('defaults to 1 when the agent has no setting (previous behaviour)', async () => {
    expect(ctx.getMaxConcurrent('solo')).toBe(1);

    await delegate('solo', 'A');
    expect(ctx.delegationTracker.activeCountForAgent('solo')).toBe(1);

    await delegate('solo', 'B');
    expect(ctx.delegationTracker.activeCountForAgent('solo')).toBe(1);
    expect(queued('solo')).toBe(1);
    expect(lastQueueMessage().content).toContain('동시 처리 한도(1)');
  });

  it('runs up to maxConcurrent in parallel and queues the rest', async () => {
    expect(ctx.getMaxConcurrent('wide')).toBe(3);

    for (const t of ['A', 'B', 'C']) await delegate('wide', t);
    expect(ctx.delegationTracker.activeCountForAgent('wide')).toBe(3);
    expect(queued('wide')).toBe(0);
    expect(ctx.dispatch).toHaveBeenCalledTimes(3);

    await delegate('wide', 'D');
    expect(ctx.delegationTracker.activeCountForAgent('wide')).toBe(3);
    expect(queued('wide')).toBe(1);
    expect(lastQueueMessage().content).toContain('동시 처리 한도(3)');
  });

  it('releases queued tasks as slots free up, in FIFO order', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B', 'C', 'D', 'E']) await delegate('wide', t);
    expect(queued('wide')).toBe(2); // D, E

    // 두 개가 끝났으니 두 개가 풀려야 한다 — 그 이상은 안 된다.
    ctx.delegationTracker.complete('sess_1', 'done');
    ctx.dequeueNextAgent('wide');
    ctx.delegationTracker.fail('sess_2', 'boom');
    ctx.dequeueNextAgent('wide');

    await vi.advanceTimersByTimeAsync(600);
    expect(queued('wide')).toBe(0);
    expect(ctx.delegationTracker.activeCountForAgent('wide')).toBe(3);

    const started = ctx.dispatch.mock.calls.map((c) => c[1].content);
    expect(started).toEqual(['A', 'B', 'C', 'D', 'E']); // 대기열은 뒤로 밀리지 않는다
  });

  it('keeps the queue intact when a completion still leaves the agent at capacity', async () => {
    vi.useFakeTimers();
    agents.wide.maxConcurrent = 2;
    for (const t of ['A', 'B', 'C']) await delegate('wide', t);
    expect(queued('wide')).toBe(1);

    // 슬롯을 비우지 않은 채 dequeue 가 불리면(중복 호출 등) 대기열이 그대로여야 한다.
    ctx.dequeueNextAgent('wide');
    await vi.advanceTimersByTimeAsync(600);
    expect(queued('wide')).toBe(1);
    expect(ctx.dispatch).toHaveBeenCalledTimes(2);
  });

  it('drains every free slot on one dequeue, not just one task', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B', 'C', 'D', 'E']) await delegate('wide', t);
    expect(queued('wide')).toBe(2); // D, E

    // 두 슬롯이 한꺼번에 비었는데 dequeue 는 한 번만 불린다(스윕/중단 정리 등).
    // 이때 한 건만 꺼내면 backlog 가 남아 동시 실행이 한도 아래에 머문다.
    ctx.delegationTracker.complete('sess_1', 'done');
    ctx.delegationTracker.complete('sess_2', 'done');
    expect(ctx.dequeueNextAgent('wide')).toBe(2);

    await vi.advanceTimersByTimeAsync(600);
    expect(queued('wide')).toBe(0);
    expect(ctx.delegationTracker.activeCountForAgent('wide')).toBe(3);
    expect(ctx.dispatch.mock.calls.map((c) => c[1].content)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('does not double-pop the same slot when dequeue is called repeatedly', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B', 'C', 'D', 'E']) await delegate('wide', t);

    // 슬롯은 하나만 비었는데 여러 경로에서 dequeue 가 불린다. 꺼냈지만 아직 실행
    // 전인 작업(inFlight)을 세지 않으면 D, E 가 둘 다 튀어나가 한도를 넘긴다.
    ctx.delegationTracker.complete('sess_1', 'done');
    expect(ctx.dequeueNextAgent('wide')).toBe(1);
    expect(ctx.dequeueNextAgent('wide')).toBe(0);
    expect(ctx.dequeueNextAgent('wide')).toBe(0);
    expect(queued('wide')).toBe(1); // E 는 남아 있다

    await vi.advanceTimersByTimeAsync(600);
    expect(ctx.delegationTracker.activeCountForAgent('wide')).toBe(3);
    expect(ctx.dispatch.mock.calls.map((c) => c[1].content)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('drains the backlog immediately when maxConcurrent is raised', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B', 'C']) await delegate('solo', t);
    expect(ctx.delegationTracker.activeCountForAgent('solo')).toBe(1);
    expect(queued('solo')).toBe(2); // B, C

    // agents PATCH 가 발행하는 이벤트. 상향분만큼 대기열이 바로 풀려야 한다 —
    // 다음 완료를 기다리면 상향이 사실상 무효가 된다.
    agents.solo.maxConcurrent = 3;
    ctx.eventBus.publish('agent.updated', { agentId: 'solo', patch: { maxConcurrent: 3 } });

    await vi.advanceTimersByTimeAsync(600);
    expect(queued('solo')).toBe(0);
    expect(ctx.delegationTracker.activeCountForAgent('solo')).toBe(3);
    expect(ctx.dispatch.mock.calls.map((c) => c[1].content)).toEqual(['A', 'B', 'C']);
  });

  it('ignores agent.updated events that do not touch maxConcurrent', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B']) await delegate('solo', t);
    expect(queued('solo')).toBe(1);

    ctx.eventBus.publish('agent.updated', { agentId: 'solo', patch: { name: 'renamed' } });
    await vi.advanceTimersByTimeAsync(600);
    expect(queued('solo')).toBe(1);
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
  });

  it('clamps out-of-range and non-numeric settings to a usable limit', () => {
    for (const [value, expected] of [[0, 1], [-4, 1], [99, 10], [2.7, 2], ['3', 3], [null, 1], ['abc', 1], [undefined, 1]]) {
      agents.solo.maxConcurrent = value;
      expect(ctx.getMaxConcurrent('solo'), String(value)).toBe(expected);
    }
  });
});
