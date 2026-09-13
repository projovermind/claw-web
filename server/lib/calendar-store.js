/**
 * Calendar Store — 팀 공용 캘린더 (data/user/calendar.json).
 *
 * 웹 UI(사용자)와 모든 세션(에이전트)이 같은 파일을 동시에 건드리므로,
 * 쓰기는 deploy-log-store 와 동일하게 lockfile + atomic rename 으로 직렬화한다.
 *
 * 시간대 기준은 KST(+09:00) — 규칙은 calendar-time.js 참고.
 * 반복 일정은 마스터 1건만 저장하고, list/upcoming 이 조회 범위 안에서
 * 발생분을 전개해서 돌려준다 (calendar-recurrence.js).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { logger } from './logger.js';
import { DAY_MS, eventRange, formatKst, formatKstDate, toEpoch } from './calendar-time.js';
import {
  expandOccurrences,
  normalizeExdates,
  normalizeRecurrence,
  normalizeRemindMinutes,
  parseOccurrenceId,
  toMasterId,
} from './calendar-recurrence.js';

export { toEpoch, eventRange, formatEventLine, formatEventWhen } from './calendar-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const CALENDAR_FILE = path.join(REPO_ROOT, 'data', 'user', 'calendar.json');

export const MAX_UPCOMING_DAYS = 90;

class CalendarError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID';
  }
}

const invalid = (msg) => { throw new CalendarError(msg); };

function normalizeMoment(value, { allDay, field }) {
  const s = String(value ?? '').trim();
  if (!s) invalid(`${field} is required`);
  const epoch = toEpoch(s);
  if (epoch == null) invalid(`${field} is not a valid date/datetime`);
  return allDay ? formatKstDate(epoch) : formatKst(epoch);
}

function normalizeString(value, { max, field }) {
  const s = String(value ?? '');
  if (s.length > max) invalid(`${field} must be ${max} characters or fewer`);
  return s;
}

function normalizeColor(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (!/^[0-9a-f]{3,8}$/i.test(hex)) invalid('color must be a hex value');
  return `#${hex.toLowerCase()}`;
}

function normalizeTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid('tags must be an array');
  return value
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim().slice(0, 40))
    .slice(0, 20);
}

function normalizeId(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 64);
}

function byStart(a, b) {
  const ra = eventRange(a).start ?? 0;
  const rb = eventRange(b).start ?? 0;
  if (ra !== rb) return ra - rb;
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
}

/**
 * 입력(부분집합)을 정규화해 완전한 이벤트로 만든다.
 * @param {object} input
 * @param {object|null} base 수정 시 기존 이벤트
 */
function buildEvent(input, base = null) {
  const src = base ? { ...base, ...input } : input;

  const allDay = src.allDay === true;
  const title = normalizeString(src.title, { max: 200, field: 'title' }).trim();
  if (!title) invalid('title is required');

  const start = normalizeMoment(src.start, { allDay, field: 'start' });
  const end = (src.end == null || src.end === '')
    ? null
    : normalizeMoment(src.end, { allDay, field: 'end' });

  if (end != null && toEpoch(end, { endOfDay: allDay }) < toEpoch(start)) {
    invalid('end must not be before start');
  }

  const now = new Date().toISOString();
  return {
    id: base?.id ?? `cal_${crypto.randomBytes(4).toString('hex')}`,
    title,
    start,
    end,
    allDay,
    notes: normalizeString(src.notes ?? '', { max: 5000, field: 'notes' }),
    location: normalizeString(src.location ?? '', { max: 200, field: 'location' }),
    color: normalizeColor(src.color ?? null),
    tags: normalizeTags(src.tags),
    projectId: normalizeId(src.projectId),
    agentId: normalizeId(src.agentId),
    source: src.source === 'user' ? 'user' : 'agent',
    recurrence: normalizeRecurrence(src.recurrence ?? null),
    exdates: normalizeExdates(src.exdates),
    remindMinutes: normalizeRemindMinutes(src.remindMinutes),
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
  };
}

function readFileSync(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { version: 1, events: [] };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { version: 1, events: Array.isArray(parsed?.events) ? parsed.events : [] };
  } catch (err) {
    logger.warn({ filePath, err: err.message }, 'calendar: read failed');
    return { version: 1, events: [] };
  }
}

/**
 * @param {string} [filePath]
 */
