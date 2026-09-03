import { describe, it, expect } from 'vitest';
import { shouldAutoCompact, buildCompactSummary, compactSession } from '../server/lib/compact.js';
import { sessionContextUsage, resolveContextWindow, usedContextTokens } from '../server/lib/context-window.js';

const assistant = (usage, over = {}) => ({ role: 'assistant', content: 'a', usage, ...over });

describe('context-window (server port)', () => {
  it('prefers the backend-declared window, then the heuristic', () => {
    const backends = { b1: { contextWindows: { 'claude-x': 500_000 } } };
    expect(resolveContextWindow('claude-x', 'b1', backends)).toEqual({ tokens: 500_000, source: 'backend' });
    expect(resolveContextWindow('claude-x', 'missing', backends).tokens).toBe(500_000);
    expect(resolveContextWindow('claude-opus-5', null, null)).toEqual({ tokens: 200_000, source: 'heuristic' });
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
    const usage = sessionContextUsage(session, { model: 'claude-opus-5' });
    expect(usage).toEqual({ used: 150_000, max: 200_000, pct: 75 });
  });

  it('returns null when no turn carries usage', () => {
    expect(sessionContextUsage({ messages: [{ role: 'user', content: 'u' }] })).toBeNull();
    expect(sessionContextUsage({ messages: [assistant({ contextTokens: 0 })] })).toBeNull();
  });
});

describe('shouldAutoCompact threshold', () => {
  const usage = (pct) => ({ used: 1, max: 1, pct });

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
});

describe('compactSession', () => {
  function fakeStore(session) {
    const created = [];
    return {
      created,
      async create({ agentId, title }) {
        const s = { id: `new-${created.length}`, agentId, title, messages: [] };
        created.push(s);
        return s;
      },
      async appendMessage(id, msg) {
        created.find((s) => s.id === id).messages.push(msg);
      },
      session
    };
  }

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
    expect(store.created[0].title).toBe('T (compact)');
    expect(store.created[0].messages[0].role).toBe('user');
    expect(store.created[0].messages[0].content).toContain('[이전 세션에서 이어짐]');
    expect(published[0].topic).toBe('session.compacted');
    expect(result.savings).toBeGreaterThan(0);
  });

  it('throws EMPTY_SESSION with no messages', async () => {
    await expect(
      compactSession({ session: { id: 'x', title: 't', agentId: 'a', messages: [] }, sessionsStore: fakeStore() })
    ).rejects.toMatchObject({ code: 'EMPTY_SESSION' });
  });
});
