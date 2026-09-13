/**
 * Calendar Store — 팀 공용 캘린더 (data/user/calendar.json).
 *
 * 웹 UI(사용자)와 모든 세션(에이전트)이 같은 파일을 동시에 건드리므로,
 * 쓰기는 deploy-log-store 와 동일하게 lockfile + atomic rename 으로 직렬화한다.
 *
 * 시간대 기준은 KST(+09:00). 시각 있는 일정은 `YYYY-MM-DDTHH:mm:ss+09:00` 로
 * 정규화해 저장하고, 종일 일정은 `YYYY-MM-DD` 로 저장한다.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const CALENDAR_FILE = path.join(REPO_ROOT, 'data', 'user', 'calendar.json');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export const MAX_UPCOMING_DAYS = 90;

class CalendarError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID';
  }
}

const invalid = (msg) => { throw new CalendarError(msg); };

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

const pad = (n) => String(n).padStart(2, '0');

/** epoch → 'YYYY-MM-DDTHH:mm:ss+09:00' */
function formatKst(epoch) {
  const d = new Date(epoch + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`;
}

/** epoch → 'YYYY-MM-DD' (KST 기준) */
function formatKstDate(epoch) {
  const d = new Date(epoch + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

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

/** 이벤트의 시작/끝 epoch. end 가 없으면 종일 일정은 그날 끝, 시각 일정은 시작과 동일. */
export function eventRange(event) {
  const start = toEpoch(event.start, { endOfDay: false });
  const rawEnd = event.end
    ? toEpoch(event.end, { endOfDay: event.allDay === true })
    : (event.allDay === true ? toEpoch(event.start, { endOfDay: true }) : start);
  return { start, end: rawEnd == null ? start : Math.max(start ?? 0, rawEnd) };
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

  return {
    filePath,

    /** 전체 이벤트 (start 오름차순). */
    all() {
      return readFileSync(filePath).events.slice().sort(byStart);
    },

    /**
     * 범위 조회. from/to 는 'YYYY-MM-DD' 또는 ISO. 생략 시 제한 없음.
     * 시작~끝이 [from, to] 와 겹치면 포함한다.
     */
    list({ from, to } = {}) {
      const fromEpoch = from ? toEpoch(from) : null;
      const toEpochVal = to ? toEpoch(to, { endOfDay: true }) : null;
      return this.all().filter((ev) => {
        const r = eventRange(ev);
        if (r.start == null) return false;
        if (fromEpoch != null && r.end < fromEpoch) return false;
        if (toEpochVal != null && r.start > toEpochVal) return false;
        return true;
      });
    },

    /** 지금부터 N일(기본 7, 최대 90) 내 일정. 진행 중인 일정도 포함. */
    upcoming({ days = 7, now = Date.now(), limit = null } = {}) {
      const n = Number(days);
      const span = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), MAX_UPCOMING_DAYS) : 7;
      const cutoff = now + span * DAY_MS;
      const found = this.all().filter((ev) => {
        const r = eventRange(ev);
        if (r.start == null) return false;
        return r.end >= now && r.start <= cutoff;
      });
      return limit ? found.slice(0, limit) : found;
    },

    get(id) {
      return readFileSync(filePath).events.find((e) => e.id === id) ?? null;
    },

    /** @throws {CalendarError} 잘못된 입력 */
    async create(input = {}) {
      const event = buildEvent(input);
      await mutate((events) => { events.push(event); return { value: event }; });
      return event;
    },

    /** @returns {Promise<object|null>} 없으면 null */
    async update(id, patch = {}) {
      return mutate((events) => {
        const idx = events.findIndex((e) => e.id === id);
        if (idx === -1) return { write: false, value: null };
        const next = buildEvent(patch, events[idx]);
        events[idx] = next;
        return { value: next };
      });
    },

    /** @returns {Promise<boolean>} 삭제 여부 */
    async remove(id) {
      return mutate((events) => {
        const idx = events.findIndex((e) => e.id === id);
        if (idx === -1) return { write: false, value: false };
        events.splice(idx, 1);
        return { value: true };
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

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** '9/20(토) 14:00 제목' / 종일이면 '9/20(토) 종일 제목' */
export function formatEventLine(event) {
  const epoch = toEpoch(event.start);
  if (epoch == null) return event.title;
  const d = new Date(epoch + KST_OFFSET_MS);
  const head = `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
  const when = event.allDay ? '종일' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${head} ${when} ${event.title}`;
}