export function createCalendarStore(filePath = CALENDAR_FILE) {
  function ensureFile() {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, events: [] }, null, 2));
    }
  }

  /**
   * 락 안에서 read → mutate → atomic write.
   * fn 은 `{ write, value }` 를 반환한다. write:false 면 파일을 건드리지 않고 value 만 돌려준다.
   */
  async function mutate(fn) {
    ensureFile();
    const release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 100 } });
    try {
      const data = readFileSync(filePath);
      const { write = true, value = null } = fn(data.events) ?? {};
      if (write) {
        const tmp = `${filePath}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify({ version: 1, events: data.events }, null, 2));
        await fsp.rename(tmp, filePath);
      }
      return value;
    } finally {
      await release();
    }
  }

  /** 마스터 목록을 [from, to] epoch 범위의 발생분으로 펼친다. */
  function expandAll(masters, from, to) {
    const out = [];
    for (const master of masters) out.push(...expandOccurrences(master, { from, to }));
    return out.sort(byStart);
  }

  return {
    filePath,

    /** 저장된 마스터 이벤트 전체 (start 오름차순). 반복 전개는 하지 않는다. */
    all() {
      return readFileSync(filePath).events.slice().sort(byStart);
    },

    /**
     * 범위 조회. from/to 는 'YYYY-MM-DD' 또는 ISO. 생략 시 제한 없음.
     * 시작~끝이 [from, to] 와 겹치면 포함하고, 반복 일정은 회차별로 펼쳐진다.
     */
    list({ from, to } = {}) {
      return expandAll(
        this.all(),
        from ? toEpoch(from) : null,
        to ? toEpoch(to, { endOfDay: true }) : null
      );
    },

    /** 지금부터 N일(기본 7, 최대 90) 내 일정. 진행 중인 일정도 포함. */
    upcoming({ days = 7, now = Date.now(), limit = null } = {}) {
      const n = Number(days);
      const span = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), MAX_UPCOMING_DAYS) : 7;
      const found = expandAll(this.all(), now, now + span * DAY_MS);
      return limit ? found.slice(0, limit) : found;
    },

    /** 발생분 id(`xxx@YYYY-MM-DD`) 를 주면 그 마스터를 돌려준다. */
    get(id) {
      const masterId = toMasterId(id);
      return readFileSync(filePath).events.find((e) => e.id === masterId) ?? null;
    },

    /** @throws {CalendarError} 잘못된 입력 */
    async create(input = {}) {
      const event = buildEvent(input);
      await mutate((events) => { events.push(event); return { value: event }; });
      return event;
    },

    /** 시리즈 전체에 적용된다. 발생분 id 는 마스터 id 로 정규화. @returns {Promise<object|null>} */
    async update(id, patch = {}) {
      const masterId = toMasterId(id);
      return mutate((events) => {
        const idx = events.findIndex((e) => e.id === masterId);
        if (idx === -1) return { write: false, value: null };
        const next = buildEvent(patch, events[idx]);
        events[idx] = next;
        return { value: next };
      });
    },

    /** 시리즈 전체 삭제. @returns {Promise<boolean>} */
    async remove(id) {
      const masterId = toMasterId(id);
      return mutate((events) => {
        const idx = events.findIndex((e) => e.id === masterId);
        if (idx === -1) return { write: false, value: false };
        events.splice(idx, 1);
        return { value: true };
      });
    },

    /**
     * 반복 일정에서 한 회차만 뺀다 — 마스터의 exdates 에 그 날짜를 추가.
     * @param {string} occurrenceId `cal_xxxx@YYYY-MM-DD`
     * @returns {Promise<object|null>} 갱신된 마스터. 대상이 없으면 null.
     */
    async excludeOccurrence(occurrenceId) {
      const parsed = parseOccurrenceId(occurrenceId);
      if (!parsed) return null;
      return mutate((events) => {
        const idx = events.findIndex((e) => e.id === parsed.masterId);
        if (idx === -1) return { write: false, value: null };
        const exdates = normalizeExdates([...(events[idx].exdates ?? []), parsed.date]);
        const next = { ...events[idx], exdates, updatedAt: new Date().toISOString() };
        events[idx] = next;
        return { value: next };
      });
    },
  };
}

/** 주입기(message-sender)용 동기 조회 — 기본 파일에서 다가오는 일정만 읽는다. */
export function readUpcomingSync({ days = 7, limit = 8, now = Date.now(), filePath = CALENDAR_FILE } = {}) {
  try {
    return createCalendarStore(filePath).upcoming({ days, now, limit });
  } catch (err) {
    logger.warn({ err: err.message }, 'calendar: upcoming read failed');
    return [];
  }
}
