import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { computeDelegationTierStats } from '../server/lib/delegation-tier-stats.js';

let dir;
let tracker;

function fakeSessionsStore(sessions) {
  return { get: (id) => sessions[id] ?? null };
}

function sessionWithTokens(input, output) {
  return { messages: [{ usage: { inputTokens: input, outputTokens: output } }] };
}

/** delegationTracker 와 같은 모양(list/listRecent)만 흉내낸 가짜 — escalated
 *  필드는 아직 실제 tracker 가 기록하지 않으므로, 집계 로직만 독립적으로
 *  검증하려면 엔트리를 직접 주입해야 한다. */
function fakeTracker(entries) {
  return { list: () => [], listRecent: () => entries };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-tier-stats-'));
  tracker = createDelegationTracker({
    filePath: path.join(dir, 'delegations.json'),
    reportsDir: path.join(dir, 'reports')
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('computeDelegationTierStats', () => {
  it('counts delegations per tier and totals across active + finished', () => {
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'A', tier: 'middle' });
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w2', targetAgentId: 'cw_ui', task: 'B', tier: 'low' });
    tracker.complete('w2', 'done');
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w3', targetAgentId: 'cw_ui', task: 'C', tier: 'middle' });
    tracker.fail('w3', 'boom');

    const stats = computeDelegationTierStats({ delegationTracker: tracker, sessionsStore: fakeSessionsStore({}) });

    const middle = stats.tiers.find((t) => t.tier === 'middle');
    const low = stats.tiers.find((t) => t.tier === 'low');
    expect(middle.delegationCount).toBe(2);
    expect(low.delegationCount).toBe(1);
    expect(stats.totals.delegationCount).toBe(3);
  });

  it('buckets entries with no tier under "unknown" instead of dropping them', () => {
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'A' });

    const stats = computeDelegationTierStats({ delegationTracker: tracker, sessionsStore: fakeSessionsStore({}) });

    expect(stats.tiers).toEqual([
      expect.objectContaining({ tier: 'unknown', delegationCount: 1 })
    ]);
  });

  it('실측(실제 tracker): 티어 명시 + 정상 완료 3건이면 escalatedCount=0, 그중 1건이 escalate 로 끝나면 1', () => {
    // 성공 판정 시나리오 그대로 — fakeTracker 가 아니라 실제
    // createDelegationTracker + complete(..., escalated) 경로로 검증한다.
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'A', tier: 'high', tierOverridden: true });
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w2', targetAgentId: 'cw_server', task: 'B', tier: 'high', tierOverridden: true });
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w3', targetAgentId: 'cw_server', task: 'C', tier: 'high', tierOverridden: true });
    tracker.complete('w1', 'ok');
    tracker.complete('w2', 'ok');
    tracker.complete('w3', 'ok');

    const before = computeDelegationTierStats({ delegationTracker: tracker, sessionsStore: fakeSessionsStore({}) });
    const highBefore = before.tiers.find((t) => t.tier === 'high');
    expect(highBefore.tierSpecifiedCount).toBe(3);
    expect(highBefore.escalatedCount).toBe(0);

    tracker.create({ originSessionId: 'lead', targetSessionId: 'w4', targetAgentId: 'cw_server', task: 'D', tier: 'high', tierOverridden: true });
    tracker.complete('w4', 'ok', null, true);

    const after = computeDelegationTierStats({ delegationTracker: tracker, sessionsStore: fakeSessionsStore({}) });
    const highAfter = after.tiers.find((t) => t.tier === 'high');
    expect(highAfter.tierSpecifiedCount).toBe(4);
    expect(highAfter.escalatedCount).toBe(1);
  });

  it('tierSpecifiedCount counts tierOverridden — a request, not an outcome', () => {
    const stats = computeDelegationTierStats({
      delegationTracker: fakeTracker([
        { tier: 'high', tierOverridden: true, escalated: false, targetSessionId: 'w1' },
        { tier: 'high', tierOverridden: true, escalated: false, targetSessionId: 'w2' },
        { tier: 'high', tierOverridden: false, escalated: false, targetSessionId: 'w3' }
      ]),
      sessionsStore: fakeSessionsStore({})
    });

    const high = stats.tiers.find((t) => t.tier === 'high');
    expect(high.tierSpecifiedCount).toBe(2);
    expect(high.escalatedCount).toBe(0);
  });

  it('escalatedCount only counts entries that actually escalated — not merely tier-specified ones', () => {
    // 성공 판정: 티어 명시 + 정상 완료 위임 3건이면 escalatedCount=0,
    // 그중 하나가 escalate 로 끝나면 escalatedCount=1.
    const normal = { tier: 'high', tierOverridden: true, escalated: false };
    const stats1 = computeDelegationTierStats({
      delegationTracker: fakeTracker([
        { ...normal, targetSessionId: 'w1' },
        { ...normal, targetSessionId: 'w2' },
        { ...normal, targetSessionId: 'w3' }
      ]),
      sessionsStore: fakeSessionsStore({})
    });
    expect(stats1.tiers.find((t) => t.tier === 'high').escalatedCount).toBe(0);
    expect(stats1.totals.escalatedCount).toBe(0);

    const stats2 = computeDelegationTierStats({
      delegationTracker: fakeTracker([
        { ...normal, targetSessionId: 'w1' },
        { ...normal, targetSessionId: 'w2' },
        { tier: 'high', tierOverridden: true, escalated: true, targetSessionId: 'w3' }
      ]),
      sessionsStore: fakeSessionsStore({})
    });
    const high2 = stats2.tiers.find((t) => t.tier === 'high');
    expect(high2.escalatedCount).toBe(1);
    expect(high2.escalationRate).toBeCloseTo(1 / 3);
    expect(stats2.totals.escalatedCount).toBe(1);
  });

  it('sums session token usage per tier, deduped by session id', () => {
    const sessions = fakeSessionsStore({
      w1: sessionWithTokens(100, 50),
      w2: sessionWithTokens(10, 5)
    });
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'A', tier: 'high' });
    tracker.complete('w1', 'done');
    // Same session reused for a second delegation at the same tier (resume) —
    // its tokens must not be counted twice.
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'A2', tier: 'high' });
    tracker.create({ originSessionId: 'lead', targetSessionId: 'w2', targetAgentId: 'cw_ui', task: 'B', tier: 'low' });

    const stats = computeDelegationTierStats({ delegationTracker: tracker, sessionsStore: sessions });

    const high = stats.tiers.find((t) => t.tier === 'high');
    const low = stats.tiers.find((t) => t.tier === 'low');
    expect(high.totalTokens).toBe(150);
    expect(low.totalTokens).toBe(15);
    expect(stats.totals.totalTokens).toBe(165);
  });

  it('handles a session missing from the store without throwing', () => {
    tracker.create({ originSessionId: 'lead', targetSessionId: 'ghost', targetAgentId: 'cw_server', task: 'A', tier: 'middle' });

    const stats = computeDelegationTierStats({ delegationTracker: tracker, sessionsStore: fakeSessionsStore({}) });

    expect(stats.tiers.find((t) => t.tier === 'middle').totalTokens).toBe(0);
  });
});
