/**
 * 캘린더용 날짜 유틸 — 새 라이브러리 없이 브라우저 로컬 타임존(운영 기준 KST)으로 계산한다.
 * 이벤트 start/end 는 allDay 면 'YYYY-MM-DD', 아니면 오프셋이 붙은 ISO8601.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

export const isDateOnly = (value: string) => DATE_ONLY_RE.test(value);

/** 'YYYY-MM-DD' 는 로컬 자정으로, ISO 문자열은 그대로 파싱. (UTC 자정 해석으로 하루 밀리는 것 방지) */
export function parseEventDate(value: string): Date {
  if (isDateOnly(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

/** 로컬 기준 'YYYY-MM-DD' — 그리드 칸의 키로 쓴다. */
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** <input type="datetime-local"> 이 요구하는 'YYYY-MM-DDTHH:mm'. */
export const toLocalInput = (d: Date) => `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 'YYYY-MM-DDTHH:mm' → '...:00+09:00'. 서버에는 항상 오프셋이 붙은 ISO 로 보낸다. */
export function localInputToIso(value: string): string {
  const d = new Date(value);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${value}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const addDays = (d: Date, n: number) => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};

export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);

/** 월간 그리드(월요일 시작) 42칸. */
export function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month);
  const shift = (first.getDay() + 6) % 7; // 0=월 … 6=일
  const gridStart = addDays(first, -shift);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export const weekdayLabel = (d: Date) => WEEKDAYS[d.getDay()];

/** '9/20(토) 14:00' / 종일이면 '9/20(토) 종일'. */
export function formatEventWhen(start: string, allDay: boolean): string {
  const d = parseEventDate(start);
  const head = `${d.getMonth() + 1}/${d.getDate()}(${weekdayLabel(d)})`;
  return allDay ? `${head} 종일` : `${head} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 시각만 'HH:mm' — 월간 그리드 칸 안에서 쓴다. */
export function formatTime(start: string): string {
  const d = parseEventDate(start);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
