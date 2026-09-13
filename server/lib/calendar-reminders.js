/**
 * 캘린더 알림 — 60초마다 앞으로 며칠치 발생분을 전개해서, 이번 tick 구간에
 * 들어온 `remindMinutes` 만 웹푸시로 보낸다.
 *
 * 중복 방지가 이 모듈의 핵심이다. 서버가 재시작해도 같은 알림이 두 번 가면
 * 안 되므로 발송 키를 data/user/calendar-fired.json 에 남기고, 보내기 *전에*
 * 먼저 기록한다 — 전송 실패로 한 번 놓치는 쪽이 같은 알림을 두 번 보내는
 * 쪽보다 낫다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { DAY_MS, formatEventWhen, formatKstDate, toEpoch } from './calendar-time.js';

const MINUTE_MS = 60 * 1000;
/** 종일 일정의 기준 시각 — 그날 09:00 KST. */
export const ALL_DAY_HOUR = 9;
const FIRED_TTL_MS = 7 * DAY_MS;

/** 이 발생분의 알림 기준 시각(epoch). 종일이면 그날 09:00 KST. */
export function reminderBaseEpoch(event) {
  const start = toEpoch(event.start);
  if (start == null) return null;
  return event.allDay === true ? start + ALL_DAY_HOUR * 60 * MINUTE_MS : start;
}

/** `minutes` 분 전 알림이 울려야 할 시각(epoch). */
export function reminderFireAt(event, minutes) {
  const base = reminderBaseEpoch(event);
  return base == null ? null : base - Number(minutes) * MINUTE_MS;
}

/** 발송 키 — 마스터 id + 발생일 + 오프셋. 반복 일정의 회차마다 따로 센다. */
export function reminderKey(event, minutes) {
  const start = toEpoch(event.start);
  const date = start == null ? 'na' : formatKstDate(start);
  return `${event.masterId ?? event.id}@${date}#${minutes}`;
}

export function offsetLabel(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '지금';
  if (m < 60) return `${m}분 후`;
  if (m % 1440 === 0) return `${m / 1440}일 후`;
  if (m % 60 === 0) return `${m / 60}시간 후`;
  return `${m}분 후`;
}

/** 본문: '9/20(토) 14:00 · 회의실 A' — 장소가 없으면 메모 첫 줄. */
function reminderBody(event) {
  const when = formatEventWhen(event) ?? String(event.start ?? '');
  const detail = String(event.location || '').trim()
    || String(event.notes || '').split('\n').map((s) => s.trim()).find(Boolean)
    || '';
  return detail ? `${when} · ${detail.slice(0, 120)}` : when;
}

/**
 * @param {object} opts
 * @param {object} opts.calendarStore
 * @param {object} [opts.pushStore]        sendPushToAll 제공자. 없으면 eventBus 만 쏜다.
 * @param {object} [opts.eventBus]
 * @param {string} opts.filePath           발송 기록 (data/user/calendar-fired.json)
 * @param {number} [opts.intervalMs]       tick 주기 (기본 60s)
 * @param {number} [opts.lookaheadDays]    전개할 앞날 (기본 2일)
 * @param {() => number} [opts.now]        테스트용 시계
 */
export function createCalendarReminders({
  calendarStore,
  pushStore = null,
  eventBus = null,
  filePath,
  intervalMs = 60 * 1000,
  lookaheadDays = 2,
  now = () => Date.now(),
}) {
  /** @type {Map<string, number>} 발송 키 → epoch */
  const fired = new Map();
  let lastTick = null;
  let timer = null;

  function load() {
    try {
      if (!filePath || !fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const entry of parsed?.fired ?? []) {
        if (entry?.key) fired.set(entry.key, Number(entry.ts) || 0);
      }
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'calendar-reminders: state read failed');
    }
  }

  function save() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const entries = [...fired].map(([key, ts]) => ({ key, ts }));
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, fired: entries }, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'calendar-reminders: state write failed');
    }
  }

  function prune(nowMs) {
    for (const [key, ts] of fired) {
      if (nowMs - ts > FIRED_TTL_MS) fired.delete(key);
    }
  }

  load();

  /** (since, nowMs] 안에 알림 시각이 들어온 발생분을 모은다. */
  function collectDue(since, nowMs) {
    const due = [];
    for (const event of calendarStore.upcoming({ days: lookaheadDays, now: since })) {
      const minutes = Array.isArray(event.remindMinutes) ? event.remindMinutes : [];
      if (minutes.length === 0) continue;
      for (const m of minutes) {
        const fireAt = reminderFireAt(event, m);
        if (fireAt == null || fireAt <= since || fireAt > nowMs) continue;
        const key = reminderKey(event, m);
        if (fired.has(key)) continue;
        due.push({ event, minutes: m, fireAt, key });
      }
    }
    return due;
  }

  async function runOnce(nowMs = now()) {
    const since = lastTick ?? nowMs - intervalMs;
    lastTick = nowMs;

    let due;
    try {
      due = collectDue(since, nowMs);
    } catch (err) {
      logger.warn({ err: err.message }, 'calendar-reminders: expand failed');
      return { sent: 0, due: 0 };
    }
    if (due.length === 0) return { sent: 0, due: 0 };

    // 보내기 전에 먼저 표시해야 재시작/재진입에서 중복이 안 난다.
    for (const item of due) fired.set(item.key, nowMs);
    prune(nowMs);
    save();

    const results = await Promise.allSettled(due.map(async (item) => {
      const title = `📅 ${offsetLabel(item.minutes)} · ${item.event.title}`;
      const body = reminderBody(item.event);
      eventBus?.publish('calendar.reminder', {
        event: item.event, minutes: item.minutes, fireAt: new Date(item.fireAt).toISOString(),
      });
      await pushStore?.sendPushToAll?.(title, body, { skipIdleCheck: true, url: '/calendar' });
    }));

    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) logger.warn({ err: f.reason?.message }, 'calendar-reminders: send failed');
    logger.info({ due: due.length, failed: failed.length }, 'calendar-reminders: fired');
    return { sent: due.length - failed.length, due: due.length };
  }

  return {
    runOnce,
    /** 테스트/디버깅용 — 지금까지 보낸 키. */
    firedKeys: () => [...fired.keys()],

    start() {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err) => logger.error({ err }, 'calendar-reminders: tick failed'));
      }, intervalMs);
      timer.unref?.();
      logger.info({ intervalMs, lookaheadDays }, 'calendar-reminders: started');
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
