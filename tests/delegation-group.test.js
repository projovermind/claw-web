import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createDelegationGroups } from '../server/routes/chat/delegation-group.js';
import { createEventBus } from '../server/lib/event-bus.js';

/**
 * 위임 그룹 배리어 회귀 테스트.
 * 한 턴에 발주한 N(≥2)건은 전원이 settle 될 때까지 보고를 모아 한 턴으로 전달하고,
 * 단건은 기존대로 즉시 보고한다.
 */

let dir;
let ctx;
let agents;
let sessionSeq;

function makeCtx() {
  sessionSeq = 0;
  agents = {
    lead_agent: { name: 'lead' },
    alpha: { name: 'alpha' },
    beta: { name: 'beta' },
    gamma: { name: 'gamma' }
  };

  const messages = [];
  const base = {
    sessionsStore: {
      create: async ({ agentId }) => ({ id: `sess_${++sessionSeq}`, agentId }),
      appendMessage: async (sessionId, msg) => { messages.push({ sessionId, ...msg }); },
      update: async () => {},
      get: () => null
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
    reEntryCounters: new Map(),
    MAX_REENTRY: 30,
    failureReEntryCounters: new Map(),
    MAX_FAILURE_REENTRY: 3,
    dispatch: vi.fn(),
    messages
  };
  const queue = createQueue(base);
  Object.assign(base, queue);
  base.delegationTracker.setPendingQueue(queue.agentQueue);
  Object.assign(base, createDelegationGroups(base));
  Object.assign(base, createDelegation(base));
  return base;
}

/** 워커 응답 한 건이 만들어 내는 위임 JSON 블록. */
const block = (agent, task) => '```json\n' + JSON.stringify({ delegate: { agent, task } }) + '\n```';

/** flush 는 appendMessage 를 await 한다 — 마이크로태스크를 몇 번 흘려보낸다. */
async function tick() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** message-sender 의 완료 보고 경로를 최소한으로 흉내낸다. */
async function settleOk(targetSessionId, summary) {
  const completed = ctx.delegationTracker.complete(targetSessionId, summary);
  ctx.dequeueNextAgent(completed.targetAgentId);
  const held = ctx.collectGroupReport(completed, {
    status: 'completed',
    body: `**작업**: ${completed.task}\n\n**결과**:\n${summary}`
  });
  if (!held) {
    ctx.dispatch(completed.originSessionId, {
      kind: 'report',
      content: `[위임 결과 보고]\n\n**결과**:\n${summary}`
    });
  }
  await tick();
  return held;
}

const originReports = () => ctx.dispatch.mock.calls.filter((c) => c[0] === 'lead').map((c) => c[1].content);
const workerTasks = () => ctx.dispatch.mock.calls.filter((c) => c[0] !== 'lead').map((c) => c[1].content);
const sessionOf = (agentId) => ctx.delegationTracker.list().find((e) => e.targetAgentId === agentId)?.targetSessionId;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-group-'));
  ctx = makeCtx();
});
afterEach(() => {
  ctx.stopGroups();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('delegation group barrier', () => {
  it('leaves a single delegation ungrouped and reports it immediately', async () => {
    await ctx.handleDelegation('lead', block('alpha', 'A'));

    expect(ctx.delegationGroupCount()).toBe(0);
    const entry = ctx.delegationTracker.list()[0];
    expect(entry.groupId).toBe(null);

    const held = await settleOk(entry.targetSessionId, 'A 완료');
    expect(held).toBe(false);
    expect(originReports()).toHaveLength(1);
    expect(originReports()[0]).toContain('[위임 결과 보고]');
  });

  it('holds every report until the last member of the turn settles, then sends one turn', async () => {
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('beta', 'B'));

    const entries = ctx.delegationTracker.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].groupId).toBeTruthy();
    expect(entries[1].groupId).toBe(entries[0].groupId);
    expect(workerTasks()).toEqual(['A', 'B']);

    // 첫 멤버가 끝나도 플래너는 깨우지 않는다 — 1/2 만 보고 판단하면 턴이 낭비된다.
    expect(await settleOk(sessionOf('alpha'), 'A 결과')).toBe(true);
    expect(originReports()).toHaveLength(0);

    expect(await settleOk(sessionOf('beta'), 'B 결과')).toBe(true);
    expect(originReports()).toHaveLength(1);

    const report = originReports()[0];
    expect(report).toContain('같은 턴에 발주한 2건 일괄');
    expect(report).toContain('## 1/2 ✅ 완료 — alpha');
    expect(report).toContain('## 2/2 ✅ 완료 — beta');
    expect(report).toContain('A 결과');
    expect(report).toContain('B 결과');
    expect(ctx.delegationGroupCount()).toBe(0);
  });

  it('keeps the barrier open for a member that is still waiting in the agent queue', async () => {
    vi.useFakeTimers();
    agents.alpha.maxConcurrent = 1;
    // alpha 에게 두 건 — 두 번째는 대기열로 간다. 대기 중인 슬롯도 그룹 멤버다.
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('alpha', 'B'));
    expect(ctx.agentQueue.get('alpha')).toHaveLength(1);

    const first = sessionOf('alpha');
    await settleOk(first, 'A 결과');
    expect(originReports()).toHaveLength(0); // 대기 중이던 B 가 아직 남았다

    await vi.advanceTimersByTimeAsync(600); // 대기열 드레인 → B 실행
    const second = sessionOf('alpha');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    await settleOk(second, 'B 결과');
    const report = originReports();
    expect(report).toHaveLength(1);
    expect(report[0]).toContain('A 결과');
    expect(report[0]).toContain('B 결과');
  });

  it('drops the slot of an undeliverable member so the barrier still closes', async () => {
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('nobody', 'B'));

    expect(ctx.delegationTracker.list()).toHaveLength(1);
    await settleOk(sessionOf('alpha'), 'A 결과');

    const reports = originReports();
    expect(reports.some((r) => r.includes('A 결과'))).toBe(true);
    expect(ctx.delegationGroupCount()).toBe(0);
  });

  it('folds an aborted member into the combined report', async () => {
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('beta', 'B'));

    await ctx.abandonDelegation(sessionOf('beta'), '워커가 응답 없이 종료됨');
    await tick();
    expect(originReports()).toHaveLength(0); // alpha 가 아직 실행 중

    await settleOk(sessionOf('alpha'), 'A 결과');
    const report = originReports()[0];
    expect(report).toContain('⛔ 중단 — beta');
    expect(report).toContain('워커가 응답 없이 종료됨');
    expect(report).toContain('✅ 완료 — alpha');
  });

  it('reports an aborted single delegation immediately (no barrier)', async () => {
    await ctx.handleDelegation('lead', block('alpha', 'A'));
    await ctx.abandonDelegation(sessionOf('alpha'), '중단');
    await tick();

    const reports = originReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('[위임 중단]');
  });

  it('sends a partial report on timeout and reports the straggler on its own', async () => {
    vi.useFakeTimers();
    ctx.groupTimeoutMs = 1000;
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('beta', 'B'));

    await settleOk(sessionOf('alpha'), 'A 결과');
    expect(originReports()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1100);
    await tick();

    const partial = originReports();
    expect(partial).toHaveLength(1);
    expect(partial[0]).toContain('2건 중 1건 도착, 1건 미도착');
    expect(partial[0]).toContain('A 결과');
    expect(partial[0]).toContain('`beta`');
    expect(ctx.delegationGroupCount()).toBe(0);

    // 늦게 끝난 멤버는 그룹이 닫혔으므로 개별 보고로 돌아간다.
    expect(await settleOk(sessionOf('beta'), 'B 결과')).toBe(false);
    expect(originReports()).toHaveLength(2);
    expect(originReports()[1]).toContain('B 결과');
  });

  it('counts one planner re-entry per group, not one per member', async () => {
    await ctx.handleDelegation(
      'lead',
      block('alpha', 'A') + '\n' + block('beta', 'B') + '\n' + block('gamma', 'C')
    );

    await settleOk(sessionOf('alpha'), 'A');
    await settleOk(sessionOf('beta'), 'B');
    await settleOk(sessionOf('gamma'), 'C');

    expect(originReports()).toHaveLength(1);
    expect(ctx.reEntryCounters.get('lead')).toBe(1);
  });

  it('stops resuming the planner once the group report hits the re-entry limit', async () => {
    ctx.reEntryCounters.set('lead', ctx.MAX_REENTRY);
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('beta', 'B'));
    await settleOk(sessionOf('alpha'), 'A');
    await settleOk(sessionOf('beta'), 'B');

    expect(originReports()).toHaveLength(0);
    expect(ctx.messages.some((m) => m.content.includes('위임 자동 진행 한계 도달'))).toBe(true);
  });

  it('keeps separate turns in separate groups', async () => {
    await ctx.handleDelegation('lead', block('alpha', 'A') + '\n' + block('beta', 'B'));
    const firstGroup = ctx.delegationTracker.list()[0].groupId;

    await settleOk(sessionOf('alpha'), 'A');
    await settleOk(sessionOf('beta'), 'B');
    expect(originReports()).toHaveLength(1);

    await ctx.handleDelegation('lead', block('alpha', 'C') + '\n' + block('gamma', 'D'));
    const secondGroup = ctx.delegationTracker.list()[0].groupId;
    expect(secondGroup).toBeTruthy();
    expect(secondGroup).not.toBe(firstGroup);

    await settleOk(sessionOf('alpha'), 'C');
    expect(originReports()).toHaveLength(1);
    await settleOk(sessionOf('gamma'), 'D');
    expect(originReports()).toHaveLength(2);
    expect(originReports()[1]).toContain('C');
    expect(originReports()[1]).toContain('D');
  });
});
