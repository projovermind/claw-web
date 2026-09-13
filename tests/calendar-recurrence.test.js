import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_OCCURRENCES,
  expandOccurrences,
  normalizeExdates,
  normalizeRecurrence,
  normalizeRemindMinutes,
  parseOccurrenceId,
  toMasterId,
} from '../server/lib/calendar-recurrence.js';
import { createCalendarStore } from '../server/lib/calendar-store.js';

const KST = (s) => Date.parse(s);

/** 전개 범위를 'YYYY-MM-DD' 로 주기 위한 헬퍼. */
const range = (from, to) => ({
  from: KST(`${from}T00:00:00+09:00`),
  to: KST(`${to}T23:59:59.999+09:00`),
});

/** 발생분 목록 → 시작 날짜만. */
const dates = (occs) => occs.map((o) => o.start.slice(0, 10));

const master = (over = {}) => ({
  id: 'cal_abcd1234',
  title: '반복',
  start: '2026-03-02T09:00:00+09:00',
  end: null,
  allDay: false,
  notes: '',
  location: '',
  color: null,
  tags: [],
  projectId: null,
  agentId: null,
  source: 'agent',
  recurrence: null,
  exdates: [],
  remindMinutes: [],
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  ...over,
});

describe('expandOccurrences', () => {
  it('passes a non-recurring event through when it overlaps the range', () => {
    const ev = master();
    expect(expandOccurrences(ev, range('2026-03-01', '2026-03-31'))).toEqual([ev]);
    expect(expandOccurrences(ev, range('2026-04-01', '2026-04-30'))).toEqual([]);
  });

  it('expands daily occurrences inside the range', () => {
    const ev = master({ recurrence: { freq: 'daily', interval: 1, until: null } });
    expect(dates(expandOccurrences(ev, range('2026-03-02', '2026-03-05'))))
      .toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  });

  it('never produces occurrences before the master start', () => {
    const ev = master({ recurrence: { freq: 'daily', interval: 1, until: null } });
    expect(dates(expandOccurrences(ev, range('2026-02-20', '2026-03-03'))))
      .toEqual(['2026-03-02', '2026-03-03']);
  });

  it('honours interval for daily and weekly', () => {
    const every3 = master({ recurrence: { freq: 'daily', interval: 3, until: null } });
    expect(dates(expandOccurrences(every3, range('2026-03-02', '2026-03-10'))))
      .toEqual(['2026-03-02', '2026-03-05', '2026-03-08']);

    const biweekly = master({ recurrence: { freq: 'weekly', interval: 2, until: null } });
    expect(dates(expandOccurrences(biweekly, range('2026-03-02', '2026-04-15'))))
      .toEqual(['2026-03-02', '2026-03-16', '2026-03-30', '2026-04-13']);
  });

  it('expands weekly on the same weekday', () => {
    const ev = master({ recurrence: { freq: 'weekly', interval: 1, until: null } });
    const occs = expandOccurrences(ev, range('2026-03-02', '2026-03-23'));
    expect(dates(occs)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23']);
    for (const o of occs) expect(new Date(Date.parse(o.start)).getUTCDay()).toBe(1); // 2026-03-02 는 월요일
  });

  it('expands monthly and yearly on the same day-of-month', () => {
    const monthly = master({ recurrence: { freq: 'monthly', interval: 1, until: null } });
    expect(dates(expandOccurrences(monthly, range('2026-03-01', '2026-06-30'))))
      .toEqual(['2026-03-02', '2026-04-02', '2026-05-02', '2026-06-02']);

    const yearly = master({ recurrence: { freq: 'yearly', interval: 1, until: null } });
    expect(dates(expandOccurrences(yearly, range('2026-01-01', '2029-12-31'))))
      .toEqual(['2026-03-02', '2027-03-02', '2028-03-02', '2029-03-02']);
  });

  it('stops at `until` (inclusive of that whole day)', () => {
    const ev = master({ recurrence: { freq: 'daily', interval: 1, until: '2026-03-04' } });
    expect(dates(expandOccurrences(ev, range('2026-03-01', '2026-03-31'))))
      .toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
  });

  it('skips exdates', () => {
    const ev = master({
      recurrence: { freq: 'daily', interval: 1, until: '2026-03-06' },
      exdates: ['2026-03-03', '2026-03-05'],
    });
    expect(dates(expandOccurrences(ev, range('2026-03-01', '2026-03-31'))))
      .toEqual(['2026-03-02', '2026-03-04', '2026-03-06']);
  });

  it('skips months that lack the day instead of clamping (31일 → 2월 없음)', () => {
    const ev = master({
      start: '2026-01-31T09:00:00+09:00',
      recurrence: { freq: 'monthly', interval: 1, until: null },
    });
    expect(dates(expandOccurrences(ev, range('2026-01-01', '2026-05-31'))))
      .toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  it('skips Feb 29 in non-leap years for a yearly event', () => {
    const ev = master({
      start: '2028-02-29T09:00:00+09:00',
      recurrence: { freq: 'yearly', interval: 1, until: null },
    });
    expect(dates(expandOccurrences(ev, range('2028-01-01', '2033-12-31'))))
      .toEqual(['2028-02-29', '2032-02-29']);
  });

  it('caps a single expansion at MAX_OCCURRENCES', () => {
    const ev = master({ recurrence: { freq: 'daily', interval: 1, until: null } });
    const occs = expandOccurrences(ev, { from: null, to: null });
    expect(occs.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    expect(occs.length).toBe(MAX_OCCURRENCES);
  });

  it('does not spin through 500 no-op iterations to reach a far future window', () => {
    const ev = master({
      start: '2000-01-01T09:00:00+09:00',
      recurrence: { freq: 'daily', interval: 1, until: null },
    });
    expect(dates(expandOccurrences(ev, range('2026-03-02', '2026-03-04'))))
      .toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
  });

  it('tags each occurrence with masterId / isOccurrence and a dated id', () => {
    const ev = master({ recurrence: { freq: 'daily', interval: 1, until: '2026-03-03' } });
    const [first] = expandOccurrences(ev, range('2026-03-02', '2026-03-03'));
    expect(first).toMatchObject({
      id: 'cal_abcd1234@2026-03-02',
      masterId: 'cal_abcd1234',
      isOccurrence: true,
      title: '반복',
    });
  });

  it('carries the master duration onto every occurrence', () => {
    const timed = master({
      start: '2026-03-02T09:00:00+09:00',
      end: '2026-03-02T10:30:00+09:00',
      recurrence: { freq: 'weekly', interval: 1, until: '2026-03-09' },
    });
    expect(expandOccurrences(timed, range('2026-03-01', '2026-03-31')).map((o) => o.end))
      .toEqual(['2026-03-02T10:30:00+09:00', '2026-03-09T10:30:00+09:00']);

    const allDay = master({
      start: '2026-03-02', end: '2026-03-04', allDay: true,
      recurrence: { freq: 'monthly', interval: 1, until: '2026-04-30' },
    });
    const occs = expandOccurrences(allDay, range('2026-03-01', '2026-04-30'));
    expect(occs.map((o) => [o.start, o.end]))
      .toEqual([['2026-03-02', '2026-03-04'], ['2026-04-02', '2026-04-04']]);
  });

  it('includes an occurrence that starts before the window but is still running', () => {
    const ev = master({
      start: '2026-03-02', end: '2026-03-06', allDay: true,
      recurrence: { freq: 'monthly', interval: 1, until: null },
    });
    expect(dates(expandOccurrences(ev, range('2026-03-05', '2026-03-05')))).toEqual(['2026-03-02']);
  });

  it('treats an unknown freq as a plain one-off event', () => {
    const ev = master({ recurrence: { freq: 'hourly', interval: 1, until: null } });
    expect(expandOccurrences(ev, range('2026-03-01', '2026-03-31'))).toEqual([ev]);
  });
});

describe('id helpers', () => {
  it('parses and normalizes occurrence ids', () => {
    expect(parseOccurrenceId('cal_abcd1234@2026-03-02'))
      .toEqual({ masterId: 'cal_abcd1234', date: '2026-03-02' });
    expect(parseOccurrenceId('cal_abcd1234')).toBeNull();
    expect(toMasterId('cal_abcd1234@2026-03-02')).toBe('cal_abcd1234');
    expect(toMasterId('cal_abcd1234')).toBe('cal_abcd1234');
  });
});

describe('normalizers', () => {
  it('accepts a valid recurrence and defaults the interval', () => {
    expect(normalizeRecurrence({ freq: 'weekly' }))
      .toEqual({ freq: 'weekly', interval: 1, until: null });
    expect(normalizeRecurrence({ freq: 'daily', interval: 3, until: '2026-12-31' }))
      .toEqual({ freq: 'daily', interval: 3, until: '2026-12-31' });
    expect(normalizeRecurrence(null)).toBeNull();
  });

  it('rejects a bad freq, interval or until', () => {
    expect(() => normalizeRecurrence({ freq: 'hourly' })).toThrow(/freq/);
    expect(() => normalizeRecurrence({ freq: 'daily', interval: 0 })).toThrow(/interval/);
    expect(() => normalizeRecurrence({ freq: 'daily', until: '2026/12/31' })).toThrow(/until/);
  });

  it('keeps only sorted unique YYYY-MM-DD exdates', () => {
    expect(normalizeExdates(['2026-03-05', 'nope', '2026-03-01', '2026-03-05']))
      .toEqual(['2026-03-01', '2026-03-05']);
    expect(normalizeExdates(null)).toEqual([]);
  });

  it('keeps only sorted unique in-range remind minutes', () => {
    expect(normalizeRemindMinutes([30, 0, 30, -5, 1440, 'x', 99999]))
      .toEqual([0, 30, 1440]);
    expect(normalizeRemindMinutes(null)).toEqual([]);
  });
});

describe('store integration', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-rec-'));
    store = createCalendarStore(path.join(dir, 'calendar.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores only the master but lists every occurrence in range', async () => {
    await store.create({
      title: '개학', start: '2026-03-02', allDay: true,
      recurrence: { freq: 'yearly' },
    });
    expect(store.all()).toHaveLength(1);
    expect(dates(store.list({ from: '2026-01-01', to: '2029-12-31' })))
      .toEqual(['2026-03-02', '2027-03-02', '2028-03-02', '2029-03-02']);
  });

  it('expands occurrences in upcoming() too', async () => {
    await store.create({
      title: '데일리', start: '2026-09-14T10:00:00+09:00',
      recurrence: { freq: 'daily' },
    });
    // days:3 → 9/17 09:00 이 컷오프. 9/17 회차는 10:00 시작이라 들어오지 않는다.
    const now = KST('2026-09-14T09:00:00+09:00');
    expect(dates(store.upcoming({ days: 3, now })))
      .toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });

  it('resolves an occurrence id back to the master on get/update/remove', async () => {
    const ev = await store.create({
      title: '주간회의', start: '2026-03-02T09:00:00+09:00',
      recurrence: { freq: 'weekly' },
    });
    const occId = `${ev.id}@2026-03-09`;

    expect(store.get(occId).id).toBe(ev.id);

    const patched = await store.update(occId, { title: '주간회의(변경)' });
    expect(patched.id).toBe(ev.id);
    expect(patched.title).toBe('주간회의(변경)');

    expect(await store.remove(occId)).toBe(true);
    expect(store.all()).toEqual([]);
  });

  it('excludeOccurrence drops just that date from the series', async () => {
    const ev = await store.create({
      title: '데일리', start: '2026-03-02T09:00:00+09:00',
      recurrence: { freq: 'daily', until: '2026-03-05' },
    });
    const master = await store.excludeOccurrence(`${ev.id}@2026-03-03`);
    expect(master.exdates).toEqual(['2026-03-03']);
    expect(dates(store.list({ from: '2026-03-01', to: '2026-03-31' })))
      .toEqual(['2026-03-02', '2026-03-04', '2026-03-05']);
  });

  it('excludeOccurrence returns null for a plain id or a missing master', async () => {
    expect(await store.excludeOccurrence('cal_deadbeef')).toBeNull();
    expect(await store.excludeOccurrence('cal_deadbeef@2026-03-03')).toBeNull();
  });

  it('rejects an invalid recurrence at create time', async () => {
    await expect(store.create({ title: 'x', start: '2026-03-02', recurrence: { freq: 'hourly' } }))
      .rejects.toMatchObject({ code: 'INVALID' });
  });
});
