import { describe, it, expect, beforeEach } from 'vitest';
import { createDelegationRetention } from '../server/lib/delegation-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-10T00:00:00.000Z');

function daysAgo(n) {
  return new Date(NOW - n * DAY).toISOString();
}

/** sessionsStore 의 list/remove 만 흉내낸 최소 더블. */
function fakeSessionsStore(sessions) {
  const map = new Map(sessions.map((s) => [s.id, s]));
  return {
    removed: [],
    list() { return [...map.values()]; },
    async remove(id) {
      if (!map.has(id)) return;
      map.delete(id);
      this.removed.push(id);
    }
  };
}

function fakeTracker({ active = [], activeOrigins = [] } = {}) {
  return {
    list: () => active.map((targetSessionId) => ({ targetSessionId })),
    hasActiveByOrigin: (id) => activeOrigins.includes(id)
  };
}

function makeRetention(store, tracker, opts = {}) {
  return createDelegationRetention({
    sessionsStore: store,
    delegationTracker: tracker,
    retentionDays: 30,
    dryRun: false,
    now: () => NOW,
    ...opts
  });
}

describe('createDelegationRetention', () => {
  let store;

  beforeEach(() => {
    store = fakeSessionsStore([
      { id: 'old-done', title: '[위임] 오래된 완료 작업', updatedAt: daysAgo(45) },
      { id: 'fresh', title: '[위임] 어제 작업', updatedAt: daysAgo(1) },
      { id: 'plain-old', title: '일반 대화', updatedAt: daysAgo(90) },
      { id: 'old-running', title: '[위임] 아직 도는 중', updatedAt: daysAgo(45) },
      { id: 'old-awaiting', title: '[위임] 회신 안 한 것', updatedAt: daysAgo(60) },
      { id: 'old-parent', title: '[위임] 하위 위임 대기 중', updatedAt: daysAgo(60) }
    ]);
  });

  it('deletes only expired, finished delegation sessions', async () => {
    const tracker = fakeTracker({ active: ['old-awaiting'], activeOrigins: ['old-parent'] });
    const runner = { isRunning: (id) => id === 'old-running' };
    const res = await makeRetention(store, tracker, { runner }).runOnce();

    expect(store.removed).toEqual(['old-done']);
    expect(res).toMatchObject({ deleted: 1, candidates: 1, dryRun: false, disabled: false });
    expect(res.protected).toBe(3);
  });

  it('never touches non-delegation sessions however old', async () => {
    await makeRetention(store, fakeTracker(), { retentionDays: 1 }).runOnce();
    expect(store.removed).not.toContain('plain-old');
  });

  it('protects sessions still awaiting a report or running', async () => {
    const tracker = fakeTracker({ active: ['old-awaiting'], activeOrigins: ['old-parent'] });
    const runner = { isRunning: (id) => id === 'old-running' };
    await makeRetention(store, tracker, { runner, retentionDays: 1 }).runOnce();

    for (const id of ['old-awaiting', 'old-parent', 'old-running']) {
      expect(store.removed).not.toContain(id);
    }
  });

  it('dry-run reports candidates without deleting', async () => {
    const tracker = fakeTracker({ active: ['old-awaiting'], activeOrigins: ['old-parent'] });
    const runner = { isRunning: (id) => id === 'old-running' };
    const res = await makeRetention(store, tracker, { runner, dryRun: true }).runOnce();
    expect(res).toMatchObject({ deleted: 0, candidates: 1, dryRun: true });
    expect(store.removed).toEqual([]);
  });

  it('is disabled when retentionDays is 0', async () => {
    const res = await makeRetention(store, fakeTracker(), { retentionDays: 0 }).runOnce();
    expect(res.disabled).toBe(true);
    expect(store.removed).toEqual([]);
  });

  it('start() schedules nothing when disabled', async () => {
    const retention = makeRetention(store, fakeTracker(), { retentionDays: 0 });
    retention.start();
    retention.stop();
    expect(store.removed).toEqual([]);
  });

  it('keeps sessions with an unparseable updatedAt', async () => {
    const weird = fakeSessionsStore([
      { id: 'no-date', title: '[위임] 날짜 없음' },
      { id: 'bad-date', title: '[위임] 이상한 날짜', updatedAt: 'not-a-date' }
    ]);
    const res = await makeRetention(weird, fakeTracker(), { retentionDays: 1 }).runOnce();
    expect(res.candidates).toBe(0);
    expect(weird.removed).toEqual([]);
  });

  it('survives a remove() failure and keeps going', async () => {
    const twoOld = fakeSessionsStore([
      { id: 'boom', title: '[위임] 실패할 것', updatedAt: daysAgo(40) },
      { id: 'ok', title: '[위임] 성공할 것', updatedAt: daysAgo(40) }
    ]);
    const origRemove = twoOld.remove.bind(twoOld);
    twoOld.remove = async (id) => {
      if (id === 'boom') throw new Error('disk on fire');
      return origRemove(id);
    };
    const res = await makeRetention(twoOld, fakeTracker()).runOnce();
    expect(res).toMatchObject({ deleted: 1, candidates: 2 });
    expect(twoOld.removed).toEqual(['ok']);
  });

  it('works without a runner or tracker helpers', async () => {
    const bare = fakeSessionsStore([
      { id: 'old-done', title: '[위임] 오래된 완료 작업', updatedAt: daysAgo(45) }
    ]);
    const res = await createDelegationRetention({
      sessionsStore: bare,
      delegationTracker: {},
      retentionDays: 30,
      dryRun: false,
      now: () => NOW
    }).runOnce();
    expect(res.deleted).toBe(1);
  });
});
