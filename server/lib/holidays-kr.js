/**
 * 한국 공휴일 / 대체공휴일.
 *
 * 원천은 구글 공개 ICS(키 불필요). 파싱은 DTSTART;VALUE=DATE + SUMMARY 만 보면
 * 되므로 ical 라이브러리를 끌어오지 않고 직접 훑는다.
 *
 * 캐시는 data/user/holidays-kr.json. 부팅 때 7일 이상 묵었으면 백그라운드로
 * 한 번 갱신하고, 실패하면 경고만 남기고 하드코딩 폴백을 쓴다 — 네트워크가
 * 막힌 환경에서도 서버는 떠야 하고 양력 공휴일은 그려져야 하기 때문.
 * 음력(설날·추석)은 계산하지 않는다. 추측해서 틀린 날을 빨갛게 칠하느니 비워 둔다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

export const HOLIDAY_ICS_URL =
  'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 7 * DAY_MS;
/** 한 VEVENT 가 DTEND 로 늘어날 수 있는 최대 일수. 깨진 피드가 메모리를 먹는 것 방지. */
const MAX_SPAN_DAYS = 30;

/** 날짜가 고정된 양력 공휴일 (월-일). 음력은 여기 두지 않는다. */
const FIXED = [
  ['01-01', '신정'],
  ['03-01', '삼일절'],
  ['05-05', '어린이날'],
  ['06-06', '현충일'],
  ['08-15', '광복절'],
  ['10-03', '개천절'],
  ['10-09', '한글날'],
  ['12-25', '성탄절'],
];

const FALLBACK_YEARS = [2026, 2027];

/** fetch 가 막혔을 때 쓰는 최소 테이블. */
export function fallbackHolidays() {
  return FALLBACK_YEARS.flatMap((year) =>
    FIXED.map(([md, name]) => ({ date: `${year}-${md}`, name, substitute: false }))
  ).sort((a, b) => a.date.localeCompare(b.date));
}

/** ICS 의 줄 접힘(다음 줄이 공백/탭으로 시작) 을 편다. */
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

const unescapeIcs = (s) =>
  s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

const toDateStr = (yyyymmdd) =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/**
 * ICS 본문 → `[{date, name, substitute}]`.
 * 여러 날에 걸친 VEVENT(DTEND) 는 날짜별로 펼친다.
 */
export function parseHolidayIcs(text) {
  const found = new Map(); // `${date}|${name}` → entry (중복 제거)
  let current = null;

  for (const rawLine of unfold(text).split('\n')) {
    const line = rawLine.trim();
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (!current) continue;

    if (line === 'END:VEVENT') {
      if (current.start && current.name) {
        const startMs = Date.parse(`${toDateStr(current.start)}T00:00:00Z`);
        const endMs = current.end ? Date.parse(`${toDateStr(current.end)}T00:00:00Z`) : NaN;
        const spanDays = Number.isNaN(endMs)
          ? 1
          : Math.min(Math.max(Math.round((endMs - startMs) / DAY_MS), 1), MAX_SPAN_DAYS);
        const substitute = current.name.includes('대체');
        for (let i = 0; i < spanDays; i++) {
          const date = new Date(startMs + i * DAY_MS).toISOString().slice(0, 10);
          found.set(`${date}|${current.name}`, { date, name: current.name, substitute });
        }
      }
      current = null;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1);
    if (key.startsWith('DTSTART')) current.start = value.replace(/[^0-9]/g, '').slice(0, 8);
    else if (key.startsWith('DTEND')) current.end = value.replace(/[^0-9]/g, '').slice(0, 8);
    else if (key === 'SUMMARY') current.name = unescapeIcs(value);
  }

  return [...found.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * @param {object} opts
 * @param {string} opts.filePath              캐시 경로 (data/user/holidays-kr.json)
 * @param {typeof fetch} [opts.fetchImpl]     테스트용 주입
 * @param {() => number} [opts.now]
 * @param {number} [opts.timeoutMs]
 */
export function createHolidaysKr({
  filePath,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 10_000,
} = {}) {
  /** @type {{fetchedAt: string|null, holidays: object[], fromFallback: boolean}} */
  let state = { fetchedAt: null, holidays: fallbackHolidays(), fromFallback: true };
  let inflight = null;

  function load() {
    try {
      if (!filePath || !fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed?.holidays) || parsed.holidays.length === 0) return;
      state = { fetchedAt: parsed.fetchedAt ?? null, holidays: parsed.holidays, fromFallback: false };
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'holidays-kr: cache read failed');
    }
  }

  function save() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, fetchedAt: state.fetchedAt, holidays: state.holidays }, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'holidays-kr: cache write failed');
    }
  }

  load();

  function isStale() {
    if (state.fromFallback || !state.fetchedAt) return true;
    const ts = Date.parse(state.fetchedAt);
    return !Number.isFinite(ts) || now() - ts > STALE_MS;
  }

  /** 구글 ICS 를 한 번 받아 캐시를 갱신한다. 실패해도 throw 하지 않는다. */
  async function refreshHolidays() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
        const res = await fetchImpl(HOLIDAY_ICS_URL, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const holidays = parseHolidayIcs(await res.text());
        if (holidays.length === 0) throw new Error('no VEVENT parsed');
        state = { fetchedAt: new Date(now()).toISOString(), holidays, fromFallback: false };
        save();
        logger.info({ count: holidays.length }, 'holidays-kr: refreshed');
        return { ok: true, count: holidays.length };
      } catch (err) {
        logger.warn({ err: err.message }, 'holidays-kr: refresh failed — using cache/fallback');
        return { ok: false, error: err.message };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    filePath,

    /** 범위 조회 (동기). from/to 는 'YYYY-MM-DD', 생략 시 제한 없음. */
    getHolidays({ from, to } = {}) {
      return state.holidays.filter((h) => {
        if (typeof h?.date !== 'string') return false;
        if (from && h.date < from) return false;
        if (to && h.date > to) return false;
        return true;
      });
    },

    refreshHolidays,

    /** 부팅용 — 캐시가 없거나 7일 넘었으면 백그라운드로 갱신. 서버 기동을 막지 않는다. */
    ensureFresh() {
      if (!isStale()) return null;
      return refreshHolidays().catch((err) =>
        logger.warn({ err: err.message }, 'holidays-kr: background refresh failed')
      );
    },

    /** 캐시 상태 (테스트/디버깅용) */
    status() {
      return { fetchedAt: state.fetchedAt, count: state.holidays.length, fromFallback: state.fromFallback };
    },
  };
}
