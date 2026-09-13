/**
 * Calendar time primitives — KST(+09:00) 고정.
 *
 * 캘린더 전체가 이 파일의 규칙 하나만 쓴다: 시각 있는 일정은
 * `YYYY-MM-DDTHH:mm:ss+09:00`, 종일 일정은 `YYYY-MM-DD`.
 * 반복 전개(calendar-recurrence)와 저장소(calendar-store)가 순환 import 없이
 * 같은 날짜 계산을 공유하도록 별도 모듈로 뺐다.
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → KST 자정(또는 endOfDay 시 23:59:59.999) epoch. 그 외는 Date.parse. */
export function toEpoch(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (DATE_ONLY.test(s)) {
    const base = Date.parse(`${s}T00:00:00+09:00`);
    if (Number.isNaN(base)) return null;
    return endOfDay ? base + DAY_MS - 1 : base;
  }
  const t = Date.parse(HAS_ZONE.test(s) ? s : `${s}+09:00`);
  return Number.isNaN(t) ? null : t;
}

/** epoch → 'YYYY-MM-DDTHH:mm:ss+09:00' */
export function formatKst(epoch) {
  const d = new Date(epoch + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`;
}

/** epoch → 'YYYY-MM-DD' (KST 기준) */
export function formatKstDate(epoch) {
  const d = new Date(epoch + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** epoch → KST 달력 성분. 반복 전개가 '같은 날짜/같은 시각' 을 재조립할 때 쓴다. */
export function kstParts(epoch) {
  const d = new Date(epoch + KST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
  };
}

/** KST 달력 성분 → epoch */
export function kstEpoch({ y, m, d, hh = 0, mm = 0, ss = 0 }) {
  return Date.UTC(y, m - 1, d, hh, mm, ss) - KST_OFFSET_MS;
}

/** 해당 연/월의 마지막 날 (m 은 1-based) */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 이벤트의 시작/끝 epoch. end 가 없으면 종일 일정은 그날 끝, 시각 일정은 시작과 동일. */
export function eventRange(event) {
  const start = toEpoch(event.start, { endOfDay: false });
  const rawEnd = event.end
    ? toEpoch(event.end, { endOfDay: event.allDay === true })
    : (event.allDay === true ? toEpoch(event.start, { endOfDay: true }) : start);
  return { start, end: rawEnd == null ? start : Math.max(start ?? 0, rawEnd) };
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '9/20(토) 14:00' / 종일이면 '9/20(토) 종일'. null 이면 파싱 실패. */
export function formatEventWhen(event) {
  const epoch = toEpoch(event.start);
  if (epoch == null) return null;
  const d = new Date(epoch + KST_OFFSET_MS);
  const head = `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
  return `${head} ${event.allDay ? '종일' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}`;
}

/** '9/20(토) 14:00 제목' / 종일이면 '9/20(토) 종일 제목' */
export function formatEventLine(event) {
  const when = formatEventWhen(event);
  return when == null ? event.title : `${when} ${event.title}`;
}
