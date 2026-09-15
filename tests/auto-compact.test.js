import { describe, it, expect } from 'vitest';
import {
  shouldAutoCompact,
  settleAutoCompactBaseline,
  buildCompactSummary,
  compactSession,
  stripCompactSuffix,
  MIN_HEADROOM_TOKENS,
  MIN_REGROWTH_TOKENS
} from '../server/lib/compact.js';
import { sessionContextUsage, resolveContextWindow, usedContextTokens } from '../server/lib/context-window.js';

const assistant = (usage, over = {}) => ({ role: 'assistant', content: 'a', usage, ...over });

function fakeStore(session) {
  const created = [];
  const byId = new Map();
  if (session) byId.set(session.id, { ...session });
  return {
    created,
    byId,
    get: (id) => byId.get(id) ?? null,
    async create({ agentId, title, ...extra }) {
      const s = { id: `new-${created.length}`, agentId, title, messages: [], ...extra };
      created.push(s);
      byId.set(s.id, s);
      return s;
    },
    async appendMessage(id, msg) {
      byId.get(id).messages.push(msg);
    },
    async setMessages(id, messages) {
      byId.get(id).messages = messages;
    },
    async update(id, patch) {
      Object.assign(byId.get(id), patch);
    },
    session
  };
}

describe('context-window (server port)', () => {
  it('prefers the backend-declared window, then the heuristic', () => {
    const backends = { b1: { contextWindows: { 'claude-x': 500_000 } } };
    expect(resolveContextWindow('claude-x', 'b1', backends)).toEqual({ tokens: 500_000, source: 'backend' });
    expect(resolveContextWindow('claude-x', 'missing', backends).tokens).toBe(500_000);
    // Opus 5 는 1M 창이다. 여기가 200K 로 돌아가면 게이지가 5배 어긋난다.
    expect(resolveContextWindow('claude-opus-5', null, null)).toEqual({ tokens: 1_000_000, source: 'heuristic' });
    expect(resolveContextWindow('claude-haiku-4-5', null, null)).toEqual({ tokens: 200_000, source: 'heuristic' });
    expect(resolveContextWindow('claude-sonnet-4-5-1m', null, null).tokens).toBe(1_000_000);
  });

  it('uses contextTokens when present and caps the legacy sum at max', () => {
    expect(usedContextTokens({ contextTokens: 120_000, inputTokens: 900_000 }, 200_000)).toBe(120_000);
    expect(usedContextTokens({ inputTokens: 50_000, cacheReadTokens: 60_000 }, 200_000)).toBe(110_000);
    expect(usedContextTokens({ inputTokens: 1_200_000 }, 200_000)).toBe(200_000);
  });

  it('reads the last assistant turn with usage', () => {
    const session = {
      messages: [
        assistant({ contextTokens: 10_000 }),
        { role: 'user', content: 'u' },
        assistant({ contextTokens: 150_000 }),
        { role: 'user', content: 'u2' }
      ]
    };
    const usage = sessionContextUsage(session, { model: 'claude-haiku-4-5' });
    expect(usage).toEqual({ used: 150_000, max: 200_000, pct: 75 });
  });

  it('returns null when no turn carries usage', () => {
    expect(sessionContextUsage({ messages: [{ role: 'user', content: 'u' }] })).toBeNull();
    expect(sessionContextUsage({ messages: [assistant({ contextTokens: 0 })] })).toBeNull();
  });
});

