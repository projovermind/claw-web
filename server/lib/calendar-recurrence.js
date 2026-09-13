/**
 * 반복 일정 전개.
 *
 * 저장은 마스터 1건만 하고, 조회(list/upcoming)할 때 요청 범위 안의 발생분을
 * 여기서 만들어 준다. 발생분은 파일에 쓰지 않는다 — 무한 반복을 그대로 저장할
 * 방법이 없고, 마스터를 고치면 과거/미래 회차가 자동으로 따라와야 하기 때문.
 */
import { DATE_ONLY, DAY_MS, daysInMonth, eventRange, formatKst, kstEpoch, kstParts, toEpoch } from './calendar-time.js';

export const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

/** 한 번의 전개에서 만들어 볼 회차 수 상한. until 이 없는 일정의 무한 루프 방지. */
export const MAX_OCCURRENCES = 500;

const OCCURRENCE_ID = /^(.+)@(\d{4}-\d{2}-\d{2})$/;

/** 'cal_ab12@2026-03-02' → { masterId, date }. 발생분 id 가 아니면 null. */
export function parseOccurrenceId(id) {
  const m = OCCURRENCE_ID.exec(String(id ?? ''));
  return m ? { masterId: m[1], date: m[2] } : null;
}

/** 발생분 id 를 마스터 id 로 되돌린다. PATCH/DELETE 가 시리즈에 적용될 때 사용. */
export function toMasterId(id) {
  return parseOccurrenceId(id)?.masterId ?? id;
}

/**
 * n 번째 회차의 KST 달력 날짜. 해당 월에 그 날짜가 없으면(2/30, 윤년 아닌 2/29) null.
 * 클램프하지 않고 건너뛴다 — "매월 31일" 이 2월 28일로 밀려 보이면 오히려 오해를 부른다.
 */
function occurrenceDate(base, freq, interval, n) {
  if (freq === 'daily' || freq === 'weekly') {
    const stepDays = (freq === 'weekly' ? 7 : 1) * interval;
    const shifted = new Date(Date.UTC(base.y, base.m - 1, base.d) + n * stepDays * DAY_MS);
    return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
  }
  if (freq === 'monthly') {
    const total = base.y * 12 + (base.m - 1) + n * interval;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return base.d > daysInMonth(y, m) ? null : { y, m, d: base.d };
  }
  const y = base.y + n * interval;
  return base.d > daysInMonth(y, base.m) ? null : { y, m: base.m, d: base.d };
}

/**
 * `from` 보다 앞선 회차를 500번씩 헛돌지 않도록 시작 인덱스를 대략 계산한다.
 * 경계에서 한 회차라도 놓치면 안 되므로 항상 넉넉히 뒤로 물러선다.
 */
function firstIndex(base, freq, interval, fromEpoch) {
  if (fromEpoch == null) return 0;
  const target = kstParts(fromEpoch);
  let n;
  if (freq === 'daily' || freq === 'weekly') {
    const stepDays = (freq === 'weekly' ? 7 : 1) * interval;
    const baseDay = Date.UTC(base.y, base.m - 1, base.d);
    const targetDay = Date.UTC(target.y, target.m - 1, target.d);
    n = Math.floor((targetDay - baseDay) / DAY_MS / stepDays);
  } else if (freq === 'monthly') {
    n = Math.floor(((target.y * 12 + target.m - 1) - (base.y * 12 + base.m - 1)) / interval);
  } else {
    n = Math.floor((target.y - base.y) / interval);
  }
  return Math.max(0, n - 1);
}

/** 마스터의 길이(ms / 종일은 일수)를 재서 각 회차에 그대로 얹는다. */
function measureSpan(event) {
  if (!event.end) return null;
  const start = toEpoch(event.start);
  const end = toEpoch(event.end);
  if (start == null || end == null) return null;
  if (event.allDay === true) return { days: Math.round((end - start) / DAY_MS) };
  return { ms: end - start };
}

function occurrenceEnd(event, span, startEpoch, dateStr) {
  if (span == null) return null;
  if (event.allDay === true) {
    const d = new Date(Date.parse(`${dateStr}T00:00:00Z`) + span.days * DAY_MS);
    return d.toISOString().slice(0, 10);
  }
  return formatKst(startEpoch + span.ms);
}

