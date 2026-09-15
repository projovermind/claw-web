import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createWorkerPool, REUSE_TASK_PREFIX } from '../server/routes/chat/worker-pool.js';
import { createEventBus } from '../server/lib/event-bus.js';

/**
 * 워커 세션 재사용 회귀 테스트.
 *
 * 재사용이 없던 시절 위임 한 건 = 워커 세션 한 개 = 콜드스타트 한 번이었다
 * (36시간에 300회). 여기서는 (1) 같은 플래너→같은 에이전트면 직전 세션에 붙는지,
 * (2) 붙으면 안 되는 조건에서 확실히 새 세션으로 도는지를 고정한다.
 */

let dir;
let ctx;
let sessionSeq;
let clock;
let busy;

function makeCtx(chatConfig = {}) {
  sessionSeq = 0;
  clock = 1_700_000_000_000;
  busy = new Set();
  const sessions = new Map();
  const agents = { worker: { name: 'worker' }, other: { name: 'other' }, wide: { name: 'wide', maxConcurrent: 2 } };

  const base = {
    now: () => clock,
    sessions,
    sessionsStore: {
      create: async ({ agentId, title, ...extra }) => {
        const s = { id: `sess_${++sessionSeq}`, agentId, title, messages: [], ...extra };
        sessions.set(s.id, s);
        return s;
      },
      get: (id) => sessions.get(id) ?? null,
      update: async (id, patch) => { const s = sessions.get(id); if (s) Object.assign(s, patch); },
      appendMessage: async (id, msg) => { const s = sessions.get(id); if (s) s.messages.push(msg); }
    },
    configStore: { getAgent: (id) => agents[id] ?? null, getAgents: () => agents },
    metadataStore: { getAgent: () => ({}) },
    eventBus: createEventBus(),
    delegationTracker: createDelegationTracker({
      filePath: path.join(dir, 'delegations.json'),
      reportsDir: path.join(dir, 'reports')
    }),
    pushStore: null,
    failureReEntryCounters: new Map(),
    MAX_FAILURE_REENTRY: 1,
    isSessionBusy: (id) => busy.has(id),
    dispatch: vi.fn(),
    webConfig: { chat: chatConfig }
  };
  const queue = createQueue(base);
  Object.assign(base, queue);
  base.delegationTracker.setPendingQueue(queue.agentQueue);
  Object.assign(base, createWorkerPool(base));
  Object.assign(base, createDelegation(base));
  return base;
}

const delegate = (agentId, task, rawText = '{}') =>
  ctx.executeDelegation('lead', agentId, task, rawText);

/** 워커가 정상적으로 끝난 상태를 만든다 — CLI 세션 ID 가 남고 트래커는 비워진다. */
function finishWorker(sessionId) {
  ctx.delegationTracker.complete(sessionId, 'ok');
  const s = ctx.sessions.get(sessionId);
  s.claudeSessionId = `claude_${sessionId}`;
  s.personaBakedInto = s.claudeSessionId;
}

