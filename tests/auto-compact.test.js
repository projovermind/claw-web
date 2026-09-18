import { describe, it, expect } from 'vitest';
import {
  shouldAutoCompact,
  settleAutoCompactBaseline,
  buildCompactSummary,
  compactSession,
  stripCompactSuffix,
  extractFilePaths,
  renderToolCall,
  MIN_COMPACTABLE_TOKENS,
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
  /** 1M 창에서 pct% 를 쓴 상태 — 실제 운영 세션과 같은 모양. */
  const usage = (pct) => ({ used: 1_000_000 * (pct / 100), max: 1_000_000, pct });

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

  describe('압축 가치 하한', () => {
    it('skips a session too small to be worth the cold start', () => {
      // 임계는 넘겼지만 쌓인 게 얼마 없다 — 캐시를 날릴 값어치가 없다.
      expect(shouldAutoCompact(50, { used: MIN_COMPACTABLE_TOKENS - 1, max: 200_000, pct: 50 })).toBe(false);
      // 200K 창의 90% 라도 20K 짜리 세션은 줄일 게 없다.
      expect(shouldAutoCompact(80, { used: 20_000, max: 200_000, pct: 90 })).toBe(false);
    });

    it('fires as soon as the value floor is met', () => {
      expect(shouldAutoCompact(50, { used: MIN_COMPACTABLE_TOKENS, max: 200_000, pct: 50 })).toBe(true);
    });

    it('lets the percentage alone decide the trigger on a 1M window', () => {
      // 옛 여유 하한은 1M 창에서 pct 와 무관하게 used 800K 이전 압축을 막았다.
      // 사용자가 85 로 잡았으면 850K 에서 압축돼야 한다.
      expect(shouldAutoCompact(85, { used: 850_000, max: 1_000_000, pct: 85 })).toBe(true);
      // 50 으로 잡았으면 500K 에서 — 여유가 500K 남아 있어도 사용자 설정이 우선이다.
      expect(shouldAutoCompact(50, { used: 500_000, max: 1_000_000, pct: 50 })).toBe(true);
      // 임계 미만은 여전히 안 한다.
      expect(shouldAutoCompact(85, { used: 840_000, max: 1_000_000, pct: 84 })).toBe(false);
    });

    it('does not depend on the window size at all', () => {
      // 창을 몰라도(0) 게이트는 used 만 본다.
      expect(shouldAutoCompact(80, { used: 150_000, max: 0, pct: 90 })).toBe(true);
      expect(shouldAutoCompact(80, { used: 50_000, max: 0, pct: 90 })).toBe(false);
    });

    it('leaves runaway prevention to the regrowth hysteresis', () => {
      // 32회 폭주는 fork 버그였고 in-place 로 해결됐다. 재압축은 히스테리시스가 막는다.
      const at = { used: 520_000, max: 1_000_000, pct: 52 };
      expect(shouldAutoCompact(50, at)).toBe(true);
      expect(shouldAutoCompact(50, at, { lastAutoCompact: { postCompactTokens: 500_000 } })).toBe(false);
    });
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

describe('buildCompactSummary — 신호 보존', () => {
  const msg = (role, content, toolCalls) => ({ role, content, ts: '2026-09-18', ...(toolCalls ? { toolCalls } : {}) });

  /** 앞 200자 뒤에 결론이 숨어 있는, 실제 워커 응답을 닮은 메시지. */
  const padded = (head, tail) => `${head}\n${'x'.repeat(400)}\n${tail}`;

  function sessionWith(extra = []) {
    return {
      id: 'sess-x',
      title: 'T',
      agentId: 'cw_server',
      messages: [
        ...extra,
        // RECENT(10) 를 채워 extra 가 '이전 대화' 로 밀리게 한다.
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `recent-${i}`))
      ]
    };
  }

  it('keeps a decision that sits past the old 200-char cutoff', () => {
    const s = sessionWith([msg('assistant', padded('시작합니다', '결론: worktree 대신 in-place 로 가기로 했습니다'))]);
    const summary = buildCompactSummary(s);
    expect(summary).toContain('## 주요 결정');
    expect(summary).toContain('worktree 대신 in-place 로 가기로 했습니다');
  });

  it('keeps unresolved items that sit past the old 200-char cutoff', () => {
    const s = sessionWith([msg('assistant', padded('작업 중', 'TODO: backend-usage 캐시 만료가 아직 실패합니다'))]);
    const summary = buildCompactSummary(s);
    expect(summary).toContain('## 미해결 항목');
    expect(summary).toContain('backend-usage 캐시 만료가 아직 실패합니다');
  });

  it('collects file paths from both prose and tool inputs, skipping URLs', () => {
    const s = sessionWith([
      msg('assistant', padded('수정', '고친 곳은 server/lib/compact.js:207 입니다. 참고 https://example.com/a/b.html'), [
        { name: 'Edit', input: { file_path: '/Volumes/Core/claw-web/server/routes/sessions.js' } },
        { name: 'Bash', input: { command: 'npx vitest run tests/auto-compact.test.js' } }
      ])
    ]);
    const summary = buildCompactSummary(s);
    expect(summary).toContain('## 관련 파일');
    expect(summary).toContain('server/lib/compact.js');
    expect(summary).toContain('/Volumes/Core/claw-web/server/routes/sessions.js');
    expect(summary).toContain('tests/auto-compact.test.js');
    // URL 은 경로 목록에 섞이지 않는다 (본문 다이제스트에는 그대로 남는다).
    const fileSection = summary.slice(summary.indexOf('## 관련 파일'), summary.indexOf('## 대화 요약'));
    expect(fileSection).not.toContain('example.com');
    expect(extractFilePaths('참고 https://example.com/a/b.html 와 src/a.ts')).toEqual(['src/a.ts']);
  });

  it('reports the current work state from the last turn on each side', () => {
    const s = {
      id: 'sess-y',
      title: 'T',
      agentId: 'a',
      messages: [msg('user', '컴팩트 요약을 고쳐줘'), msg('assistant', '헤드룸 하한을 함수로 뺐습니다')]
    };
    const summary = buildCompactSummary(s);
    expect(summary).toContain('## 작업 상태');
    expect(summary).toContain('- 마지막 지시: 컴팩트 요약을 고쳐줘');
    expect(summary).toContain('- 마지막 진행: 헤드룸 하한을 함수로 뺐습니다');
  });

  it('keeps recent tool calls verbatim instead of only counting them', () => {
    const s = {
      id: 'sess-z',
      title: 'T',
      agentId: 'a',
      messages: [
        msg('user', '테스트 돌려줘'),
        msg('assistant', '실행했습니다', [{ name: 'Bash', input: { command: 'npx vitest run', description: '테스트 실행' } }])
      ]
    };
    const summary = buildCompactSummary(s);
    expect(summary).toContain('**툴 호출:**');
    expect(summary).toContain('command=npx vitest run');
    expect(summary).toContain('description=테스트 실행');
    // 통계 표는 그대로 유지된다.
    expect(summary).toContain('- Bash: 1회');
  });

  it('truncates a single oversized tool argument rather than the whole section', () => {
    const huge = 'y'.repeat(5_000);
    const rendered = renderToolCall({ name: 'Write', input: { file_path: '/tmp/a.txt', content: huge } });
    expect(rendered).toContain('/tmp/a.txt');
    expect(rendered).toContain('5000자 중 앞부분');
    expect(rendered.length).toBeLessThan(2_000);
  });

  it('folds older recent-window tool calls when they blow the budget', () => {
    // 실측 재현: 최근 10개 메시지에 툴 호출 385건(인자 114KB). 건당 상한만으로는
    // 요약이 원본보다 커졌다.
    const many = Array.from({ length: 385 }, (_, i) => ({ name: 'Bash', input: { command: `cmd-${i} ${'z'.repeat(300)}` } }));
    const s = {
      id: 's',
      title: 'T',
      agentId: 'a',
      messages: [msg('user', '작업'), msg('assistant', '했습니다', many)]
    };
    const summary = buildCompactSummary(s);
    expect(summary).toContain('건 접힘: Bash×');
    // 가장 최근 호출은 원문으로 남는다.
    expect(summary).toContain('cmd-384');
    // 가장 오래된 호출은 접힌다.
    expect(summary).not.toContain('cmd-0 ');
    // 예산 상한(20K) + 본문 정도로 끝나야 한다.
    expect(summary.length).toBeLessThan(40_000);
  });

  it('renders a tool call with no input', () => {
    expect(renderToolCall({ name: 'ListAgents' })).toBe('`ListAgents`');
    expect(renderToolCall({ name: 'ListAgents', input: {} })).toBe('`ListAgents`');
  });

  it('keeps the tail of an older message, where the outcome usually is', () => {
    const s = sessionWith([msg('assistant', padded('착수', '최종 상태: 48 files / 532 tests 통과'))]);
    const summary = buildCompactSummary(s);
    expect(summary).toContain('48 files / 532 tests 통과');
  });

  it('notes tool usage inline in the older digest', () => {
    const s = sessionWith([
      msg('assistant', '고쳤습니다', [{ name: 'Edit', input: {} }, { name: 'Edit', input: {} }, { name: 'Bash', input: {} }])
    ]);
    expect(buildCompactSummary(s)).toContain('[Edit×2, Bash]');
  });

  it('caps the older listing so a 1000-message session cannot produce a giant summary', () => {
    const many = Array.from({ length: 600 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `old-${i} `.repeat(100)));
    const summary = buildCompactSummary(sessionWith(many));
    expect(summary).toContain('### 이전 대화 (600개 메시지, 압축됨)');
    expect(summary).toContain('앞쪽 480개는 목록에서 생략');
    expect(summary).not.toContain('old-0 ');
    expect(summary).toContain('old-599');
  });

  it('shrinks a realistic session well below its original size', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `메시지 ${i} `.repeat(200), [{ name: 'Bash', input: { command: `cmd-${i}` } }])
    );
    const s = sessionWith(many);
    const originalChars = s.messages.reduce((n, m) => n + m.content.length, 0);
    expect(buildCompactSummary(s).length).toBeLessThan(originalChars * 0.35);
  });

  it('omits extraction sections when there is nothing to extract', () => {
    const s = { id: 's', title: 'T', agentId: 'a', messages: [msg('user', '안녕')] };
    const summary = buildCompactSummary(s);
    expect(summary).not.toContain('## 관련 파일');
    expect(summary).not.toContain('## 주요 결정');
    expect(summary).not.toContain('## 미해결 항목');
  });

  it('survives messages with null content and missing fields', () => {
    const s = { id: 's', title: 'T', agentId: 'a', messages: [{ role: 'user' }, { role: 'assistant', content: null }] };
    expect(() => buildCompactSummary(s)).not.toThrow();
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths(undefined)).toEqual([]);
  });
});
