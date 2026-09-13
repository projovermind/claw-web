import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCalendarReminders,
  offsetLabel,
  reminderBaseEpoch,
  reminderFireAt,
  reminderKey,
} from '../server/lib/calendar-reminders.js';
import { createCalendarStore } from '../server/lib/calendar-store.js';

const KST = (s) => Date.parse(s);
const MIN = 60 * 1000;

describe('reminder time maths', () => {
  it('uses the event start for a timed event', () => {
    const ev = { start: '2026-09-20T14:00:00+09:00', allDay: false };
    expect(reminderBaseEpoch(ev)).toBe(KST('2026-09-20T14:00:00+09:00'));
    expect(reminderFireAt(ev, 30)).toBe(KST('2026-09-20T13:30:00+09:00'));
    expect(reminderFireAt(ev, 0)).toBe(KST('2026-09-20T14:00:00+09:00'));
    expect(reminderFireAt(ev, 1440)).toBe(KST('2026-09-19T14:00:00+09:00'));
  });

  it('anchors an all-day event at 09:00 KST', () => {
    const ev = { start: '2026-09-20', allDay: true };
    expect(reminderBaseEpoch(ev)).toBe(KST('2026-09-20T09:00:00+09:00'));
    expect(reminderFireAt(ev, 0)).toBe(KST('2026-09-20T09:00:00+09:00'));
    expect(reminderFireAt(ev, 1440)).toBe(KST('2026-09-19T09:00:00+09:00'));
  });

  it('returns null for an unparseable start', () => {
    expect(reminderBaseEpoch({ start: 'garbage' })).toBeNull();
    expect(reminderFireAt({ start: 'garbage' }, 30)).toBeNull();
  });

  it('keys by master id, occurrence date and offset', () => {
    expect(reminderKey({ id: 'cal_a@2026-09-20', masterId: 'cal_a', start: '2026-09-20T14:00:00+09:00' }, 30))
      .toBe('cal_a@2026-09-20#30');
    expect(reminderKey({ id: 'cal_b', start: '2026-09-20' }, 0)).toBe('cal_b@2026-09-20#0');
  });

  it('labels the offset in Korean', () => {
    expect(offsetLabel(0)).toBe('지금');
    expect(offsetLabel(10)).toBe('10분 후');
    expect(offsetLabel(60)).toBe('1시간 후');
    expect(offsetLabel(1440)).toBe('1일 후');
    expect(offsetLabel(90)).toBe('90분 후');
  });
});