/** dispatch 로 실제 작업이 넘어간 세션 ID 목록. */
const dispatchedTo = () => ctx.dispatch.mock.calls.filter((c) => c[1].kind === 'task').map((c) => c[0]);
const lastContent = () => ctx.dispatch.mock.calls.at(-1)[1].content;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-reuse-'));
  ctx = makeCtx();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('worker session reuse', () => {
  it('reuses the previous worker session for the same origin + agent', async () => {
    await delegate('worker', 'A');
    finishWorker('sess_1');
    await delegate('worker', 'B');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_1']);
    expect(sessionSeq).toBe(1); // 새 세션이 만들어지지 않았다
  });

  it('marks the reused turn as a new task so the worker does not resume the old one', async () => {
    await delegate('worker', 'A');
    expect(lastContent()).toBe('A');

    finishWorker('sess_1');
    await delegate('worker', 'B');
    expect(lastContent()).toBe(`${REUSE_TASK_PREFIX}\n\nB`);
  });

  it('keeps the tracker entry pointing at the reused session', async () => {
    await delegate('worker', 'A');
    finishWorker('sess_1');
    await delegate('worker', 'B');

    const entry = ctx.delegationTracker.getByTarget('sess_1');
    expect(entry.task).toBe('B');
    expect(entry.status).toBe('running');
    expect(entry.depth).toBe(1); // 재사용이 체인 깊이를 부풀리지 않는다
  });

  it('does not cross origins or agents', async () => {
    await delegate('worker', 'A');
    finishWorker('sess_1');

    await ctx.executeDelegation('other-lead', 'worker', 'B', '{}');   // 다른 플래너
    finishWorker('sess_2');
    await delegate('other', 'C');                                     // 다른 에이전트

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2', 'sess_3']);
  });

  it('starts fresh when the previous worker never produced a resume target', async () => {
    await delegate('worker', 'A');
    ctx.delegationTracker.complete('sess_1', 'ok'); // claudeSessionId 없음 = resume 불가
    await delegate('worker', 'B');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2']);
  });

  it('starts fresh while the previous delegation is still running', async () => {
    const wide = () => ctx.executeDelegation('lead', 'wide', 'A', '{}');
    await wide();
    await ctx.executeDelegation('lead', 'wide', 'B', '{}');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2']);
  });

  it('starts fresh while the candidate session is busy in the runner', async () => {
    await delegate('worker', 'A');
    finishWorker('sess_1');
    busy.add('sess_1');
    await delegate('worker', 'B');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2']);
  });

  it('rotates to a new session after the reuse ceiling', async () => {
    ctx = makeCtx({ delegationReuseMaxUses: 2 });
    await delegate('worker', 'A');
    finishWorker('sess_1');
    await delegate('worker', 'B');   // 2회차 — 아직 허용
    finishWorker('sess_1');
    await delegate('worker', 'C');   // 상한 초과 → 로테이션

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_1', 'sess_2']);
  });

  it('rotates to a new session once the TTL since last use has passed', async () => {
    ctx = makeCtx({ delegationReuseTtlMin: 10 });
    await delegate('worker', 'A');
    finishWorker('sess_1');

    clock += 9 * 60_000;
    await delegate('worker', 'B');
    finishWorker('sess_1');

    clock += 11 * 60_000;
    await delegate('worker', 'C');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_1', 'sess_2']);
  });

  it('rotates away from a session whose context is already heavy', async () => {
    await delegate('worker', 'A');
    finishWorker('sess_1');
    ctx.sessions.get('sess_1').messages.push({
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',        // 200K 창
      usage: { contextTokens: 150_000 }          // 75% — 상한(50%) 초과
    });
    await delegate('worker', 'B');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2']);
  });

  it('never reuses or registers a Ralph-loop worker session', async () => {
    await delegate('worker', 'A', '{"loop": true}');
    ctx.delegationTracker.complete('sess_1', 'ok');
    ctx.sessions.get('sess_1').claudeSessionId = 'claude_sess_1';

    await delegate('worker', 'B');   // 루프 세션은 후보가 아니다
    finishWorker('sess_2');
    await delegate('worker', 'C', '{"loop": true}');   // 루프 위임은 재사용하지 않는다

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2', 'sess_3']);
  });

  it('drops an abandoned worker session from the pool', async () => {
    await delegate('worker', 'A');
    ctx.sessions.get('sess_1').claudeSessionId = 'claude_sess_1';
    await ctx.abandonDelegation('sess_1', '응답 없이 중단됨');

    await delegate('worker', 'B');
    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2']);
  });

  it('creates a new session every time when disabled by config', async () => {
    ctx = makeCtx({ delegationReuse: false });
    await delegate('worker', 'A');
    finishWorker('sess_1');
    await delegate('worker', 'B');

    expect(dispatchedTo()).toEqual(['sess_1', 'sess_2']);
    expect(ctx.workerPoolStats()).toEqual({ keys: 0, sessions: 0 });
  });
});
