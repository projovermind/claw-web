import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHolidaysKr, fallbackHolidays, parseHolidayIcs } from '../server/lib/holidays-kr.js';

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260101',
  'DTEND;VALUE=DATE:20260102',
  'SUMMARY:신정',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260216',
  'DTEND;VALUE=DATE:20260219',
  'SUMMARY:설날',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260302',
  'DTEND;VALUE=DATE:20260303',
  'SUMMARY:삼일절 대체공휴일',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const okFetch = (body) => async () => ({ ok: true, text: async () => body });

describe('parseHolidayIcs', () => {
  it('reads DTSTART/SUMMARY and expands multi-day events', () => {
    expect(parseHolidayIcs(ICS)).toEqual([
      { date: '2026-01-01', name: '신정', substitute: false },
      { date: '2026-02-16', name: '설날', substitute: false },
      { date: '2026-02-17', name: '설날', substitute: false },
      { date: '2026-02-18', name: '설날', substitute: false },
      { date: '2026-03-02', name: '삼일절 대체공휴일', substitute: true },
    ]);
  });

  it('unfolds wrapped lines and unescapes the summary', () => {
    const folded = 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260505\r\nSUMMARY:어린이\r\n 날\\, 봄\r\nEND:VEVENT';
    expect(parseHolidayIcs(folded)).toEqual([
      { date: '2026-05-05', name: '어린이날, 봄', substitute: false },
    ]);
  });

  it('ignores events missing a date or summary, and junk input', () => {
    expect(parseHolidayIcs('BEGIN:VEVENT\r\nSUMMARY:이름만\r\nEND:VEVENT')).toEqual([]);
    expect(parseHolidayIcs('')).toEqual([]);
  });
});

describe('fallbackHolidays', () => {
  it('covers the fixed solar holidays for 2026 and 2027 only', () => {
    const fb = fallbackHolidays();
    expect(fb).toHaveLength(16);
    expect(fb[0]).toEqual({ date: '2026-01-01', name: '신정', substitute: false });
    expect(fb.map((h) => h.name)).toContain('한글날');
    // 음력 공휴일은 추측하지 않는다.
    expect(fb.map((h) => h.name)).not.toContain('설날');
    expect(fb.map((h) => h.name)).not.toContain('추석');
  });
});

describe('createHolidaysKr', () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holi-'));
    filePath = path.join(dir, 'holidays-kr.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the fallback table before any fetch', () => {
    const h = createHolidaysKr({ filePath, fetchImpl: okFetch(ICS) });
    expect(h.status()).toMatchObject({ fromFallback: true, fetchedAt: null });
    expect(h.getHolidays({ from: '2026-01-01', to: '2026-01-31' }))
      .toEqual([{ date: '2026-01-01', name: '신정', substitute: false }]);
  });

  it('refreshes from the ICS feed and caches to disk', async () => {
    const h = createHolidaysKr({ filePath, fetchImpl: okFetch(ICS) });
    await expect(h.refreshHolidays()).resolves.toEqual({ ok: true, count: 5 });
    expect(h.getHolidays({ from: '2026-02-01', to: '2026-02-28' }).map((x) => x.date))
      .toEqual(['2026-02-16', '2026-02-17', '2026-02-18']);

    const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(cached.holidays).toHaveLength(5);
    expect(Date.parse(cached.fetchedAt)).not.toBeNaN();

    // 새 인스턴스는 네트워크 없이 캐시에서 바로 읽는다.
    const reopened = createHolidaysKr({ filePath, fetchImpl: null });
    expect(reopened.status()).toMatchObject({ fromFallback: false, count: 5 });
  });

  it('keeps the fallback and does not throw when the fetch fails', async () => {
    const h = createHolidaysKr({
      filePath,
      fetchImpl: async () => { throw new Error('ENETDOWN'); },
    });
    await expect(h.refreshHolidays()).resolves.toMatchObject({ ok: false });
    expect(h.status().fromFallback).toBe(true);
    expect(h.getHolidays({ from: '2026-03-01', to: '2026-03-01' })[0].name).toBe('삼일절');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('treats a non-200 or empty feed as a failure', async () => {
    const bad = createHolidaysKr({ filePath, fetchImpl: async () => ({ ok: false, status: 503 }) });
    await expect(bad.refreshHolidays()).resolves.toMatchObject({ ok: false, error: 'HTTP 503' });

    const empty = createHolidaysKr({ filePath, fetchImpl: okFetch('BEGIN:VCALENDAR\r\nEND:VCALENDAR') });
    await expect(empty.refreshHolidays()).resolves.toMatchObject({ ok: false });
    expect(empty.status().fromFallback).toBe(true);
  });

  it('ensureFresh refreshes a stale cache but skips a fresh one', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, text: async () => ICS }; };

    const stale = createHolidaysKr({ filePath, fetchImpl });
    await stale.ensureFresh();
    expect(calls).toBe(1);

    const fresh = createHolidaysKr({ filePath, fetchImpl });
    expect(fresh.ensureFresh()).toBeNull();
    expect(calls).toBe(1);

    // 8일 뒤에는 다시 묵은 것으로 본다.
    const later = createHolidaysKr({ filePath, fetchImpl, now: () => Date.now() + 8 * 24 * 60 * 60 * 1000 });
    await later.ensureFresh();
    expect(calls).toBe(2);
  });

  it('filters by range, open-ended on either side', async () => {
    const h = createHolidaysKr({ filePath, fetchImpl: okFetch(ICS) });
    await h.refreshHolidays();
    expect(h.getHolidays({ to: '2026-01-31' }).map((x) => x.date)).toEqual(['2026-01-01']);
    expect(h.getHolidays({ from: '2026-03-01' }).map((x) => x.date)).toEqual(['2026-03-02']);
    expect(h.getHolidays()).toHaveLength(5);
  });
});
