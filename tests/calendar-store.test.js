import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCalendarStore, eventRange, formatEventLine, toEpoch } from '../server/lib/calendar-store.js';

const KST = (s) => Date.parse(s);
const NOW = KST('2026-09-14T12:00:00+09:00'); // 월요일 정오

describe('createCalendarStore', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
    store = createCalendarStore(path.join(dir, 'calendar.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('fills defaults and normalizes the start to KST', async () => {
      const ev = await store.create({ title: '스프린트 회고', start: '2026-09-20T14:00:00+09:00' });
      expect(ev.id).toMatch(/^cal_[0-9a-f]{8}$/);
      expect(ev.start).toBe('2026-09-20T14:00:00+09:00');
      expect(ev).toMatchObject({
        end: null, allDay: false, notes: '', location: '',
        color: null, tags: [], projectId: null, agentId: null, source: 'agent',
      });
      expect(Date.parse(ev.createdAt)).not.toBeNaN();
    });

    it('treats a zone-less datetime as KST', async () => {
      const ev = await store.create({ title: '점심', start: '2026-09-20T12:30' });
      expect(ev.start).toBe('2026-09-20T12:30:00+09:00');
    });

    it('stores allDay events as YYYY-MM-DD even when given a datetime', async () => {
      const ev = await store.create({ title: '워크샵', start: '2026-09-20T14:00:00+09:00', allDay: true });
      expect(ev.start).toBe('2026-09-20');
      expect(ev.allDay).toBe(true);
    });

    it('normalizes color, tags and source', async () => {
      const ev = await store.create({
        title: '릴리스', start: '2026-09-20', allDay: true,
        color: 'A1B2C3', tags: ['deploy', '  ops  ', '', 42], source: 'user',
      });
      expect(ev.color).toBe('#a1b2c3');
      expect(ev.tags).toEqual(['deploy', 'ops']);
      expect(ev.source).toBe('user');
    });

    it('persists across store instances', async () => {
      await store.create({ title: '저장됨', start: '2026-09-20T09:00:00+09:00' });
      const reopened = createCalendarStore(store.filePath);
      expect(reopened.all().map((e) => e.title)).toEqual(['저장됨']);
    });
  });

  describe('invalid input', () => {
    const cases = [
      ['missing title', { start: '2026-09-20' }],
      ['blank title', { title: '   ', start: '2026-09-20' }],
      ['title over 200 chars', { title: 'x'.repeat(201), start: '2026-09-20' }],
      ['missing start', { title: '제목' }],
      ['unparsable start', { title: '제목', start: '내일쯤' }],
      ['end before start', { title: '제목', start: '2026-09-20T10:00:00+09:00', end: '2026-09-20T09:00:00+09:00' }],
      ['non-hex color', { title: '제목', start: '2026-09-20', color: 'red' }],
      ['tags not an array', { title: '제목', start: '2026-09-20', tags: 'deploy' }],
    ];

    for (const [label, body] of cases) {
      it(`rejects ${label}`, async () => {
        await expect(store.create(body)).rejects.toMatchObject({ code: 'INVALID' });
      });
    }

    it('does not write a broken event to disk', async () => {
      await expect(store.create({ title: '제목' })).rejects.toThrow();
      expect(store.all()).toEqual([]);
    });
  });

  describe('update / remove', () => {
    it('patches only the given fields and bumps updatedAt', async () => {
      const ev = await store.create({ title: '원본', start: '2026-09-20T14:00:00+09:00', notes: '메모' });
      const patched = await store.update(ev.id, { title: '수정됨' });
      expect(patched).toMatchObject({ id: ev.id, title: '수정됨', notes: '메모', start: ev.start });
      expect(patched.createdAt).toBe(ev.createdAt);
      expect(Date.parse(patched.updatedAt)).toBeGreaterThanOrEqual(Date.parse(ev.createdAt));
      expect(store.get(ev.id).title).toBe('수정됨');
    });

    it('re-formats start when an event is switched to allDay', async () => {
      const ev = await store.create({ title: '워크샵', start: '2026-09-20T14:00:00+09:00' });
      const patched = await store.update(ev.id, { allDay: true });
      expect(patched.start).toBe('2026-09-20');
    });

    it('rejects a patch that would make the event invalid', async () => {
      const ev = await store.create({ title: '원본', start: '2026-09-20T14:00:00+09:00' });
      await expect(store.update(ev.id, { title: '' })).rejects.toMatchObject({ code: 'INVALID' });
      expect(store.get(ev.id).title).toBe('원본');
    });

    it('returns null / false for unknown ids', async () => {
      expect(await store.update('cal_deadbeef', { title: 'x' })).toBeNull();
      expect(await store.remove('cal_deadbeef')).toBe(false);
      expect(store.get('cal_deadbeef')).toBeNull();
    });

    it('removes an event', async () => {
      const ev = await store.create({ title: '삭제 대상', start: '2026-09-20' });
      expect(await store.remove(ev.id)).toBe(true);
      expect(store.all()).toEqual([]);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await store.create({ title: '8월', start: '2026-08-10T10:00:00+09:00' });
      await store.create({ title: '9/15', start: '2026-09-15T10:00:00+09:00' });
      await store.create({ title: '9/20 종일', start: '2026-09-20', allDay: true });
      await store.create({ title: '10월', start: '2026-10-05T10:00:00+09:00' });
      await store.create({ title: '9/18~9/25 장기', start: '2026-09-18', end: '2026-09-25', allDay: true });
    });

    it('sorts everything by start ascending', () => {
      expect(store.all().map((e) => e.title)).toEqual(['8월', '9/15', '9/18~9/25 장기', '9/20 종일', '10월']);
    });

    it('filters by from/to inclusive of the whole end day', () => {
      expect(store.list({ from: '2026-09-15', to: '2026-09-20' }).map((e) => e.title))
        .toEqual(['9/15', '9/18~9/25 장기', '9/20 종일']);
    });

    it('includes events that merely overlap the range', () => {
      expect(store.list({ from: '2026-09-22', to: '2026-09-23' }).map((e) => e.title))
        .toEqual(['9/18~9/25 장기']);
    });

    it('supports an open-ended range', () => {
      expect(store.list({ from: '2026-09-21' }).map((e) => e.title)).toEqual(['9/18~9/25 장기', '10월']);
      expect(store.list({ to: '2026-09-01' }).map((e) => e.title)).toEqual(['8월']);
      expect(store.list().length).toBe(5);
    });
  });

  describe('upcoming', () => {
    beforeEach(async () => {
      await store.create({ title: '지난주', start: '2026-09-07T10:00:00+09:00' });
      await store.create({ title: '오늘 아침(종료됨)', start: '2026-09-14T09:00:00+09:00' });
      await store.create({ title: '오늘 종일', start: '2026-09-14', allDay: true });
      await store.create({ title: '경계 직전', start: '2026-09-21T11:00:00+09:00' });
      await store.create({ title: '경계 직후', start: '2026-09-21T13:00:00+09:00' });
    });

    it('spans exactly N days from now', () => {
      expect(store.upcoming({ days: 7, now: NOW }).map((e) => e.title))
        .toEqual(['오늘 종일', '경계 직전']);
    });

    it('keeps an in-progress event whose end is still ahead', async () => {
      await store.create({ title: '진행 중', start: '2026-09-13T09:00:00+09:00', end: '2026-09-15T18:00:00+09:00' });
      expect(store.upcoming({ days: 7, now: NOW }).map((e) => e.title)).toContain('진행 중');
    });

    it('clamps days to 1..90', () => {
      expect(store.upcoming({ days: 0, now: NOW }).map((e) => e.title)).toEqual(['오늘 종일']);
      expect(store.upcoming({ days: 9999, now: NOW }).map((e) => e.title))
        .toEqual(['오늘 종일', '경계 직전', '경계 직후']);
      expect(store.upcoming({ days: 'abc', now: NOW }).map((e) => e.title))
        .toEqual(['오늘 종일', '경계 직전']);
    });

    it('honours the limit', () => {
      expect(store.upcoming({ days: 90, now: NOW, limit: 1 }).map((e) => e.title)).toEqual(['오늘 종일']);
    });

    it('returns an empty list when the calendar is empty', () => {
      const empty = createCalendarStore(path.join(dir, 'empty.json'));
      expect(empty.upcoming({ now: NOW })).toEqual([]);
      expect(empty.all()).toEqual([]);
    });
  });

  describe('helpers', () => {
    it('parses date-only values in KST', () => {
      expect(toEpoch('2026-09-20')).toBe(KST('2026-09-20T00:00:00+09:00'));
      expect(toEpoch('2026-09-20', { endOfDay: true })).toBe(KST('2026-09-21T00:00:00+09:00') - 1);
      expect(toEpoch('garbage')).toBeNull();
    });

    it('gives an allDay event without end the whole day', () => {
      const r = eventRange({ start: '2026-09-20', end: null, allDay: true });
      expect(r.start).toBe(KST('2026-09-20T00:00:00+09:00'));
      expect(r.end).toBe(KST('2026-09-21T00:00:00+09:00') - 1);
    });

    it('formats an injection line', () => {
      expect(formatEventLine({ title: '회고', start: '2026-09-20T14:00:00+09:00', allDay: false }))
        .toBe('9/20(일) 14:00 회고');
      expect(formatEventLine({ title: '워크샵', start: '2026-09-21', allDay: true }))
        .toBe('9/21(월) 종일 워크샵');
    });
  });
});
