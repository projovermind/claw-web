import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createWorkerPool } from '../server/routes/chat/worker-pool.js';
import {
  createDelegation,
  extractEscalation,
  buildEscalationNotice,
  formatTierLine
} from '../server/routes/chat/delegation.js';
import { buildTierGuide, extractDelegationSummary } from '../server/routes/chat/message-sender.js';

/**
 * 단발(비-loop) 위임의 에스컬레이션 + 실행 티어 표기.
 *
 * 이전에는 <escalate> 가 Ralph Loop 경로에서만 해석됐다. 단발 위임에서 워커가
 * 막혀 이 태그를 남겨도 리드에게는 그냥 "위임 완료" 로 보였고, 워커가 <report>
 * 블록까지 출력했으면 요약 추출이 report 만 취해 태그가 통째로 사라졌다.
 */

describe('extractEscalation', () => {
  it('<escalate> 이유를 뽑는다', () => {
    expect(extractEscalation('앞부분\n<escalate>설계 결정이 필요함</escalate>\n뒤'))
      .toEqual({ reason: '설계 결정이 필요함' });
  });

  it('태그가 없으면 null', () => {
    expect(extractEscalation('평범한 완료 보고')).toBeNull();
    expect(extractEscalation('')).toBeNull();
    expect(extractEscalation(null)).toBeNull();
  });

  it('빈 태그도 에스컬레이션으로 친다', () => {
    expect(extractEscalation('<escalate></escalate>')).toEqual({ reason: '(이유 없음)' });
  });

  it('<report> 블록이 있어 요약에서 사라지는 경우에도 원문에서 잡힌다', () => {
    const text =
      '<escalate>티어가 모자람</escalate>\n' +
      '<report>\n{"status":"blocked","summary":"막힘","artifacts":[],"unresolved":[],"nextAction":"재위임"}\n</report>';
    // 요약 경로는 report 만 취하므로 escalate 가 남지 않는다 — 그래서 원문 파싱이 필요하다.
    const { summary, structured } = extractDelegationSummary(text);
    expect(structured).toBe(true);
    expect(summary).not.toContain('escalate');
    expect(extractEscalation(text)?.reason).toBe('티어가 모자람');
  });
});

describe('buildEscalationNotice', () => {
  const order = ['high', 'middle', 'low'];

  it('한 칸 위 티어로 재위임하라고 지시한다', () => {
    const notice = buildEscalationNotice({ reason: '원인 불명', tier: 'low', order });
    expect(notice).toContain('"tier": "middle"');
    expect(notice).toContain('원인 불명');
    expect(notice).toContain('`low`');
  });

  it('최상위 티어면 티어 상향을 권하지 않는다', () => {
    const notice = buildEscalationNotice({ reason: '막힘', tier: 'high', order });
    expect(notice).toContain('이미 최상위 티어');
    expect(notice).not.toContain('"tier":');
  });

  it('실행 티어를 모르면 티어 문장 없이 안내만 한다', () => {
    const notice = buildEscalationNotice({ reason: '막힘', tier: null, order });
    expect(notice).toContain('막힘');
    expect(notice).toContain('이미 최상위 티어');
  });

  it('커스텀 티어 order 를 따른다', () => {
    const notice = buildEscalationNotice({ reason: 'x', tier: 'b', order: ['s', 'a', 'b'] });
    expect(notice).toContain('"tier": "a"');
  });
});

describe('formatTierLine', () => {
  it('위임이 지정한 티어와 에이전트 기본 티어를 구분한다', () => {
    expect(formatTierLine({ tier: 'high', tierOverridden: true })).toContain('(위임에서 지정)');
    expect(formatTierLine({ tier: 'high', tierOverridden: false })).toContain('(에이전트 기본)');
  });

  it('티어를 모르면 줄을 만들지 않는다', () => {
    expect(formatTierLine({ tier: null })).toBe('');
    expect(formatTierLine(null)).toBe('');
  });
});