describe('createCalendarReminders', () => {
  let dir;
  let store;
  let sent;
  let published;
  let pushStore;
  let eventBus;

  const make = (over = {}) => createCalendarReminders({
    calendarStore: store,
    pushStore,
    eventBus,
    filePath: path.join(dir, 'calendar-fired.json'),
    ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-rem-'));
    store = createCalendarStore(path.join(dir, 'calendar.json'));
    sent = [];
    published = [];
    pushStore = { sendPushToAll: async (title, body, opts) => { sent.push({ title, body, opts }); } };
    eventBus = { publish: (topic, payload) => published.push({ topic, payload }) };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fires a reminder whose time fell inside this tick', async () => {
    await store.create({
      title: '팀 회의', start: '2026-09-20T14:00:00+09:00',
      location: '회의실 A', remindMinutes: [30],
    });
    const reminders = make();

    // 13:30 직후 tick → 30분 전 알림이 구간에 들어온다.
    const res = await reminders.runOnce(KST('2026-09-20T13:30:30+09:00'));
    expect(res).toMatchObject({ due: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('📅 30분 후 · 팀 회의');
    expect(sent[0].body).toBe('9/20(일) 14:00 · 회의실 A');
    expect(sent[0].opts).toEqual({ skipIdleCheck: true, url: '/calendar' });
  });

  it('publishes calendar.reminder on the bus', async () => {
    await store.create({ title: '점검', start: '2026-09-20T14:00:00+09:00', remindMinutes: [0] });
    await make().runOnce(KST('2026-09-20T14:00:10+09:00'));
    expect(published.map((p) => p.topic)).toEqual(['calendar.reminder']);
    expect(published[0].payload.minutes).toBe(0);
  });

  it('falls back to the first notes line when there is no location', async () => {
    await store.create({
      title: '점검', start: '2026-09-20T14:00:00+09:00',
      notes: '\n디스크 교체\n두 번째 줄', remindMinutes: [0],
    });
    await make().runOnce(KST('2026-09-20T14:00:10+09:00'));
    expect(sent[0].body).toBe('9/20(일) 14:00 · 디스크 교체');
  });

  it('does not fire before or after the tick window', async () => {
    await store.create({ title: '회의', start: '2026-09-20T14:00:00+09:00', remindMinutes: [30] });
    const reminders = make();

    await reminders.runOnce(KST('2026-09-20T13:00:00+09:00')); // 아직 이름
    expect(sent).toHaveLength(0);
    await reminders.runOnce(KST('2026-09-20T13:20:00+09:00')); // 여전히 전
    expect(sent).toHaveLength(0);
  });

  it('ignores events without remindMinutes', async () => {
    await store.create({ title: '조용한 일정', start: '2026-09-20T14:00:00+09:00' });
    await make().runOnce(KST('2026-09-20T14:00:10+09:00'));
    expect(sent).toHaveLength(0);
  });

  it('fires an all-day reminder at 09:00 KST, not midnight', async () => {
    await store.create({ title: '워크샵', start: '2026-09-20', allDay: true, remindMinutes: [0] });
    const reminders = make();

    await reminders.runOnce(KST('2026-09-20T00:00:30+09:00'));
    expect(sent).toHaveLength(0);

    await reminders.runOnce(KST('2026-09-20T09:00:30+09:00'));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('📅 지금 · 워크샵');
    expect(sent[0].body).toBe('9/20(일) 종일');
  });

  it('fires each offset of the same event exactly once', async () => {
    await store.create({
      title: '릴리스', start: '2026-09-20T14:00:00+09:00', remindMinutes: [0, 30, 1440],
    });
    const reminders = make();

    await reminders.runOnce(KST('2026-09-19T14:00:30+09:00'));
    await reminders.runOnce(KST('2026-09-20T13:30:30+09:00'));
    await reminders.runOnce(KST('2026-09-20T14:00:30+09:00'));
    expect(sent.map((s) => s.title)).toEqual([
      '📅 1일 후 · 릴리스', '📅 30분 후 · 릴리스', '📅 지금 · 릴리스',
    ]);
  });

  it('does not resend after a restart (fired keys survive on disk)', async () => {
    await store.create({ title: '회의', start: '2026-09-20T14:00:00+09:00', remindMinutes: [30] });
    const first = make();
    await first.runOnce(KST('2026-09-20T13:30:30+09:00'));
    expect(sent).toHaveLength(1);
    expect(first.firedKeys()).toHaveLength(1);

    // 새 인스턴스 = 서버 재시작. 같은 구간을 다시 훑어도 두 번 가지 않는다.
    const restarted = make();
    expect(restarted.firedKeys()).toEqual(first.firedKeys());
    await restarted.runOnce(KST('2026-09-20T13:30:40+09:00'));
    expect(sent).toHaveLength(1);
  });

  it('fires per occurrence for a recurring event', async () => {
    await store.create({
      title: '데일리', start: '2026-09-20T10:00:00+09:00',
      recurrence: { freq: 'daily' }, remindMinutes: [0],
    });
    const reminders = make();

    await reminders.runOnce(KST('2026-09-20T10:00:30+09:00'));
    await reminders.runOnce(KST('2026-09-21T10:00:30+09:00'));
    expect(sent).toHaveLength(2);
    expect(reminders.firedKeys().sort()).toHaveLength(2);
    expect(reminders.firedKeys().every((k) => k.endsWith('#0'))).toBe(true);
  });

  it('skips an occurrence that was excluded via exdates', async () => {
    const ev = await store.create({
      title: '데일리', start: '2026-09-20T10:00:00+09:00',
      recurrence: { freq: 'daily' }, remindMinutes: [0],
    });
    await store.excludeOccurrence(`${ev.id}@2026-09-21`);
    const reminders = make();

    await reminders.runOnce(KST('2026-09-20T10:00:30+09:00'));
    await reminders.runOnce(KST('2026-09-21T10:00:30+09:00'));
    expect(sent.map((s) => s.title)).toEqual(['📅 지금 · 데일리']);
  });

  it('marks a reminder as fired even when the push send throws', async () => {
    await store.create({ title: '회의', start: '2026-09-20T14:00:00+09:00', remindMinutes: [0] });
    pushStore = { sendPushToAll: async () => { throw new Error('no subscriptions'); } };
    const reminders = make();

    const res = await reminders.runOnce(KST('2026-09-20T14:00:30+09:00'));
    expect(res).toMatchObject({ due: 1, sent: 0 });
    expect(reminders.firedKeys()).toHaveLength(1);
  });

  it('works without a pushStore (bus-only)', async () => {
    await store.create({ title: '회의', start: '2026-09-20T14:00:00+09:00', remindMinutes: [0] });
    const reminders = make({ pushStore: null });
    await expect(reminders.runOnce(KST('2026-09-20T14:00:30+09:00')))
      .resolves.toMatchObject({ due: 1, sent: 1 });
    expect(published).toHaveLength(1);
  });

  it('start/stop are idempotent and do not leave a timer behind', () => {
    const reminders = make({ intervalMs: 60_000 });
    reminders.start();
    reminders.start();
    reminders.stop();
    reminders.stop();
    expect(sent).toHaveLength(0);
  });
});