/**
 * 마스터 이벤트를 [from, to] 안의 발생분으로 전개한다.
 * 반복이 아니면 겹치는 경우에 한해 마스터 자신을 담은 배열을 돌려준다.
 *
 * @param {object} event 마스터 이벤트
 * @param {{from?: number|null, to?: number|null, max?: number}} range epoch 경계 (null = 무제한)
 * @returns {object[]} start 순 발생분
 */
export function expandOccurrences(event, { from = null, to = null, max = MAX_OCCURRENCES } = {}) {
  const overlaps = (r) => {
    if (r.start == null) return false;
    if (from != null && r.end < from) return false;
    if (to != null && r.start > to) return false;
    return true;
  };

  const rule = event.recurrence;
  if (!rule || !FREQS.includes(rule.freq)) {
    return overlaps(eventRange(event)) ? [event] : [];
  }

  const startEpoch = toEpoch(event.start);
  if (startEpoch == null) return [];

  const interval = Math.max(1, Math.trunc(Number(rule.interval) || 1));
  const base = kstParts(startEpoch);
  const span = measureSpan(event);
  const untilEpoch = rule.until ? toEpoch(rule.until, { endOfDay: true }) : null;
  const exdates = new Set(Array.isArray(event.exdates) ? event.exdates : []);

  // 시작 직전 회차부터 훑되, 길이가 긴 일정은 from 이전에 시작해 걸쳐 있을 수 있다.
  const lead = span?.days ? span.days * DAY_MS : (span?.ms ?? 0);
  const n0 = firstIndex(base, rule.freq, interval, from == null ? null : from - lead);

  const out = [];
  for (let i = 0; i < max; i++) {
    const date = occurrenceDate(base, rule.freq, interval, n0 + i);
    if (date == null) continue; // 그 달에 없는 날짜 — 이 회차만 건너뛴다
    const occStart = kstEpoch({ ...date, hh: base.hh, mm: base.mm, ss: base.ss });
    if (occStart < startEpoch) continue;
    if (untilEpoch != null && occStart > untilEpoch) break;
    if (to != null && occStart > to) break;

    const dateStr = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    if (exdates.has(dateStr)) continue;

    const occurrence = {
      ...event,
      id: `${event.id}@${dateStr}`,
      masterId: event.id,
      isOccurrence: true,
      start: event.allDay === true ? dateStr : formatKst(occStart),
      end: occurrenceEnd(event, span, occStart, dateStr),
    };
    if (overlaps(eventRange(occurrence))) out.push(occurrence);
  }
  return out;
}

/** @throws {Error & {code:'INVALID'}} */
const invalid = (msg) => {
  const err = new Error(msg);
  err.code = 'INVALID';
  throw err;
};

export function normalizeRecurrence(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid('recurrence must be an object');
  if (!FREQS.includes(value.freq)) invalid(`recurrence.freq must be one of ${FREQS.join(', ')}`);

  const rawInterval = value.interval == null ? 1 : Number(value.interval);
  if (!Number.isFinite(rawInterval) || rawInterval < 1) invalid('recurrence.interval must be >= 1');

  let until = null;
  if (value.until != null && value.until !== '') {
    until = String(value.until).trim().slice(0, 10);
    if (!DATE_ONLY.test(until)) invalid('recurrence.until must be YYYY-MM-DD');
  }
  return { freq: value.freq, interval: Math.min(Math.trunc(rawInterval), 1000), until };
}

export function normalizeExdates(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid('exdates must be an array');
  const seen = new Set();
  for (const raw of value) {
    const s = String(raw ?? '').trim();
    if (DATE_ONLY.test(s)) seen.add(s);
  }
  return [...seen].sort().slice(0, MAX_OCCURRENCES);
}

/** 알림 분 단위 오프셋. 0 = 정시, 1440 = 하루 전. */
export function normalizeRemindMinutes(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid('remindMinutes must be an array');
  const seen = new Set();
  for (const raw of value) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 40320) continue; // 최대 4주 전
    seen.add(Math.trunc(n));
  }
  return [...seen].sort((a, b) => a - b).slice(0, 10);
}