describe('shouldAutoCompact threshold', () => {
  const usage = (pct) => ({ used: 1, max: 1, pct });
  /** 1M 창에서 pct% 를 쓴 상태 — 실제 운영 세션과 같은 모양. */
  const wide = (pct) => ({ used: 1_000_000 * (pct / 100), max: 1_000_000, pct });

  it('is off when pct is 0 / unset', () => {
    expect(shouldAutoCompact(0, usage(99))).toBe(false);
    expect(shouldAutoCompact(undefined, usage(99))).toBe(false);
  });

  it('fires at or above the threshold only', () => {
    expect(shouldAutoCompact(70, usage(69.9))).toBe(false);
    expect(shouldAutoCompact(70, usage(70))).toBe(true);
    expect(shouldAutoCompact(70, usage(85))).toBe(true);
  });

  it('never fires without a usage reading', () => {
    expect(shouldAutoCompact(70, null)).toBe(false);
  });

  // 폭주 재현: 1M 창 + 임계 50 이면 여유가 480K 남았는데도 매 턴 압축됐다.
  // (실측 sess_Pxq1fY3zXXTd — 15시간 32회, maxTokens 1000000 / usedPct 52)
  it('holds off while the window still has real headroom', () => {
    expect(shouldAutoCompact(50, wide(52))).toBe(false);
    expect(shouldAutoCompact(50, { used: 524_990, max: 1_000_000, pct: 52.499 })).toBe(false);
  });

  it('fires once headroom drops below the absolute floor', () => {
    const used = 1_000_000 - MIN_HEADROOM_TOKENS + 1;
    expect(shouldAutoCompact(50, { used, max: 1_000_000, pct: (used / 1_000_000) * 100 })).toBe(true);
    // 하한 경계 바로 위(여유가 딱 하한만큼 남음)는 아직 압축하지 않는다.
    const atFloor = 1_000_000 - MIN_HEADROOM_TOKENS - 1;
    expect(shouldAutoCompact(50, { used: atFloor, max: 1_000_000, pct: (atFloor / 1_000_000) * 100 })).toBe(false);
  });

  it('applies the same floor to a 200K window', () => {
    // 200K 창의 90% = 180K 사용, 여유 20K → 압축
    expect(shouldAutoCompact(80, { used: 180_000, max: 200_000, pct: 90 })).toBe(true);
  });

  it('will not re-compact until the context regrew past the last compact point', () => {
    const at = { used: 900_000, max: 1_000_000, pct: 90 };
    expect(shouldAutoCompact(50, at, { lastAutoCompact: { postCompactTokens: 890_000 } })).toBe(false);
    expect(shouldAutoCompact(50, at, { lastAutoCompact: { postCompactTokens: 900_000 - MIN_REGROWTH_TOKENS } })).toBe(true);
    // 기록이 없거나 형식이 깨진 세션은 히스테리시스를 건너뛴다.
    expect(shouldAutoCompact(50, at, {})).toBe(true);
    expect(shouldAutoCompact(50, at, { lastAutoCompact: {} })).toBe(true);
    expect(shouldAutoCompact(50, at, { lastAutoCompact: { postCompactTokens: null } })).toBe(true);
    // 옛 형식(압축 '전' 값을 usedTokens 에 담던 기록)은 기준점으로 쓰지 않는다.
    expect(shouldAutoCompact(50, at, { lastAutoCompact: { usedTokens: 890_000 } })).toBe(true);
  });
});

