import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createWorkerPool } from '../server/routes/chat/worker-pool.js';
import { createMessageSender } from '../server/routes/chat/message-sender.js';
import { createEventBus } from '../server/lib/event-bus.js';

/**
 * 위임 JSON 의 "tier" 배선 회귀 테스트.
 *
 * 이전에는 "model" 필드를 프롬프트가 광고만 하고 executeDelegation 이 읽지 않아
 * 통째로 무시됐다. 여기서는 (1) tier 가 그 실행에만 적용되는지, (2) 잘못된 이름이
 * 무시되는지, (3) 재사용 세션에 이전 티어가 남지 않는지를 고정한다.
 */

const BACKENDS = {
  claude: {
    type: 'claude-cli',
    models: { default: 'claude-opus-5', opus: 'claude-opus-5' },
    tierModels: { high: 'claude-opus-5', middle: 'claude-sonnet-5', low: 'claude-haiku-4-6' }
  }
};

function fakeBackendsStore(tiers) {
  return {
    getRaw: () => ({ activeBackend: 'claude', backends: BACKENDS, tiers }),
    getBackend: (id) => BACKENDS[id] ?? null
  };
}

let dir;
let ctx;
let sessionSeq;

function makeCtx({ tiers, agents } = {}) {
  sessionSeq = 0;
  const sessions = new Map();
  const agentMap = agents ?? { worker: { name: 'worker' }, slow: { name: 'slow' } };

  const base = {
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
    configStore: { getAgent: (id) => agentMap[id] ?? null, getAgents: () => agentMap },
    metadataStore: { getAgent: () => ({}) },
    backendsStore: fakeBackendsStore(tiers),
    eventBus: createEventBus(),
    delegationTracker: createDelegationTracker({
      filePath: path.join(dir, 'delegations.json'),
      reportsDir: path.join(dir, 'reports')
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

/** dispatch 된 마지막 워커 세션. */
const lastWorkerSession = () => {
  const id = ctx.dispatch.mock.calls.filter((c) => c[1].kind === 'task').at(-1)?.[0];
  return id ? ctx.sessions.get(id) : null;
};

function finishWorker(sessionId) {
  ctx.delegationTracker.complete(sessionId, 'ok');
  ctx.releaseWorkerSession?.(sessionId);
  const s = ctx.sessions.get(sessionId);
  s.claudeSessionId = `claude_${sessionId}`;
  s.personaBakedInto = s.claudeSessionId;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-tier-'));
  ctx = makeCtx();
});
afterEach(() => {
  ctx.stopQueue?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('위임 JSON 파싱 — tier', () => {
  it('delegate.tier 를 그대로 실어 나른다', () => {
    const [parsed] = ctx.extractDelegateJson(
      '```json\n{"delegate": {"agent": "worker", "task": "정리", "tier": "low"}}\n```'
    );
    expect(parsed.delegate.tier).toBe('low');
  });

  it('폐기된 "model" 필드가 있어도 파싱은 성공하고 티어는 비어 있다', () => {
    const [parsed] = ctx.extractDelegateJson(
      '{"delegate": {"agent": "worker", "task": "정리", "model": "glm-5.1"}}'
    );
    expect(parsed.delegate.model).toBe('glm-5.1');
    expect(parsed.delegate.tier).toBeUndefined();
  });
});

describe('executeDelegation — 티어 오버라이드', () => {
  it('tier 를 그 워커 세션에만 얹는다 (에이전트 저장값은 그대로)', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "정리", "tier": "low"}}');
    expect(lastWorkerSession().modelTierOverride).toBe('low');
    expect(ctx.configStore.getAgent('worker').modelTier).toBeUndefined();
  });

  it('tier 가 없으면 오버라이드도 없다', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "정리"}}');
    expect(lastWorkerSession().modelTierOverride).toBe(null);
  });

  it('등록되지 않은 티어명은 무시한다', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "정리", "tier": "ultra"}}');
    expect(lastWorkerSession().modelTierOverride).toBe(null);
  });

  it('폐기된 "model" 은 아무 영향도 주지 않는다', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "정리", "model": "opus"}}');
    expect(lastWorkerSession().modelTierOverride).toBe(null);
  });

  it('대소문자/공백은 정규화한다', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "정리", "tier": " HIGH "}}');
    expect(lastWorkerSession().modelTierOverride).toBe('high');
  });

  it('커스텀 티어 이름을 쓰면 그 이름으로 검증한다', async () => {
    ctx = makeCtx({ tiers: { order: ['s', 'a'], labels: {} } });
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "정리", "tier": "s"}}');
    expect(lastWorkerSession().modelTierOverride).toBe('s');

    // 기본 티어명(low)은 이 체계에 없으므로 무시된다 — 다른 에이전트에게 발주해
    // 대기열을 타지 않게 한다(위 위임이 worker 의 슬롯을 점유 중).
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "slow", "task": "다른 일", "tier": "low"}}');
    expect(lastWorkerSession().agentId).toBe('slow');
    expect(lastWorkerSession().modelTierOverride).toBe(null);
  });
});

