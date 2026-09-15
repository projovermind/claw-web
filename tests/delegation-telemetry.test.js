import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createDelegationsRouter } from '../server/routes/delegations.js';
import { createEventBus } from '../server/lib/event-bus.js';

/**
 * 위임 텔레메트리 회귀 테스트.
 * createdAt/completedAt 만 있던 시절에는 "느린 위임"이 큐에서 기다린 것인지 워커가
 * 오래 돈 것인지 구분할 수 없었다. queuedAt/startedAt/queueMs/durationMs 가 그 둘을
 * 갈라 놓는다 — 이 파일은 각 값이 실제 대기/실행 구간과 맞는지 고정한다.
 */

let dir;
let ctx;
let agents;
let sessionSeq;

const opts = () => ({
  filePath: path.join(dir, 'delegations.json'),
  reportsDir: path.join(dir, 'reports')
});

function makeCtx() {
  sessionSeq = 0;
  agents = { solo: { name: 'solo' }, wide: { name: 'wide', maxConcurrent: 2 } };

  const base = {
    sessionsStore: {
      create: async ({ agentId }) => ({ id: `sess_${++sessionSeq}`, agentId }),
      appendMessage: async () => {},
      update: async () => {},
      get: () => null,
      getById: () => null
    },
    configStore: {
      getAgent: (id) => agents[id] ?? null,
      getAgents: () => agents
    },
    metadataStore: { getAgent: () => ({}) },
    eventBus: createEventBus(),
    delegationTracker: createDelegationTracker(opts()),
    pushStore: null,
    failureReEntryCounters: new Map(),
    MAX_FAILURE_REENTRY: 1,
    dispatch: vi.fn()
  };
  const queue = createQueue(base);
  Object.assign(base, queue);
  base.delegationTracker.setPendingQueue(queue.agentQueue);
  Object.assign(base, createDelegation(base));
  return base;
}

const delegate = (agentId, task, groupId = null) =>
  ctx.executeDelegation('lead', agentId, task, '{}', groupId);
const entryFor = (sessionId) => ctx.delegationTracker.getByTarget(sessionId);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-tele-'));
  ctx = makeCtx();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('delegation telemetry fields', () => {
  it('stamps queuedAt/startedAt with no queue wait when a slot is free', async () => {
    await delegate('solo', 'A');
    const entry = entryFor('sess_1');
    expect(entry.queueMs).toBe(0);
    expect(entry.queuedAt).toBe(entry.startedAt);
    expect(entry.startedAt).toBe(entry.createdAt); // 기존 필드 의미는 그대로
    expect(entry.durationMs).toBeNull();
  });

  it('records execution time on completion, separate from queue wait', async () => {
    vi.useFakeTimers();
    await delegate('solo', 'A');

    await vi.advanceTimersByTimeAsync(7_000);
    const done = ctx.delegationTracker.complete('sess_1', 'ok');
    expect(done.durationMs).toBe(7_000);
    expect(done.queueMs).toBe(0);
    expect(Date.parse(done.completedAt) - Date.parse(done.startedAt)).toBe(done.durationMs);
  });

  it('records execution time on failure too', async () => {
    vi.useFakeTimers();
    await delegate('solo', 'A');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ctx.delegationTracker.fail('sess_1', 'boom').durationMs).toBe(2_500);
  });

  it('charges queue wait to queueMs, not to durationMs', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B', 'C']) await delegate('wide', t); // C 는 한도(2) 초과 → 대기
    expect(ctx.agentQueue.get('wide')).toHaveLength(1);
    expect(ctx.agentQueue.get('wide')[0].queuedAt).toBeTruthy();

    // 10초 뒤에야 슬롯이 비어 C 가 풀린다.
    await vi.advanceTimersByTimeAsync(10_000);
    ctx.delegationTracker.complete('sess_1', 'ok');
    ctx.dequeueNextAgent('wide');
    await vi.advanceTimersByTimeAsync(600); // START_DELAY_MS

    const queuedEntry = entryFor('sess_3');
    expect(queuedEntry.task).toBe('C');
    expect(queuedEntry.queueMs).toBeGreaterThanOrEqual(10_000);
    // 대기 시간이 실행 시간으로 새면 워커가 느린 것처럼 보인다.
    await vi.advanceTimersByTimeAsync(1_000);
    const finished = ctx.delegationTracker.complete('sess_3', 'ok');
    expect(finished.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(finished.durationMs).toBeLessThan(finished.queueMs);
  });

  it('keeps groupId on a delegation that had to wait in the queue', async () => {
    vi.useFakeTimers();
    for (const t of ['A', 'B']) await delegate('wide', t, 'grp_1');
    await delegate('wide', 'C', 'grp_1');

    ctx.delegationTracker.complete('sess_1', 'ok');
    ctx.dequeueNextAgent('wide');
    await vi.advanceTimersByTimeAsync(600);
    expect(entryFor('sess_3').groupId).toBe('grp_1');
  });

  it('does not reset the wait clock when the queue survives a restart', async () => {
    for (const t of ['A', 'B', 'C']) await delegate('wide', t);
    const queuedAt = ctx.agentQueue.get('wide')[0].queuedAt;
    await new Promise((r) => setTimeout(r, 400)); // 디바운스된 persist

    const persisted = JSON.parse(fs.readFileSync(opts().filePath, 'utf8'));
    expect(persisted.pending[0]).toMatchObject({ task: 'C', queuedAt });
    expect(createDelegationTracker(opts()).getPendingQueue()[0].queuedAt).toBe(queuedAt);
  });

  it('leaves durationMs null for records that predate the new fields', () => {
    const tracker = createDelegationTracker(opts());
    const entry = tracker.create({
      originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'solo', task: 'A'
    });
    delete entry.startedAt;
    delete entry.createdAt;
    expect(tracker.complete('w1', 'ok').durationMs).toBeNull();
  });
});

describe('GET /api/delegations', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/delegations', createDelegationsRouter({ delegationTracker: ctx.delegationTracker }));
  });

  it('exposes queue/execution telemetry for running and finished delegations', async () => {
    vi.useFakeTimers();
    await delegate('solo', 'A');
    await vi.advanceTimersByTimeAsync(3_000);
    ctx.delegationTracker.complete('sess_1', 'ok');
    await delegate('solo', 'B');
    vi.useRealTimers();

    const res = await request(app).get('/api/delegations').expect(200);
    expect(res.body.delegations[0]).toMatchObject({ task: 'B', queueMs: 0, durationMs: null });
    expect(res.body.delegations[0].startedAt).toBeTruthy();
    expect(res.body.recent[0]).toMatchObject({
      targetSessionId: 'sess_1',
      targetAgentId: 'solo',
      status: 'completed',
      queueMs: 0,
      durationMs: 3_000
    });
    expect(res.body.recent[0].queuedAt).toBeTruthy();
  });

  it('clamps the recent-history limit', async () => {
    for (let i = 0; i < 3; i++) {
      ctx.delegationTracker.create({
        originSessionId: 'lead', targetSessionId: `w${i}`, targetAgentId: 'solo', task: `T${i}`
      });
      ctx.delegationTracker.complete(`w${i}`, 'ok');
    }
    expect((await request(app).get('/api/delegations?limit=2')).body.recent).toHaveLength(2);
    expect((await request(app).get('/api/delegations?limit=-5')).body.recent).toHaveLength(0);
    expect((await request(app).get('/api/delegations?limit=nope')).body.recent).toHaveLength(3);
  });
});