describe('compactSession', () => {
  const session = {
    id: 'sess-1',
    title: 'T',
    agentId: 'agent-a',
    messages: Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `msg-${i}-`.repeat(200),
      ts: `2026-09-0${(i % 9) + 1}`
    }))
  };

  it('summarizes older messages and keeps the last 10 verbatim', () => {
    const summary = buildCompactSummary(session);
    expect(summary).toContain('### 이전 대화 (30개 메시지, 압축됨)');
    expect(summary).toContain('### 최근 대화 (10개 메시지, 전문)');
  });

  it('seeds a new session with the summary and publishes session.compacted', async () => {
    const store = fakeStore(session);
    const published = [];
    const result = await compactSession({
      session,
      sessionsStore: store,
      eventBus: { publish: (topic, payload) => published.push({ topic, payload }) }
    });

    expect(result.newSessionId).toBe('new-0');
    expect(store.created[0].title).toBe('T');
    expect(store.created[0].messages[0].role).toBe('user');
    expect(store.created[0].messages[0].content).toContain('[이전 세션에서 이어짐]');
    expect(published[0].topic).toBe('session.compacted');
    expect(result.savings).toBeGreaterThan(0);
  });

  it('carries the lineage forward so 2nd-gen compacts share the root', async () => {
    const store = fakeStore(session);
    await compactSession({ session, sessionsStore: store });

    const gen1 = store.created[0];
    expect(gen1.compactRoot).toBe('sess-1');
    expect(gen1.compactGen).toBe(1);

    // 2세대: 1세대 결과를 다시 압축해도 root 는 원본 세션이어야 한다.
    await compactSession({
      session: { ...gen1, messages: session.messages },
      sessionsStore: store
    });

    const gen2 = store.created[1];
    expect(gen2.compactRoot).toBe('sess-1');
    expect(gen2.compactGen).toBe(2);
    expect(gen2.title).toBe('T');
  });

  it('strips a legacy " (compact)" suffix instead of stacking another', () => {
    expect(stripCompactSuffix('T (compact)')).toBe('T');
    expect(stripCompactSuffix('T (compact) (compact)')).toBe('T');
    expect(stripCompactSuffix('T')).toBe('T');
  });

  it('inPlace replaces the live session in situ and archives the original', async () => {
    const store = fakeStore(session);
    const published = [];
    const result = await compactSession({
      session,
      sessionsStore: store,
      eventBus: { publish: (topic, payload) => published.push({ topic, payload }) },
      inPlace: true
    });

    // 폭주의 핵심: fork 하면 러너가 계속 쓰는 세션이 그대로 남아 매 턴 재압축된다.
    expect(result.inPlace).toBe(true);
    expect(result.newSessionId).toBe('sess-1');

    const live = store.get('sess-1');
    expect(live.messages).toHaveLength(1);
    expect(live.messages[0].role).toBe('user');
    expect(live.messages[0].content).toContain('[이전 세션에서 이어짐]');
    expect(live.messages[0].ts).toBeTruthy();
    // 다음 턴이 fresh start 로 잡혀 persona 가 재주입돼야 한다.
    expect(live.claudeSessionId).toBeNull();
    expect(live.personaBakedInto).toBeNull();
    expect(live.compactRoot).toBe('sess-1');
    expect(live.compactGen).toBe(1);

    // 원본 히스토리는 사이드바에 안 보이는 아카이브 세션으로 보존.
    const archived = store.get(result.archivedSessionId);
    expect(archived._archived).toBe(true);
    expect(archived.messages).toHaveLength(40);
    expect(archived.compactGen).toBe(0);
    expect(archived.compactRoot).toBe('sess-1');
    expect(published[0].payload.inPlace).toBe(true);
  });

  it('inPlace compaction drops the reading below the threshold, so it fires once', async () => {
    const live = {
      id: 'sess-1',
      title: 'T',
      agentId: 'agent-a',
      claudeSessionId: 'cli-1',
      messages: [...session.messages, { role: 'assistant', content: 'a', usage: { contextTokens: 900_000 } }]
    };
    const store = fakeStore(live);
    const usageBefore = sessionContextUsage(store.get('sess-1'), { model: 'claude-opus-5' });
    expect(shouldAutoCompact(50, usageBefore, store.get('sess-1'))).toBe(true);

    await compactSession({ session: store.get('sess-1'), sessionsStore: store, inPlace: true });
    await store.update('sess-1', {
      lastAutoCompact: { at: 'now', compactedAtTokens: usageBefore.used, postCompactTokens: null }
    });

    // 압축 직후에는 usage 를 실은 assistant 턴이 없으므로 재압축 판단 자체가 불가 → false.
    const after = store.get('sess-1');
    expect(sessionContextUsage(after, { model: 'claude-opus-5' })).toBeNull();
    expect(shouldAutoCompact(50, sessionContextUsage(after, { model: 'claude-opus-5' }), after)).toBe(false);
  });

  it('inPlace preserves the pre-compact claudeSessionId on the archive', async () => {
    const store = fakeStore({ ...session, claudeSessionId: 'cli-abc' });
    const result = await compactSession({ session: store.get('sess-1'), sessionsStore: store, inPlace: true });
    expect(store.get(result.archivedSessionId).claudeSessionId).toBe('cli-abc');
  });

  it('throws EMPTY_SESSION with no messages', async () => {
    await expect(
      compactSession({ session: { id: 'x', title: 't', agentId: 'a', messages: [] }, sessionsStore: fakeStore() })
    ).rejects.toMatchObject({ code: 'EMPTY_SESSION' });
  });
});