describe('세션 재사용 — 이전 티어가 새지 않는다', () => {
  it('재사용 세션에 티어 없는 위임이 오면 오버라이드가 지워진다', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "1차", "tier": "low"}}');
    const first = lastWorkerSession();
    expect(first.modelTierOverride).toBe('low');
    finishWorker(first.id);

    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "2차"}}');
    const second = lastWorkerSession();
    expect(second.id).toBe(first.id); // 재사용됐는지 확인 — 아니면 이 테스트는 무의미
    expect(second.modelTierOverride).toBe(null);
  });

  it('재사용 세션에 다른 티어가 오면 새 값으로 덮인다', async () => {
    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "1차", "tier": "low"}}');
    const first = lastWorkerSession();
    finishWorker(first.id);

    await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "2차", "tier": "high"}}');
    expect(lastWorkerSession().id).toBe(first.id);
    expect(lastWorkerSession().modelTierOverride).toBe('high');
  });
});

describe('대기열 경유 — 티어 보존', () => {
  it('한도에 걸려 대기한 위임도 꺼낼 때 티어를 들고 간다', async () => {
    vi.useFakeTimers();
    try {
      // 첫 위임이 슬롯을 점유 → 두 번째는 대기열로
      await ctx.handleDelegation('lead', '{"delegate": {"agent": "worker", "task": "1차"}}');
      const busy = lastWorkerSession();
      await ctx.handleDelegation('lead2', '{"delegate": {"agent": "worker", "task": "2차", "tier": "low"}}');

      expect(ctx.agentQueue.get('worker')).toHaveLength(1);
      expect(ctx.agentQueue.get('worker')[0].tier).toBe('low');

      // 슬롯이 비면 큐가 드레인되고, 그때 티어가 세션에 실린다
      finishWorker(busy.id);
      ctx.dequeueNextAgent('worker');
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();

      expect(lastWorkerSession().modelTierOverride).toBe('low');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('applyTierOverride — 실행 시 모델 교체', () => {
  const sender = (tiers) => createMessageSender({ backendsStore: fakeBackendsStore(tiers) });
  const backendConfig = { backendName: 'claude' };

  it('오버라이드가 있으면 모델을 그 티어의 모델로 바꾼다', () => {
    const agent = { id: 'worker', model: 'claude-opus-5' };
    sender().applyTierOverride('s1', { modelTierOverride: 'low' }, agent, backendConfig);
    expect(agent.model).toBe('claude-haiku-4-6');
    // 폴백 백엔드에서 다시 풀 수 있도록 티어 이름을 남긴다
    expect(agent.modelAlias).toBe('low');
    expect(agent.modelTier).toBe('low');
  });

  it('오버라이드가 없으면 아무것도 건드리지 않는다', () => {
    const agent = { id: 'worker', model: 'claude-opus-5' };
    sender().applyTierOverride('s1', {}, agent, backendConfig);
    expect(agent.model).toBe('claude-opus-5');
    expect(agent.modelAlias).toBeUndefined();
    sender().applyTierOverride('s1', { modelTierOverride: null }, agent, backendConfig);
    expect(agent.model).toBe('claude-opus-5');
  });

  it('이 백엔드에서 풀리지 않는 티어면 기본 모델을 유지한다', () => {
    const agent = { id: 'worker', model: 'claude-opus-5' };
    sender().applyTierOverride('s1', { modelTierOverride: 'nope' }, agent, { backendName: 'ghost' });
    expect(agent.model).toBe('claude-opus-5');
    expect(agent.modelAlias).toBeUndefined();
  });
});