describe('delegationTracker — 실행 티어 기록', () => {
  let dir;
  let tracker;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-esc-'));
    tracker = createDelegationTracker({
      filePath: path.join(dir, 'delegations.json'),
      reportsDir: path.join(dir, 'reports')
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('create 가 tier/tierOverridden 을 엔트리에 남긴다', () => {
    const entry = tracker.create({
      originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'worker',
      task: '구현', tier: 'high', tierOverridden: true
    });
    expect(entry.tier).toBe('high');
    expect(entry.tierOverridden).toBe(true);
    // 완료 회신까지 값이 살아 있어야 리드가 "어느 급으로 돌았는지" 를 본다.
    expect(tracker.complete('w1', 'ok').tier).toBe('high');
  });

  it('티어를 안 주면 null/false 로 남는다 (옛 호출부 호환)', () => {
    const entry = tracker.create({
      originSessionId: 'lead', targetSessionId: 'w2', targetAgentId: 'worker', task: '구현'
    });
    expect(entry.tier).toBeNull();
    expect(entry.tierOverridden).toBe(false);
  });

  it('create 는 escalated 를 항상 false 로 시작한다', () => {
    const entry = tracker.create({
      originSessionId: 'lead', targetSessionId: 'w3', targetAgentId: 'worker',
      task: '구현', tier: 'high', tierOverridden: true
    });
    expect(entry.escalated).toBe(false);
  });

  it('complete 에 escalated 인자를 안 주면 false 로 남는다 (옛 호출부 호환)', () => {
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w4', targetAgentId: 'worker', task: '구현' });
    expect(tracker.complete('w4', 'ok').escalated).toBe(false);
  });

  it('complete(..., true) 는 escalated=true 를 엔트리에 남긴다 — tierOverridden 과는 별개', () => {
    // tierOverridden=false (agentDefaultTier 로 돌았음) 인데도 escalate 가 날 수 있다 —
    // 두 필드가 서로 다른 축이라는 것을 보여준다.
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w5', targetAgentId: 'worker', task: '구현', tier: 'low', tierOverridden: false });
    const completed = tracker.complete('w5', 'ok', null, true);
    expect(completed.escalated).toBe(true);
    expect(completed.tierOverridden).toBe(false);
  });
});

describe('executeDelegation — 트래커에 실제 실행 티어를 남긴다', () => {
  let dir;
  let ctx;

  function makeCtx(agents) {
    const sessions = new Map();
    let seq = 0;
    const base = {
      sessions,
      sessionsStore: {
        create: async ({ agentId, title, ...extra }) => {
          const s = { id: `sess_${++seq}`, agentId, title, messages: [], ...extra };
          sessions.set(s.id, s);
          return s;
        },
        get: (id) => sessions.get(id) ?? null,
        update: async (id, patch) => { const s = sessions.get(id); if (s) Object.assign(s, patch); },
        appendMessage: async (id, msg) => { const s = sessions.get(id); if (s) s.messages.push(msg); }
      },
      configStore: { getAgent: (id) => agents[id] ?? null, getAgents: () => agents },
      metadataStore: { getAgent: () => ({}) },
      backendsStore: { getRaw: () => ({ tiers: { order: ['high', 'middle', 'low'], labels: {} } }) },
      eventBus: createEventBus(),
      delegationTracker: createDelegationTracker({
        filePath: path.join(dir, 'd.json'), reportsDir: path.join(dir, 'r')
      }),
      pushStore: null,
      failureReEntryCounters: new Map(),
      MAX_FAILURE_REENTRY: 1,
      isSessionBusy: () => false,
      dispatch: vi.fn(),
      webConfig: { chat: {} }
    };
    const queue = createQueue(base);
    Object.assign(base, queue);
    base.delegationTracker.setPendingQueue(queue.agentQueue);
    Object.assign(base, createWorkerPool(base));
    Object.assign(base, createDelegation(base));
    return base;
  }

  const lastEntry = () => ctx.delegationTracker.list().at(-1);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-esc-exec-'));
  });
  afterEach(() => {
    ctx?.stopQueue?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('위임이 지정한 티어를 기록한다', async () => {
    ctx = makeCtx({ worker: { name: 'w', modelTier: 'low' } });
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "구현", "tier": "high"}}');
    expect(lastEntry().tier).toBe('high');
    expect(lastEntry().tierOverridden).toBe(true);
  });

  it('지정이 없으면 에이전트 기본 티어를 기록한다', async () => {
    ctx = makeCtx({ worker: { name: 'w', modelTier: 'low' } });
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "구현"}}');
    expect(lastEntry().tier).toBe('low');
    expect(lastEntry().tierOverridden).toBe(false);
  });

  it('에이전트에 티어 설정이 없으면 null', async () => {
    ctx = makeCtx({ worker: { name: 'w' } });
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "구현"}}');
    expect(lastEntry().tier).toBeNull();
  });
});

describe('buildTierGuide', () => {
  it('기본 3단계에서 가운데를 기본값으로 제시한다', () => {
    const guide = buildTierGuide(['high', 'middle', 'low']);
    expect(guide).toContain('`high`: 설계');
    expect(guide).toContain('`middle`');
    expect(guide).toContain('`low`');
    expect(guide).toContain('애매하면 `middle`');
  });

  it('2단계뿐이면 아래쪽이 기본값이다 (비싼 쪽을 기본으로 두지 않는다)', () => {
    const guide = buildTierGuide(['s', 'a']);
    expect(guide).toContain('애매하면 `a`');
  });

  it('티어가 하나뿐이면 최상위 설명만 남는다', () => {
    const guide = buildTierGuide(['only']);
    expect(guide).toContain('`only`: 설계');
    expect(guide).toContain('애매하면 `only`');
  });

  it('티어 목록이 비면 아무것도 붙이지 않는다', () => {
    expect(buildTierGuide([])).toBe('');
  });
});