describe('auto-compact hysteresis across cycles', () => {
  const MODEL = 'claude-opus-5'; // 1M 창
  const PCT = 50;

  /** 한 턴이 끝난 상태를 만든다 — 마지막 assistant 턴의 contextTokens 가 곧 측정 사용량. */
  async function turn(store, id, contextTokens) {
    await store.appendMessage(id, { role: 'user', content: 'u', ts: 't' });
    await store.appendMessage(id, assistant({ contextTokens }, { ts: 't' }));
  }

  /**
   * message-sender.js 의 maybeAutoCompact 결정 로직을 같은 순서로 재현한다.
   * (실제 함수들을 그대로 호출 — 기준점을 어디서 읽고 어디에 쓰는지가 이 테스트의 대상)
   */
  async function autoCompactTurn(store, id) {
    const live = store.get(id);
    const usage = sessionContextUsage(live, { model: MODEL });
    const settled = settleAutoCompactBaseline(live, usage);
    if (settled) await store.update(id, { lastAutoCompact: settled });
    const gated = settled ? { ...live, lastAutoCompact: settled } : live;
    if (!shouldAutoCompact(PCT, usage, gated)) return false;

    await compactSession({ session: store.get(id), sessionsStore: store, inPlace: true });
    // 압축 후 사용량은 지금 알 수 없다 → 비워 두고 다음 턴에 확정.
    await store.update(id, {
      lastAutoCompact: { at: 'now', compactedAtTokens: usage.used, postCompactTokens: null }
    });
    return true;
  }

  const fresh = () => fakeStore({ id: 'sess-1', title: 'T', agentId: 'agent-a', messages: [] });

  // 래칫 회귀: 기준점을 압축 '전' 값으로 남기면 문턱이 사이클마다 +MIN_REGROWTH 씩
  // 올라가 두 번째 사이클부터 압축이 막히고, 1M 창에서는 끝내 영원히 불가능해진다.
  it('compacts every cycle — 기준점이 압축 후 값이라 문턱이 올라가지 않는다', async () => {
    const store = fresh();
    const fired = [];

    for (let cycle = 0; cycle < 6; cycle++) {
      const trigger = 880_000 + cycle * 20_000; // 창이 차오르는 지점은 사이클마다 다르다
      await turn(store, 'sess-1', trigger);
      expect(await autoCompactTurn(store, 'sess-1')).toBe(true);
      fired.push(trigger);

      const compacted = store.get('sess-1');
      expect(compacted.messages).toHaveLength(1); // 요약 seed 한 개
      expect(compacted.lastAutoCompact.postCompactTokens).toBeNull();
      expect(compacted.lastAutoCompact.compactedAtTokens).toBe(trigger);

      // 압축 후 첫 턴: 실제로 줄어든 사용량이 여기서 측정돼 기준점이 된다.
      const postCompact = 60_000 + cycle;
      await turn(store, 'sess-1', postCompact);
      expect(await autoCompactTurn(store, 'sess-1')).toBe(false);
      expect(store.get('sess-1').lastAutoCompact.postCompactTokens).toBe(postCompact);
    }

    expect(fired).toEqual([880_000, 900_000, 920_000, 940_000, 960_000, 980_000]);
  });

  it('still breaks the runaway when a compaction fails to shrink the session', async () => {
    const store = fresh();
    await turn(store, 'sess-1', 900_000);
    expect(await autoCompactTurn(store, 'sess-1')).toBe(true);

    // 압축했는데도 사용량이 그대로 = 요약이 이미 거대한 경우. 매 턴 재압축하면 안 된다.
    await turn(store, 'sess-1', 900_000);
    expect(await autoCompactTurn(store, 'sess-1')).toBe(false);
    expect(store.get('sess-1').lastAutoCompact.postCompactTokens).toBe(900_000);

    await turn(store, 'sess-1', 900_000 + MIN_REGROWTH_TOKENS - 1);
    expect(await autoCompactTurn(store, 'sess-1')).toBe(false);

    await turn(store, 'sess-1', 900_000 + MIN_REGROWTH_TOKENS);
    expect(await autoCompactTurn(store, 'sess-1')).toBe(true);
  });

  it('settles a pending baseline only, and leaves other shapes alone', () => {
    const usage = { used: 42_000, max: 1_000_000, pct: 4.2 };
    expect(settleAutoCompactBaseline({ lastAutoCompact: { at: 'now', postCompactTokens: null } }, usage))
      .toEqual({ at: 'now', postCompactTokens: 42_000 });
    // 이미 확정된 기준점은 덮어쓰지 않는다 — 덮어쓰면 그게 곧 래칫이다.
    expect(settleAutoCompactBaseline({ lastAutoCompact: { postCompactTokens: 30_000 } }, usage)).toBeNull();
    // 압축 이력이 없거나, 측정값이 없으면 할 일이 없다.
    expect(settleAutoCompactBaseline({}, usage)).toBeNull();
    expect(settleAutoCompactBaseline({ lastAutoCompact: { postCompactTokens: null } }, null)).toBeNull();
    // 옛 형식(usedTokens 에 압축 전 값)은 건드리지 않는다 — 다음 압축 때 새 형식으로 교체된다.
    expect(settleAutoCompactBaseline({ lastAutoCompact: { at: 'old', usedTokens: 900_000 } }, usage)).toBeNull();
  });
});
